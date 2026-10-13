// A started campaign: how far every email got.

import { computed, onBeforeUnmount, onMounted, ref, watch } from '/vendor/vue.js';
import { renderEmail } from '/shared/email.js';
import { api } from '../api.js';
import { CAMPAIGN_STATUS, STAGES, audienceName, count, percent, plural, stageOf, when } from '../format.js';
import { ask, go, problem, store, toast } from '../store.js';

const PAGE_SIZE = 50;
const REFRESH_EVERY = 30_000;
const FUNNEL = ['sent', 'delivered', 'opened', 'clicked', 'replied'];
// `stat` is the count shown on the chip, `key` the filter sent to the server.
const FILTERS = [
  { key: '', label: 'All', stat: 'total' },
  { key: 'pending', label: 'Queued', stat: 'pending' },
  { key: 'sent', label: 'Sent', stat: 'sent' },
  { key: 'delivered', label: 'Delivered', stat: 'delivered' },
  { key: 'opened', label: 'Opened', stat: 'opened' },
  { key: 'clicked', label: 'Clicked', stat: 'clicked' },
  { key: 'replied', label: 'Replied', stat: 'replied' },
  { key: 'bounced', label: 'Bounced', stat: 'bounced' },
  { key: 'failed', label: 'Not sent', stat: 'failed' },
  { key: 'unsubscribed', label: 'Unsubscribed', stat: 'unsubscribed' },
];
const CSV_COLUMNS = [
  'email', 'name', 'status', 'sent_at', 'delivered_at', 'opened_at', 'open_count', 'clicked_at', 'click_count',
  'replied_at', 'reply_snippet', 'bounced_at', 'unsubscribed_at', 'error',
];

