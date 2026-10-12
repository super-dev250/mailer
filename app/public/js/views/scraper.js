// Finds the email, name, GitHub login and profile URL of real, reachable people (only well-known
// webmail providers: Gmail, Outlook, Yahoo and the like — not corporate, institutional or bot
// addresses) behind every commit on GitHub, then exports the results as CSV or adds them to the
// contact list, never twice. There is no query to write: under the hood it works through the
// entire commit history a date range at a time, splitting a range further whenever GitHub's
// 1000-results-per-query cap is hit, but that is an implementation detail and never shown.
//
// Progress (what has been found, and what is left to search) is saved as it goes, both in a
// module-level singleton — so switching to another page and back does not lose it — and in
// localStorage, so Stop followed by Start later resumes from where it left off instead of
// starting over from the beginning of GitHub's history every time.

import { computed, reactive, ref } from '/vendor/vue.js';
import { api } from '../api.js';
import { count, plural } from '../format.js';
import { problem, store, toast } from '../store.js';

// GitHub's documented search quota is 30 requests/minute, but commit search enforces a tighter,
// undocumented limit in practice, and there is no way to ask GitHub for its exact value. So rather
// than guess one fixed gap, this adapts: every time GitHub rate-limits a request, the gap used
// between requests grows; a run of clean requests eases it back down. That way a session that is
// actually being refused repeatedly backs off harder, instead of retrying at the same pace that
// just failed.
const BASE_DELAY_MS = 4000;
const MAX_DELAY_MS = 30_000;
let extraDelay = 0; // added on top of BASE_DELAY_MS, grows on a 429 and decays on success
// Well before Git or GitHub existed, so this covers everything. Ranges are whole seconds since
// the epoch, not days: recent history is so dense (easily tens of thousands of commits a day
// across all of GitHub) that day-sized slices routinely still hold more than GitHub's 1000-match
// cap, and a slice that cannot be split further just loses whatever did not fit on the first page.
// Splitting down to the second lets even the busiest moments converge.
const EARLIEST = Math.floor(Date.UTC(1990, 0, 1) / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const nowSeconds = () => Math.floor(Date.now() / 1000);
// GitHub's own docs format date-qualifier timestamps with a "+00:00" offset, not a trailing "Z";
// it does not reliably parse the latter for this qualifier, and silently matches nothing instead
// of raising an error when it fails to.
const iso = (seconds) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');

const STORAGE_KEY = 'mailer.scraper.progress';
function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // private browsing, or storage unavailable: nothing to resume from
  }
}
function saveProgress() {
  try {
    if (state.pendingRanges.length) {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ pendingRanges: state.pendingRanges, rows: state.rows, seen: state.seen, skipped: state.skipped, totalFound: state.totalFound }),
      );
    } else {
      localStorage.removeItem(STORAGE_KEY); // finished: nothing left to resume
    }
  } catch {
    // Not persisted. Progress still survives navigating within the app for this browser tab.
  }
}

const state = reactive({
  rows: [],
  seen: [], // every email encountered so far, kept or not, so a resumed search never redoes work
  pendingRanges: [], // date ranges not yet searched; what Stop leaves behind for Start to resume
  running: false,
  done: false, // the whole history, start to end, has been covered
  totalFound: 0,
  skipped: 0, // matches left out because they are already a contact
  waitingFor: 0, // seconds left in a GitHub-imposed pause, or 0
  stopRequested: false,
});
Object.assign(state, loadProgress() ?? {});

// One page, waiting out the backoff GitHub itself asks for whenever it rate-limits us and trying
// again, for as long as it takes: giving up after a handful of tries would just lose a long run
// over a temporary limit that always lifts.
async function fetchPage(query, page) {
  for (;;) {
    try {
      return await api.post('/api/scraper/search', { query, page });
    } catch (error) {
      if (error.status !== 429 || state.stopRequested) throw error;
      extraDelay = Math.min(MAX_DELAY_MS, (extraDelay || BASE_DELAY_MS) * 2);
      let seconds = Math.round(error.retryAfter) || 60;
      while (seconds > 0 && !state.stopRequested) {
        state.waitingFor = seconds;
        await sleep(1000);
        seconds--;
      }
      state.waitingFor = 0;
    }
  }
}

