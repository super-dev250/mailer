import { computed, reactive, ref } from '/vendor/vue.js';
import { DEFAULT_RUN_EVERY_MINUTES } from '/shared/pace.js';
import { api, refreshOverview } from '../api.js';
import { problem, store, toast } from '../store.js';

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

    const github = computed(() => store.overview.github);
    const workflowUrl = computed(() => `https://github.com/${github.value.repo}/actions/workflows/mailer.yml`);
    const mailboxes = computed(() => store.overview.mailboxes);
    const failing = computed(() => mailboxes.value.filter((mailbox) => mailbox.last_run?.error));

    return { form, busy, save, github, workflowUrl, mailboxes, failing, store, DEFAULT_RUN_EVERY_MINUTES };
  },
  template: `
    <div class="page-head">
      <h1>Settings</h1>
      <div class="actions">
        <button type="button" class="btn primary" :disabled="busy" @click="save">Save settings</button>
      </div>
    </div>

    <div class="stack" style="max-width: 720px">
      <div class="notice">
        <Icon name="info" />
        <span>Sender name and sending pace moved to <a href="#/mailboxes">Mailboxes</a> — one per Gmail account, so adding a second account never affects the first.</span>
      </div>

      <div class="card pad stack">
        <h2>Email footer</h2>
        <label class="check">
          <input type="checkbox" v-model="form.footer">
          <span>
            <b>Add a footer to every email</b><br>
            <span class="muted">Off: the email ends with your message, like a personal email. On: a small footer with your postal address and an unsubscribe link, which US marketing rules (CAN-SPAM) ask for.</span>
          </span>
        </label>
        <template v-if="form.footer">
          <div class="field">
            <label for="postal-address">Postal address</label>
            <textarea id="postal-address" v-model="form.postal_address" rows="2" maxlength="300" placeholder="1 Depot Way, Austin, TX 78701"></textarea>
          </div>
          <div class="field">
            <label for="unsubscribe-text">Unsubscribe link text</label>
            <input id="unsubscribe-text" type="text" v-model="form.unsubscribe_text" maxlength="100">
            <span class="hint">People who use the link are never emailed again.</span>
          </div>
        </template>
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
        <div class="field" style="max-width: 320px">
          <div class="row">
            <label for="run-every">Minutes between runs</label>
            <span class="spacer"></span>
            <button type="button" class="btn compact" @click="form.run_every_minutes = DEFAULT_RUN_EVERY_MINUTES">Use safe default</button>
          </div>
          <input id="run-every" type="number" v-model.number="form.run_every_minutes" min="5" max="1440" step="5">
          <span class="hint">
            Applies to every mailbox. "Use safe default" sets {{ DEFAULT_RUN_EVERY_MINUTES }} (once an hour) — frequent enough to check for replies promptly, without hammering the GitHub Actions free tier. Needs the optional DISPATCH_TOKEN secret to take effect reliably — see below.
          </span>
        </div>
        <p v-if="mailboxes.length" class="muted">
          {{ mailboxes.length }} mailbox{{ mailboxes.length === 1 ? '' : 'es' }} configured. Pace and run history are on the <a href="#/mailboxes">Mailboxes</a> page.
        </p>
        <p v-else class="muted">The Mailer workflow has not reported here yet. It runs once the GitHub secrets are in place.</p>
        <div v-for="mailbox in failing" :key="mailbox.id" class="notice problem">
          <Icon name="alert" /> <span><b>{{ mailbox.name }}:</b> {{ mailbox.last_run.error }}</span>
        </div>
        <p v-if="!github.can_dispatch" class="muted">
          Without the optional DISPATCH_TOKEN secret, sending only happens when GitHub's own schedule in the workflow fires — which GitHub documents as best-effort and can silently stop working — or when you run it by hand on GitHub. Add DISPATCH_TOKEN (see the README) so this app reliably starts a run itself, on the "Minutes between runs" interval above, through Cloudflare's own scheduler instead.
        </p>
        <div v-if="github.repo" class="row">
          <a class="btn" :href="workflowUrl" target="_blank" rel="noopener">Open the workflow on GitHub <Icon name="external" /></a>
        </div>
      </div>
    </div>`,
};