// Replies are text written by strangers: a leading = + - or @ would run as a formula in a spreadsheet.
function csvCell(value) {
  const text = String(value ?? '');
  return `"${(/^[=+\-@]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
}

export const CampaignReport = {
  props: { campaign: Object, attachments: Array, stats: Object },
  emits: ['changed', 'edit'],
  setup(props, { emit }) {
    const id = props.campaign.id;
    const filter = ref('');
    const search = ref('');
    const offset = ref(0);
    const rows = ref([]);
    const total = ref(0);
    const busy = ref(false);

    async function loadRows() {
      const query = new URLSearchParams({ offset: offset.value, limit: PAGE_SIZE });
      if (filter.value) query.set('stage', filter.value);
      if (search.value.trim()) query.set('q', search.value.trim());
      const data = await api.get(`/api/campaigns/${id}/messages?${query}`);
      rows.value = data.rows;
      total.value = data.total;
    }
    const reload = () => loadRows().catch(problem);

    // Which link (not just that some link) was clicked, for campaigns that have more than one.
    const linkStats = ref([]);
    async function loadLinks() {
      if (!props.campaign.links.length) return;
      const data = await api.get(`/api/campaigns/${id}/links`);
      linkStats.value = data.links.slice().sort((a, b) => b.clicks - a.clicks);
    }
    onMounted(() => loadLinks().catch(problem));
    const fromStart = () => (offset.value === 0 ? reload() : (offset.value = 0));
    let searchTimer;
    watch(filter, fromStart);
    watch(search, () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(fromStart, 300);
    });
    watch(offset, reload);
    onMounted(reload);

    function refresh() {
      emit('changed');
      reload();
      loadLinks().catch(problem);
    }
    // While emails are going out, keep the numbers current. Hidden tabs do not ask.
    const refreshTimer = setInterval(() => {
      if (props.campaign.status === 'sending' && !document.hidden) refresh();
    }, REFRESH_EVERY);
    onBeforeUnmount(() => {
      clearInterval(refreshTimer);
      clearTimeout(searchTimer);
    });

    const tiles = computed(() => {
      const stats = props.stats;
      return FUNNEL.map((key) => {
        const whole = key === 'sent' ? stats.total : stats.sent;
        const ratio = whole ? stats[key] / whole : 0;
        let note = stats.sent ? `${percent(stats[key], stats.sent)} of sent` : '';
        if (key === 'sent') note = stats.pending ? `${count(stats.pending)} still queued` : `of ${plural(stats.total, 'recipient')}`;
        return {
          key,
          label: STAGES[key].label,
          dot: STAGES[key].dot,
          value: stats[key],
          note,
          width: `${ratio ? Math.max(2, ratio * 100) : 0}%`,
          hint: `${count(stats[key])} of ${count(whole)}`,
        };
      });
    });
    // What the funnel numbers mean as rates, not just counts: e.g. 40 opens reads very differently
    // out of 50 delivered than out of 5,000.
    const rateTiles = computed(() => {
      const stats = props.stats;
      const rate = (key, label, part, whole, dot) => {
        const ratio = whole ? part / whole : 0;
        return { key, label, dot, value: whole ? percent(part, whole) : '–', note: `${count(part)} of ${count(whole)}`, width: `${ratio ? Math.max(2, ratio * 100) : 0}%` };
      };
      return [
        rate('delivery', 'Delivery rate', stats.delivered, stats.sent, STAGES.delivered.dot),
        rate('open', 'Open rate', stats.opened, stats.delivered, STAGES.opened.dot),
        rate('click', 'Click rate', stats.clicked, stats.delivered, STAGES.clicked.dot),
        rate('reply', 'Reply rate', stats.replied, stats.delivered, STAGES.replied.dot),
        rate('bounce', 'Bounce rate', stats.bounced, stats.sent, 'var(--critical)'),
        rate('unsub', 'Unsubscribe rate', stats.unsubscribed, stats.sent, 'var(--stage-queued)'),
      ];
    });
    const bounceWarning = computed(() => props.stats.bounced >= 3 && props.stats.bounced / props.stats.sent > 0.05);
    // There is no way to see whether mail landed in spam — nobody can check another person's spam
    // folder. But delivered-with-almost-no-opens, well after sending, is the signature of it: the
    // mailbox accepted the email (so it did not bounce), yet almost nobody is seeing it.
    const openWarning = computed(() => {
      const stats = props.stats;
      if (!store.overview.settings.track_opens || stats.delivered < 10 || !props.campaign.started_at) return false;
      const hoursSinceStart = (Date.now() - new Date(props.campaign.started_at).getTime()) / 3_600_000;
      return hoursSinceStart >= 24 && stats.opened / stats.delivered < 0.05;
    });

    // The email is shown filled in for one real contact from the audience.
    const email = ref(null);
    async function viewEmail() {
      const query = props.campaign.list ? `&list=${encodeURIComponent(props.campaign.list)}` : '';
      const { rows: found } = await api.get(`/api/contacts?limit=1${query}`);
      const contact = found[0] ?? { email: 'driver@example.com', name: 'Alex Driver', fields: {} };
      const mailbox = store.overview.mailboxes.find((item) => item.id === props.campaign.mailbox_id);
      email.value = {
        to: contact.name || contact.email,
        html: renderEmail({
          campaign: props.campaign,
          contact,
          settings: { ...store.overview.settings, sender_name: mailbox?.sender_name ?? '' },
        }).html,
      };
    }

    const act = (work) => async () => {
      busy.value = true;
      await work().catch(problem);
      busy.value = false;
    };
    const pause = act(async () => {
      await api.post(`/api/campaigns/${id}/pause`);
      emit('changed');
    });
    const resume = act(async () => {
      const { started } = await api.post(`/api/campaigns/${id}/resume`);
      toast(started ? 'Resumed. A run is starting now.' : 'Resumed. Sending continues with the next hourly run.');
      emit('changed');
    });
    const duplicate = act(async () => {
      const copy = await api.post('/api/campaigns', { copy_of: id });
      go(`/campaigns/${copy.id}`);
    });
    const remove = act(async () => {
      const sure = await ask({
        title: 'Delete this campaign?',
        text: 'The campaign and all of its results are removed for good. Links in emails that were already sent stop working.',
        action: 'Delete campaign',
        danger: true,
      });
      if (!sure) return;
      await api.del(`/api/campaigns/${id}`);
      go('/campaigns');
    });
    const exportCsv = act(async () => {
      const lines = [CSV_COLUMNS.join(',')];
      for (let start = 0; ; start += 500) {
        const page = await api.get(`/api/campaigns/${id}/messages?limit=500&offset=${start}`);
        for (const row of page.rows) {
          const value = (column) => (column === 'status' ? STAGES[stageOf(row)].label : row[column]);
          lines.push(CSV_COLUMNS.map((column) => csvCell(value(column))).join(','));
        }
        if (start + 500 >= page.total) break;
      }
      // The leading mark makes Excel read the file as UTF-8.
      const url = URL.createObjectURL(new Blob(['\uFEFF', lines.join('\r\n')], { type: 'text/csv' }));
      Object.assign(document.createElement('a'), { href: url, download: `${props.campaign.name}.csv` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    const badge = (row) => STAGES[stageOf(row)];
    const detail = (row) => row.reply_snippet || (row.status === 'sent' ? '' : row.error) || '';
    const mailboxName = computed(
      () => store.overview.mailboxes.find((item) => item.id === props.campaign.mailbox_id)?.name ?? '',
    );

    return {
      FILTERS, PAGE_SIZE, CAMPAIGN_STATUS, filter, search, offset, rows, total, busy, tiles, rateTiles, linkStats, bounceWarning, openWarning, email, mailboxName,
      refresh, pause, resume, duplicate, remove, exportCsv, badge, detail, audienceName, count, percent, when,
      viewEmail: () => viewEmail().catch(problem),
    };
  },
  template: `
    <a class="back" href="#/campaigns"><Icon name="back" /> Campaigns</a>
    <div class="page-head">
      <h1>{{ campaign.name }}</h1>
      <span class="badge" :style="{ '--dot': CAMPAIGN_STATUS[campaign.status].dot }">{{ CAMPAIGN_STATUS[campaign.status].label }}</span>
      <div class="actions">
        <button type="button" class="btn ghost" title="Refresh" aria-label="Refresh" @click="refresh"><Icon name="refresh" /></button>
        <button type="button" class="btn" @click="viewEmail"><Icon name="eye" /> View email</button>
        <button type="button" class="btn" :disabled="busy" @click="duplicate"><Icon name="copy" /> Duplicate</button>
        <button v-if="campaign.status === 'sending'" type="button" class="btn" :disabled="busy" @click="pause"><Icon name="pause" /> Pause</button>
        <button v-if="campaign.status === 'paused'" type="button" class="btn" :disabled="busy" @click="$emit('edit')"><Icon name="edit" /> Edit content</button>
        <button v-if="campaign.status === 'paused'" type="button" class="btn primary" :disabled="busy" @click="resume"><Icon name="play" /> Resume</button>
        <button type="button" class="btn ghost danger" title="Delete campaign" aria-label="Delete campaign" :disabled="busy" @click="remove"><Icon name="trash" /></button>
      </div>
    </div>

    <div class="stack">
      <p class="muted">“{{ campaign.subject }}” · sent to {{ audienceName(campaign.list) }}<template v-if="mailboxName"> from {{ mailboxName }}</template> · started {{ when(campaign.started_at) }}</p>

      <div v-if="bounceWarning" class="notice problem">
        <Icon name="alert" />
        <span><b>{{ percent(stats.bounced, stats.sent) }} of these emails bounced.</b> A high bounce rate can get a mailbox restricted. Check where this list came from before sending to it again.</span>
      </div>

      <div v-if="openWarning" class="notice">
        <Icon name="info" />
        <span>
          <b>Only {{ percent(stats.opened, stats.delivered) }} of delivered emails have been opened.</b>
          Nobody can see another person's spam folder, but delivered-with-almost-no-opens like this is its usual signature.
          <a href="#/settings">Slow down the sending pace</a>, and double-check this list is people who would recognize and expect this email.
        </span>
      </div>

      <div class="tiles">
        <div v-for="tile in tiles" :key="tile.key" class="tile" :style="{ '--dot': tile.dot }">
          <div class="tile-label">{{ tile.label }}</div>
          <div class="tile-value">{{ count(tile.value) }}</div>
          <div class="tile-note">{{ tile.note }}</div>
          <div class="meter" :title="tile.hint"><i :style="{ width: tile.width }"></i></div>
        </div>
      </div>

      <div class="tiles">
        <div v-for="tile in rateTiles" :key="tile.key" class="tile" :style="{ '--dot': tile.dot }">
          <div class="tile-label">{{ tile.label }}</div>
          <div class="tile-value">{{ tile.value }}</div>
          <div class="tile-note">{{ tile.note }}</div>
          <div class="meter"><i :style="{ width: tile.width }"></i></div>
        </div>
      </div>

      <div v-if="campaign.links.length" class="card pad stack">
        <h2>Links</h2>
        <p v-if="!linkStats.some((link) => link.clicks)" class="muted">No clicks yet.</p>
        <div v-else class="table-wrap">
          <table>
            <thead><tr><th>Link</th><th>Clicks</th><th>Unique clickers</th></tr></thead>
            <tbody>
              <tr v-for="link in linkStats" :key="link.url">
                <td class="cell-title"><a :href="link.url" target="_blank" rel="noopener">{{ link.url }}</a></td>
                <td>{{ count(link.clicks) }}</td>
                <td>{{ count(link.clickers) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="chips">
            <button v-for="item in FILTERS" :key="item.key" type="button" class="chip" :class="{ active: filter === item.key }" @click="filter = item.key">
              {{ item.label }} <b>{{ count(stats[item.stat]) }}</b>
            </button>
          </div>
          <div class="row" style="margin-left: auto">
            <input type="search" v-model="search" placeholder="Search email" aria-label="Search recipients" style="width: 190px">
            <button type="button" class="btn" :disabled="busy" @click="exportCsv"><Icon name="download" /> Export</button>
          </div>
        </div>
        <div v-if="rows.length" class="table-wrap">
          <table>
            <thead>
              <tr><th>Recipient</th><th>Status</th><th>Sent</th><th>Opened</th><th>Clicked</th><th>Reply or problem</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.id">
                <td>
                  <div class="cell-title">{{ row.email }}</div>
                  <div v-if="row.name" class="cell-sub">{{ row.name }}</div>
                </td>
                <td class="nowrap">
                  <span class="badge" :class="{ ring: badge(row).ring }" :style="{ '--dot': badge(row).dot }">{{ badge(row).label }}</span>
                  <span v-if="row.unsubscribed_at" class="tag" style="margin-left: 8px">Unsubscribed</span>
                </td>
                <td class="nowrap muted">{{ when(row.sent_at) }}</td>
                <td class="nowrap">{{ when(row.opened_at) }} <span v-if="row.open_count > 1" class="muted">×{{ row.open_count }}</span></td>
                <td class="nowrap">{{ when(row.clicked_at) }} <span v-if="row.click_count > 1" class="muted">×{{ row.click_count }}</span></td>
                <td class="fill" :title="detail(row)">{{ detail(row) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">No recipients here.</div>
        <Pager v-model:offset="offset" :size="PAGE_SIZE" :total="total" />
      </div>
    </div>

    <Modal v-if="email" title="The email as sent" wide @close="email = null">
      <p class="muted">Shown the way {{ email.to }} received it.<template v-if="attachments.length"> Attached: {{ attachments.map((file) => file.name).join(", ") }}.</template></p>
      <iframe title="Email content" sandbox="allow-same-origin" :srcdoc="email.html" style="width: 100%; height: 56vh; border: 1px solid var(--line); border-radius: 6px"></iframe>
      <template #foot><button type="button" class="btn" @click="email = null">Close</button></template>
    </Modal>`,
};
