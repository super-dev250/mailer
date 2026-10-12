// Finds the email, display name and message permalink of real, reachable people (only
// well-known webmail providers: Gmail, Outlook, Yahoo and the like — not corporate,
// institutional or bot addresses) who have posted their address in a Slack search result, then
// exports the results as CSV or adds them to the contact list, never twice.
//
// Unlike the GitHub contacts page, Slack has no history to crawl on its own: a search query is
// required. Progress for the current query (what has been found, and which page to resume from)
// is saved as it goes, both in a module-level singleton — so switching to another page and back
// does not lose it — and in localStorage, so Stop followed by Start later resumes instead of
// starting over from page one every time.

import { computed, reactive, ref } from '/vendor/vue.js';
import { api } from '../api.js';
import { count, plural } from '../format.js';
import { problem, store, toast } from '../store.js';

// Slack's search API has a documented Tier 2/3 rate limit, tighter in practice for some
// workspaces. Rather than guess one fixed gap, this adapts: every time Slack rate-limits a
// request, the gap used between requests grows; a run of clean requests eases it back down.
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 30_000;
let extraDelay = 0; // added on top of BASE_DELAY_MS, grows on a 429 and decays on success
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STORAGE_KEY = 'mailer.slackScraper.progress';
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
    if (state.query && !state.done) {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ query: state.query, page: state.page, rows: state.rows, seen: state.seen, skipped: state.skipped, totalFound: state.totalFound }),
      );
    } else {
      localStorage.removeItem(STORAGE_KEY); // finished, or never started: nothing to resume
    }
  } catch {
    // Not persisted. Progress still survives navigating within the app for this browser tab.
  }
}

const state = reactive({
  query: '',
  page: 0,
  rows: [],
  seen: [], // every email encountered so far, kept or not, so a resumed search never redoes work
  running: false,
  done: false, // the last page for this query has been reached
  totalFound: 0,
  skipped: 0, // matches left out because they are already a contact
  waitingFor: 0, // seconds left in a Slack-imposed pause, or 0
  stopRequested: false,
});
Object.assign(state, loadProgress() ?? {});