// Waits before the next request: GitHub reports exactly how much of its quota is left on every
// answer, so once that is nearly gone this waits for it to refill instead of racing into a 429.
async function pace(data) {
  if (data.rate_remaining !== null && data.rate_remaining <= 1 && data.rate_reset) {
    let seconds = Math.max(1, Math.ceil(data.rate_reset - Date.now() / 1000) + 1);
    while (seconds > 0 && !state.stopRequested) {
      state.waitingFor = seconds;
      await sleep(1000);
      seconds--;
    }
    state.waitingFor = 0;
  } else {
    await sleep(BASE_DELAY_MS + extraDelay);
    // A clean request: ease back toward the base pace instead of staying maximally cautious forever.
    extraDelay = Math.max(0, extraDelay - 500);
  }
}

// Collects every page of one query, i.e. one slice of the commit history that GitHub promises
// (or is assumed) to hold at most 1000 matches, so the 1000-result cap never loses anything.
// When a truncated slice can still be split further, this stops after just the first page: the
// caller is about to re-run it as two finer slices anyway, so paging through it now would be
// wasted requests. When it cannot be split any finer, it pages all the way to the 1000-result cap
// instead of settling for the single page it would otherwise have grabbed.
async function collect(query, seen, canSplit) {
  let page = 1;
  for (;;) {
    const data = await fetchPage(query, page);
    if (page === 1 && !data.truncated) state.totalFound += data.total;
    const fresh = data.rows.filter((row) => !seen.has(row.email));
    fresh.forEach((row) => seen.add(row.email));
    if (fresh.length) {
      // Already a contact: left out here, so "found" only ever means "new".
      const answer = await api.post('/api/contacts/existing', { emails: fresh.map((row) => row.email) });
      const existing = new Set(answer.existing);
      for (const row of fresh) {
        if (existing.has(row.email)) state.skipped++;
        else state.rows.push(row);
      }
    }
    if (page === 1 && data.truncated && canSplit) return { truncated: true };
    if (!data.has_more || state.stopRequested) return { truncated: false };
    page++;
    await pace(data);
  }
}

async function run() {
  if (state.running) return;
  extraDelay = 0;
  // Nothing left over from a previous Stop: start from the beginning of GitHub's history.
  // Otherwise pick up exactly where that search left off.
  if (!state.pendingRanges.length) {
    state.rows = [];
    state.seen = [];
    state.totalFound = 0;
    state.skipped = 0;
    state.pendingRanges = [[EARLIEST, nowSeconds()]];
  }
  state.done = false;
  state.stopRequested = false;
  state.running = true;
  const seen = new Set(state.seen);
  const ranges = state.pendingRanges;
  try {
    while (ranges.length && !state.stopRequested) {
      const [from, to] = ranges.shift();
      const canSplit = to > from;
      const query = `author-date:${iso(from)}..${iso(to)}`;
      const { truncated } = await collect(query, seen, canSplit);
      if (truncated && canSplit) {
        // More than 1000 commits even in this slice: split it in half by time and try again.
        const mid = from + Math.floor((to - from) / 2);
        ranges.unshift([mid + 1, to]);
        ranges.unshift([from, mid]);
      }
      state.seen = [...seen];
      saveProgress();
      if (ranges.length && !state.stopRequested) await pace({ rate_remaining: null });
    }
    state.done = ranges.length === 0 && !state.stopRequested;
    if (state.done && state.totalFound === 0) {
      // GitHub reporting zero commits across the whole of history means something went wrong
      // talking to it, not that the search genuinely found nothing.
      problem(new Error('GitHub reported no commits at all, which usually means a problem talking to it rather than an empty result. Check GH_API_TOKEN and try again.'));
    }
  } catch (error) {
    problem(error);
  } finally {
    state.running = false;
    state.waitingFor = 0;
    saveProgress();
  }
}
const stop = () => (state.stopRequested = true);
function startOver() {
  state.pendingRanges = [];
  state.done = false;
  run();
}

