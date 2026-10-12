import { computed, reactive, ref } from '/vendor/vue.js';
import { api, refreshOverview } from '../api.js';
import { ago, count } from '../format.js';
import { problem, signOut, store, toast } from '../store.js';

export const SettingsView = {
  setup() {
    const form = reactive({ ...store.overview.settings });
    const busy = ref(false);

    async function save() {
      busy.value = true;
      try {
        const { settings } = await api.put('/api/settings', form);
        Object.assign(form, settings);
        await refreshOverview();
        toast('Settings saved.');
      } catch (error) {
        problem(error);
      }
      busy.value = false;
    }

    // What the pace settings add up to, in plain numbers.
    const pace = computed(() => {
      const minutes = Math.max(1, Math.round((form.batch_size * form.delay_seconds) / 60));
      const perDay = Math.min(form.daily_limit, form.batch_size * 24);
      return `One run sends up to ${count(form.batch_size)} emails in about ${minutes} min. With hourly runs that is up to ${count(perDay)} emails a day.`;
    });
    const github = computed(() => store.overview.github);
    const workflowUrl = computed(() => `https://github.com/${github.value.repo}/actions/workflows/mailer.yml`);

    return { form, busy, save, pace, github, workflowUrl, store, signOut, ago };
  },
  template: `
    <div class="page-head">
      <h1>Settings</h1>
      <div class="actions">
        <button type="button" class="btn primary" :disabled="busy" @click="save">Save settings</button>
      </div>
    </div>

    <div class="stack" style="max-width: 720px">
      <div class="card pad stack">
        <h2>Sender</h2>
        <div class="field">
          <label for="sender-name">Your name</label>
          <input id="sender-name" type="text" v-model="form.sender_name" maxlength="100" placeholder="Sam Road">
          <span class="hint">
            Shown as the sender.
            <template v-if="store.overview.sender_email">Emails go out from <b>{{ store.overview.sender_email }}</b>, the mailbox set in the GMAIL_USER secret.</template>
          </span>
        </div>
        <div class="field">
          <label for="postal-address">Postal address</label>
          <textarea id="postal-address" v-model="form.postal_address" rows="2" maxlength="300" placeholder="1 Depot Way, Austin, TX 78701"></textarea>
          <span class="hint">Printed in the footer of every email. Marketing email rules such as CAN-SPAM require one.</span>
        </div>
        <div class="field">
          <label for="unsubscribe-text">Unsubscribe link text</label>
          <input id="unsubscribe-text" type="text" v-model="form.unsubscribe_text" maxlength="100">
          <span class="hint">Every email ends with this link. People who use it are never emailed again.</span>
        </div>
      </div>

      <div class="card pad stack">
        <h2>Sending pace</h2>
        <div class="field-row">
          <div class="field">
            <label for="batch-size">Emails per run</label>
            <input id="batch-size" type="number" v-model.number="form.batch_size" min="1" max="500">
          </div>
          <div class="field">
            <label for="delay-seconds">Seconds between emails</label>
            <input id="delay-seconds" type="number" v-model.number="form.delay_seconds" min="1" max="120">
          </div>
          <div class="field">
            <label for="daily-limit">Most emails in 24 hours</label>
            <input id="daily-limit" type="number" v-model.number="form.daily_limit" min="1" max="2000">
          </div>
        </div>
        <p class="muted">{{ pace }} Gmail itself stops a personal account at about 500 a day, and a slow, steady pace is what keeps a mailbox in good standing.</p>
      </div>

      <div class="card pad stack">
        <h2>Tracking</h2>
        <label class="check">
          <input type="checkbox" v-model="form.track_opens">
          <span><b>Opens</b><br><span class="muted">Adds an invisible image. An open is counted when the mail app loads it, so the number is an estimate.</span></span>
        </label>
        <label class="check">
          <input type="checkbox" v-model="form.track_clicks">
          <span><b>Clicks</b><br><span class="muted">Routes links through this app so a click can be counted, then sends the reader on.</span></span>
        </label>
      </div>

      <div class="card pad stack">
        <h2>Automation</h2>
        <p v-if="store.overview.last_run">
          The Mailer workflow last ran {{ ago(store.overview.last_run.at) }}.
          Sent: {{ store.overview.last_run.sent }} · Failed: {{ store.overview.last_run.failed }} ·
          Replies found: {{ store.overview.last_run.replies }} · Bounces found: {{ store.overview.last_run.bounces }}
        </p>
        <p v-else class="muted">The Mailer workflow has not reported here yet. It runs every hour once the GitHub secrets are in place.</p>
        <div v-if="store.overview.last_run && store.overview.last_run.error" class="notice problem">
          <Icon name="alert" /> <span>{{ store.overview.last_run.error }}</span>
        </div>
        <p v-if="!github.can_dispatch" class="muted">
          Sending starts with the next hourly run. To start runs from this app instead of waiting, add the optional DISPATCH_TOKEN secret described in the README.
        </p>
        <div class="row">
          <a v-if="github.repo" class="btn" :href="workflowUrl" target="_blank" rel="noopener">Open the workflow on GitHub <Icon name="external" /></a>
          <span class="spacer"></span>
          <button type="button" class="btn ghost" @click="signOut">Sign out</button>
        </div>
      </div>
    </div>`,
};