// One page, waiting out the backoff Slack itself asks for whenever it rate-limits us and trying
// again, for as long as it takes: giving up after a handful of tries would just lose a long run
// over a temporary limit that always lifts.
async function fetchPage(query, page) {
  for (;;) {
    try {
      return await api.post('/api/slack/search', { query, page });
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

async function pace() {
  await sleep(BASE_DELAY_MS + extraDelay);
  // A clean request: ease back toward the base pace instead of staying maximally cautious forever.
  extraDelay = Math.max(0, extraDelay - 500);
}

async function run(query) {
  if (state.running) return;
  const trimmed = query.trim();
  if (!trimmed) return problem(new Error('Enter a search query.'));
  extraDelay = 0;
  // A different query, or starting over after finishing: begin from page one.
  // Otherwise pick up exactly where the last run left off.
  if (state.query !== trimmed || state.done) {
    state.query = trimmed;
    state.page = 0;
    state.rows = [];
    state.seen = [];
    state.totalFound = 0;
    state.skipped = 0;
  }
  state.done = false;
  state.stopRequested = false;
  state.running = true;
  const seen = new Set(state.seen);
  try {
    for (;;) {
      state.page++;
      const data = await fetchPage(state.query, state.page);
      if (state.page === 1) state.totalFound = data.total;
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
      state.seen = [...seen];
      saveProgress();
      if (!data.has_more || state.stopRequested) {
        state.done = !state.stopRequested;
        break;
      }
      await pace();
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
function startOver(query) {
  state.query = '';
  state.page = 0;
  state.done = false;
  run(query);
}

function toCsv(rows) {
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [['Name', 'Email', 'User ID', 'URL'], ...rows.map((row) => [row.name, row.email, row.user_id, row.url])];
  return lines.map((line) => line.map(escape).join(',')).join('\r\n');
}

function exportCsv() {
  const blob = new Blob([toCsv(state.rows)], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'slack-contacts.csv';
  link.click();
  URL.revokeObjectURL(link.href);
}

export const SlackScraperView = {
  setup() {
    const queryInput = ref(state.query);

    // ---- Filtering and removing individual results, before export or import ----
    const filter = ref('');
    const filteredRows = computed(() => {
      const q = filter.value.trim().toLowerCase();
      if (!q) return state.rows;
      return state.rows.filter((row) => row.name.toLowerCase().includes(q) || row.email.toLowerCase().includes(q));
    });
    function removeRow(email) {
      const index = state.rows.findIndex((row) => row.email === email);
      if (index >= 0) state.rows.splice(index, 1);
    }

    // ---- Add to contacts, same rule as everywhere else: nobody is added twice ----
    const dialog = reactive({ open: false, listName: 'Slack', busy: false, result: null });

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
          .map((row) => ({ email: row.email, name: row.name, fields: { user_id: row.user_id, url: row.url } }));
        const totals = { added: 0, existing: existing.size, invalid: 0 };
        for (let start = 0; start < fresh.length; start += 500) {
          const chunk = await api.post('/api/contacts/import', { list: dialog.listName.trim() || 'Slack', rows: fresh.slice(start, start + 500) });
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

    return {
      store,
      state,
      queryInput,
      run: () => run(queryInput.value),
      stop,
      startOver: () => startOver(queryInput.value),
      exportCsv,
      filter,
      filteredRows,
      removeRow,
      dialog,
      openAdd,
      addToContacts,
      count,
      plural,
    };
  },
  template: `
    <div class="page-head">
      <h1>Slack contacts</h1>
      <span class="muted" v-if="state.rows.length">{{ plural(state.rows.length, 'contact') }} found</span>
      <div class="actions">
        <button type="button" class="btn" :disabled="!state.rows.length || state.running" @click="exportCsv"><Icon name="download" /> Export CSV</button>
        <button type="button" class="btn primary" :disabled="!state.rows.length" @click="openAdd"><Icon name="plus" /> Add to contacts</button>
      </div>
    </div>

    <div v-if="!store.overview.slack.can_scrape" class="card empty">
      <h2>Not set up yet</h2>
      <p>Finding Slack contacts needs the optional <code>SLACK_API_TOKEN</code> secret. See the README.</p>
    </div>
    <template v-else>
      <div class="card pad">
        <div style="display: flex; align-items: center; gap: 16px">
          <div class="field" style="flex: 1; margin: 0">
            <label for="slack-query">Search query</label>
            <input id="slack-query" type="text" v-model="queryInput" placeholder="e.g. gmail.com OR outlook.com" :disabled="state.running">
          </div>
          <button v-if="!state.running" type="button" class="btn primary" @click="run"><Icon name="search" /> {{ state.page && !state.done ? 'Resume' : 'Start' }}</button>
          <button v-else type="button" class="btn danger" @click="stop"><Icon name="pause" /> Stop</button>
        </div>
        <p class="muted" style="margin-bottom: 0">
          Searches Slack messages for the query above and collects any email addresses posted in them — only real, reachable addresses from well-known providers like Gmail, Outlook and Yahoo — skipping anyone already in your contacts. Keeps running while you visit other pages. Stop and Start again picks up right where it left off, as long as the query is unchanged.
        </p>
        <p v-if="!state.running && state.page && !state.done" style="margin-bottom: 0">
          <button type="button" class="btn compact ghost" @click="startOver">Start over from page one instead</button>
        </p>
        <p v-if="state.waitingFor" class="muted">Slack asked us to slow down. Waiting {{ state.waitingFor }}s before trying again… {{ plural(state.rows.length, 'contact') }} found so far.</p>
        <p v-else-if="state.running" class="muted">
          Searching… {{ plural(state.rows.length, 'contact') }} found so far{{ state.totalFound ? ' of up to ' + count(state.totalFound) + ' messages seen' : '' }}{{ state.skipped ? ' · ' + plural(state.skipped, 'address', 'addresses') + ' already in your contacts, left out' : '' }}.
        </p>
        <p v-else-if="state.done" class="notice"><Icon name="check" /><span>Went through every matching message. {{ plural(state.rows.length, 'contact') }} found{{ state.skipped ? ' · ' + plural(state.skipped, 'address', 'addresses') + ' already in your contacts, left out' : '' }}.</span></p>
        <p v-else-if="state.rows.length && state.skipped" class="muted">{{ plural(state.skipped, 'address', 'addresses') }} already in your contacts were left out.</p>
      </div>

      <div v-if="state.rows.length" class="card">
        <div class="card-head">
          <input type="search" v-model="filter" placeholder="Filter by name or email" aria-label="Filter results" style="width: 260px">
          <span class="muted" v-if="filter.trim()">{{ plural(filteredRows.length, 'match', 'matches') }}</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Message</th><th class="narrow"></th></tr></thead>
            <tbody>
              <tr v-for="row in filteredRows" :key="row.email">
                <td>{{ row.name }}</td>
                <td class="cell-title">{{ row.email }}</td>
                <td><a v-if="row.url" :href="row.url" target="_blank" rel="noopener">Open in Slack</a></td>
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
          <label for="slack-list">List</label>
          <input id="slack-list" type="text" v-model="dialog.listName" maxlength="100">
        </div>
      </template>
      <template v-else>
        <div class="notice"><Icon name="check" /><span><b>{{ plural(dialog.result.added, 'contact') }} added</b> to "{{ dialog.listName.trim() || 'Slack' }}".</span></div>
        <p v-if="dialog.result.existing" class="muted">{{ plural(dialog.result.existing, 'address', 'addresses') }} already existed and were left as they are.</p>
      </template>
      <template #foot>
        <button type="button" class="btn" @click="dialog.open = false">{{ dialog.result ? 'Done' : 'Cancel' }}</button>
        <button v-if="!dialog.result" type="button" class="btn primary" :disabled="dialog.busy" @click="addToContacts">Add contacts</button>
      </template>
    </Modal>`,
};