function toCsv(rows) {
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [['Name', 'Email', 'Login', 'URL'], ...rows.map((row) => [row.name, row.email, row.login, row.url])];
  return lines.map((line) => line.map(escape).join(',')).join('\r\n');
}

function exportCsv() {
  const blob = new Blob([toCsv(state.rows)], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'github-contacts.csv';
  link.click();
  URL.revokeObjectURL(link.href);
}

export const ScraperView = {
  setup() {
    // ---- Filtering and removing individual results, before export or import ----
    const filter = ref('');
    const filteredRows = computed(() => {
      const q = filter.value.trim().toLowerCase();
      if (!q) return state.rows;
      return state.rows.filter((row) => row.name.toLowerCase().includes(q) || row.email.toLowerCase().includes(q) || row.login.toLowerCase().includes(q));
    });
    function removeRow(email) {
      const index = state.rows.findIndex((row) => row.email === email);
      if (index >= 0) state.rows.splice(index, 1);
    }

    // ---- Add to contacts, same rule as everywhere else: nobody is added twice ----
    const dialog = reactive({ open: false, listName: 'GitHub', busy: false, result: null });

    function openAdd() {
      dialog.result = null;
      dialog.open = true;
    }
    async function addToContacts() {
      dialog.busy = true;
      try {
        const emails = state.rows.map((row) => row.email);
        const existing = new Set();
        for (let start = 0; start < emails.length; start += 1000) {
          const answer = await api.post('/api/contacts/existing', { emails: emails.slice(start, start + 1000) });
          answer.existing.forEach((email) => existing.add(email));
        }
        const fresh = state.rows
          .filter((row) => !existing.has(row.email))
          .map((row) => ({ email: row.email, name: row.name, fields: { login: row.login, url: row.url } }));
        const totals = { added: 0, existing: existing.size, invalid: 0 };
        for (let start = 0; start < fresh.length; start += 500) {
          const chunk = await api.post('/api/contacts/import', { list: dialog.listName.trim() || 'GitHub', rows: fresh.slice(start, start + 500) });
          totals.added += chunk.added;
        }
        dialog.result = totals;
        toast(`${plural(totals.added, 'contact')} added.`);
      } catch (error) {
        problem(error);
      } finally {
        dialog.busy = false;
      }
    }

    return { store, state, run, stop, startOver, exportCsv, filter, filteredRows, removeRow, dialog, openAdd, addToContacts, count, plural };
  },
  template: `
    <div class="page-head">
      <h1>GitHub contacts</h1>
      <span class="muted" v-if="state.rows.length">{{ plural(state.rows.length, 'contact') }} found</span>
      <div class="actions">
        <button type="button" class="btn" :disabled="!state.rows.length || state.running" @click="exportCsv"><Icon name="download" /> Export CSV</button>
        <button type="button" class="btn primary" :disabled="!state.rows.length" @click="openAdd"><Icon name="plus" /> Add to contacts</button>
      </div>
    </div>

    <div v-if="!store.overview.scraper.can_scrape" class="card empty">
      <h2>Not set up yet</h2>
      <p>Finding GitHub contacts needs the optional <code>GH_API_TOKEN</code> secret. See the README.</p>
    </div>
    <template v-else>
      <div class="card pad">
        <div style="display: flex; align-items: center; gap: 16px">
          <p class="muted" style="margin: 0; flex: 1">
            Works through GitHub's entire commit history on its own, collecting the email each commit was made with — only real, reachable addresses from well-known providers like Gmail, Outlook and Yahoo — and skipping anyone already in your contacts. Keeps running while you visit other pages. Stop and Start again picks up right where it left off.
          </p>
          <button v-if="!state.running" type="button" class="btn primary" @click="run"><Icon name="search" /> {{ state.pendingRanges.length && !state.done ? 'Resume' : 'Start' }}</button>
          <button v-else type="button" class="btn danger" @click="stop"><Icon name="pause" /> Stop</button>
        </div>
        <p v-if="!state.running && state.pendingRanges.length && !state.done">
          <button type="button" class="btn compact ghost" @click="startOver">Start over from the beginning instead</button>
        </p>
        <p v-if="state.waitingFor" class="muted">GitHub asked us to slow down. Waiting {{ state.waitingFor }}s before trying again… {{ plural(state.rows.length, 'contact') }} found so far.</p>
        <p v-else-if="state.running" class="muted">
          Searching… {{ plural(state.rows.length, 'contact') }} found so far{{ state.totalFound ? ' of up to ' + count(state.totalFound) + ' commits seen' : '' }}{{ state.skipped ? ' · ' + plural(state.skipped, 'address', 'addresses') + ' already in your contacts, left out' : '' }}.
        </p>
        <p v-else-if="state.done" class="notice"><Icon name="check" /><span>Went through the entire commit history. {{ plural(state.rows.length, 'contact') }} found{{ state.skipped ? ' · ' + plural(state.skipped, 'address', 'addresses') + ' already in your contacts, left out' : '' }}.</span></p>
        <p v-else-if="state.rows.length && state.skipped" class="muted">{{ plural(state.skipped, 'address', 'addresses') }} already in your contacts were left out.</p>
      </div>

      <div v-if="state.rows.length" class="card">
        <div class="card-head">
          <input type="search" v-model="filter" placeholder="Filter by name, email or login" aria-label="Filter results" style="width: 260px">
          <span class="muted" v-if="filter.trim()">{{ plural(filteredRows.length, 'match', 'matches') }}</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Login</th><th>Profile</th><th class="narrow"></th></tr></thead>
            <tbody>
              <tr v-for="row in filteredRows" :key="row.email">
                <td>{{ row.name }}</td>
                <td class="cell-title">{{ row.email }}</td>
                <td>{{ row.login }}</td>
                <td><a v-if="row.url" :href="row.url" target="_blank" rel="noopener">{{ row.url }}</a></td>
                <td class="narrow"><button type="button" class="btn compact ghost danger" :aria-label="'Remove ' + row.email" @click="removeRow(row.email)"><Icon name="trash" /></button></td>
              </tr>
            </tbody>
          </table>
          <div v-if="filter.trim() && !filteredRows.length" class="empty">No results match.</div>
        </div>
      </div>
    </template>

    <Modal v-if="dialog.open" title="Add to contacts" @close="dialog.open = false">
      <template v-if="!dialog.result">
        <p>{{ plural(state.rows.length, 'contact') }} found will be checked against your existing contacts first, so nobody is added twice.</p>
        <div class="field">
          <label for="scraper-list">List</label>
          <input id="scraper-list" type="text" v-model="dialog.listName" maxlength="100">
        </div>
      </template>
      <template v-else>
        <div class="notice"><Icon name="check" /><span><b>{{ plural(dialog.result.added, 'contact') }} added</b> to "{{ dialog.listName.trim() || 'GitHub' }}".</span></div>
        <p v-if="dialog.result.existing" class="muted">{{ plural(dialog.result.existing, 'address', 'addresses') }} already existed and were left as they are.</p>
      </template>
      <template #foot>
        <button type="button" class="btn" @click="dialog.open = false">{{ dialog.result ? 'Done' : 'Cancel' }}</button>
        <button v-if="!dialog.result" type="button" class="btn primary" :disabled="dialog.busy" @click="addToContacts">Add contacts</button>
      </template>
    </Modal>`,
};
