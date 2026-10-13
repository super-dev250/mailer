// The frame around every screen: navigation, and the state of the automation.

import { computed, onMounted, ref, watch } from '/vendor/vue.js';
import { api, refreshOverview } from '../api.js';
import { ago, plural } from '../format.js';
import { problem, signOut, store, toast } from '../store.js';
import { CampaignView } from './campaign.js';
import { CampaignsView } from './campaigns.js';
import { ContactsView } from './contacts.js';
import { MailboxesView } from './mailboxes.js';
import { ScraperView } from './scraper.js';
import { SettingsView } from './settings.js';
import { SlackScraperView } from './slackScraper.js';

const NAV = [
  { view: 'campaigns', label: 'Campaigns', icon: 'send' },
  { view: 'contacts', label: 'Contacts', icon: 'users' },
  { view: 'mailboxes', label: 'Mailboxes', icon: 'mail' },
  { view: 'scraper', label: 'GitHub contacts', icon: 'search' },
  { view: 'slack', label: 'Slack contacts', icon: 'search' },
  { view: 'settings', label: 'Settings', icon: 'settings' },
];

export const Shell = {
  components: { CampaignView, CampaignsView, ContactsView, MailboxesView, ScraperView, SettingsView, SlackScraperView },
  setup() {
    const failure = ref('');
    const load = () =>
      refreshOverview().then(
        () => (failure.value = ''),
        (error) => (failure.value = error.message),
      );
    onMounted(load);
    // Moving between screens is a natural moment to pick up what the last run did.
    watch(() => store.route, load);

    // One mailbox: its own run, as before. Several: the newest run, and whether any of them
    // has a problem — the Mailboxes page has the rest, one card per mailbox.
    const run = computed(() => {
      const mailboxes = store.overview.mailboxes;
      const runs = mailboxes.map((mailbox) => mailbox.last_run).filter(Boolean);
      if (!runs.length) return { title: 'No runs yet', detail: 'Emails go out when the Mailer workflow runs.', dot: 'var(--stage-queued)' };
      const failing = mailboxes.find((mailbox) => mailbox.last_run?.error);
      if (failing) {
        const detail = mailboxes.length > 1 ? `${failing.name}: ${failing.last_run.error}` : failing.last_run.error;
        return { title: 'Last run had a problem', detail, dot: 'var(--critical)' };
      }
      const last = runs.reduce((newest, run) => (run.at > newest.at ? run : newest));
      const parts = [`Sent ${runs.reduce((sum, run) => sum + run.sent, 0)}`];
      const replies = runs.reduce((sum, run) => sum + run.replies, 0);
      const bounces = runs.reduce((sum, run) => sum + run.bounces, 0);
      if (replies) parts.push(plural(replies, 'reply', 'replies'));
      if (bounces) parts.push(plural(bounces, 'bounce'));
      const title = mailboxes.length > 1 ? `${plural(mailboxes.length, 'mailbox')} · last run ${ago(last.at)}` : `Last run ${ago(last.at)}`;
      return { title, detail: parts.join(' · '), dot: 'var(--good)' };
    });
    const workflowUrl = computed(() => `https://github.com/${store.overview.github.repo}/actions/workflows/mailer.yml`);

    async function runNow() {
      await api.post('/api/run');
      toast('The Mailer workflow is starting. Results show up here in a minute or two.');
    }

    return { NAV, store, failure, load, run, workflowUrl, signOut, runNow: () => runNow().catch(problem) };
  },
  template: `
    <div v-if="store.overview" class="shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark"><Icon name="mail" /></span> Mailer</div>
        <a v-for="item in NAV" :key="item.view" class="nav-link" :class="{ active: store.route.view === item.view }" :href="'#/' + item.view">
          <Icon :name="item.icon" /> {{ item.label }}
        </a>
        <div class="run-status">
          <div>
            <span class="badge" :style="{ '--dot': run.dot }">{{ run.title }}</span>
            <div class="run-detail" :title="run.detail">{{ run.detail }}</div>
          </div>
          <button v-if="store.overview.github.can_dispatch" type="button" class="btn compact" @click="runNow"><Icon name="play" /> Run now</button>
          <a v-else-if="store.overview.github.repo" class="btn compact" :href="workflowUrl" target="_blank" rel="noopener">Run on GitHub <Icon name="external" /></a>
        </div>
        <button type="button" class="nav-link" @click="signOut"><Icon name="logout" /> Sign out</button>
      </aside>
      <main class="main">
        <CampaignView v-if="store.route.view === 'campaigns' && store.route.id" :id="store.route.id" :key="store.route.id" />
        <CampaignsView v-else-if="store.route.view === 'campaigns'" />
        <ContactsView v-else-if="store.route.view === 'contacts'" />
        <MailboxesView v-else-if="store.route.view === 'mailboxes'" />
        <ScraperView v-else-if="store.route.view === 'scraper'" />
        <SlackScraperView v-else-if="store.route.view === 'slack'" />
        <SettingsView v-else-if="store.route.view === 'settings'" />
        <div v-else class="empty"><h2>Page not found</h2><a class="btn" href="#/campaigns">Go to campaigns</a></div>
      </main>
    </div>
    <div v-else-if="failure" class="login">
      <div class="card">
        <div class="notice problem"><Icon name="alert" /> <span>{{ failure }}</span></div>
        <button type="button" class="btn" style="justify-content: center" @click="load">Try again</button>
      </div>
    </div>`,
};
