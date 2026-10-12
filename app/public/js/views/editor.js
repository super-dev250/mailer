// Writing a campaign: who it goes to, the subject, the message, and a live preview.

import { computed, onBeforeUnmount, onMounted, reactive, ref, watch, watchEffect } from '/vendor/vue.js';
import { escapeHtml, findTags, renderEmail } from '/shared/email.js';
import { api } from '../api.js';
import { RichEditor } from '../editor.js';
import { count, plural } from '../format.js';
import { ask, go, problem, remember, store, stored, toast } from '../store.js';

const SAMPLE = { email: 'driver@example.com', name: 'Alex Driver', fields: {} };
const BUILT_IN = [
  { label: 'First name', value: '{{first_name|there}}', hint: 'first_name' },
  { label: 'Full name', value: '{{name}}', hint: 'name' },
  { label: 'Email', value: '{{email}}', hint: 'email' },
];
const SAVE_LABELS = { saved: 'All changes saved', dirty: 'Unsaved changes', saving: 'Saving…', failed: 'Could not save' };

export const CampaignEditor = {
  components: { RichEditor },
  props: { campaign: Object },
  emits: ['started'],
  setup(props, { emit }) {
    const id = props.campaign.id;
    const form = reactive({
      name: props.campaign.name,
      list: props.campaign.list,
      subject: props.campaign.subject,
      preheader: props.campaign.preheader,
      body_html: props.campaign.body_html,
    });
    const settings = computed(() => store.overview.settings);

    // ---- Saving: automatically, shortly after the last change ----
    const saveState = ref('saved');
    let saveTimer;
    async function save() {
      clearTimeout(saveTimer);
      if (saveState.value === 'saved') return;
      const sent = JSON.stringify(form);
      saveState.value = 'saving';
      try {
        await api.put(`/api/campaigns/${id}`, form);
        // Typing may have continued while the request was on its way.
        if (JSON.stringify(form) === sent) saveState.value = 'saved';
      } catch (error) {
        saveState.value = 'failed';
        throw error;
      }
    }
    watch(form, () => {
      saveState.value = 'dirty';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => save().catch(problem), 1200);
    });
    const warnUnsaved = (event) => {
      if (saveState.value !== 'saved') event.preventDefault();
    };
    onMounted(() => addEventListener('beforeunload', warnUnsaved));
    onBeforeUnmount(() => {
      removeEventListener('beforeunload', warnUnsaved);
      save().catch(problem);
    });

    // ---- Audience and personalisation ----
    const lists = computed(() => store.overview.lists.filter((item) => item.list));
    // Only contacts who were never emailed: nobody gets a campaign email twice.
    const audienceSize = computed(() =>
      store.overview.lists.filter((item) => !form.list || item.list === form.list).reduce((sum, item) => sum + item.available, 0),
    );
    // Without DISPATCH_TOKEN the app cannot start a run itself.
    const waitHint = ' It goes out with the next hourly run. To send it now, press Run workflow on the Mailer workflow in GitHub.';
    // The preview and the test email are filled in with a real contact from the audience.
    const sample = ref(SAMPLE);
    async function loadSample(list) {
      const query = list ? `&list=${encodeURIComponent(list)}` : '';
      const { rows } = await api.get(`/api/contacts?status=active&limit=1${query}`);
      sample.value = rows[0] ?? SAMPLE;
    }
    watch(() => form.list, (list) => loadSample(list).catch(problem), { immediate: true });
    const mergeItems = computed(() => [
      ...BUILT_IN,
      ...Object.keys(sample.value.fields)
        .filter((key) => key !== 'first_name')
        .map((key) => ({ label: key.replaceAll('_', ' '), value: `{{${key}}}`, hint: key })),
    ]);
    const unknownTags = computed(() => {
      const known = new Set(['first_name', 'name', 'email', 'unsubscribe_url', ...Object.keys(sample.value.fields)]);
      return findTags(`${form.subject} ${form.preheader} ${form.body_html}`).filter((tag) => !known.has(tag));
    });

    const editor = ref(null);
    const subjectInput = ref(null);
    function insertInSubject(tag) {
      const input = subjectInput.value;
      input.focus();
      input.setRangeText(tag, input.selectionStart, input.selectionEnd, 'end');
      form.subject = input.value;
    }

    // ---- Preview: the same rendering the real email gets, a moment after typing stops ----
    const preview = ref({ subject: '', html: '' });
    const device = ref('desktop');
    let previewTimer;
    watchEffect(() => {
      const rendered = renderEmail({ campaign: { ...form, links: [] }, contact: sample.value, settings: settings.value });
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => (preview.value = rendered), 300);
    });
    onBeforeUnmount(() => clearTimeout(previewTimer));

    // ---- Dialogs ----
    const dialog = ref('');
    const busy = ref(false);
    const uploading = ref(false);
    const button = reactive({ text: 'Get the app', url: 'https://' });
    const testEmail = ref(stored('mailer.test') || store.overview.sender_email);

    function openButtonDialog() {
      editor.value.hold();
      dialog.value = 'button';
    }
    function closeButtonDialog() {
      editor.value.release();
      dialog.value = '';
    }
    function insertButton() {
      const url = button.url.trim();
      const text = button.text.trim();
      if (!text || !/^https?:\/\/\S+\.\S+/i.test(url)) {
        toast('Enter the button text and a full link starting with https://', 'problem');
        return;
      }
      const style = 'display:inline-block;padding:12px 22px;border-radius:6px;background:#2563eb;color:#ffffff;font-weight:600;text-decoration:none;';
      editor.value.insert(`<p><a href="${escapeHtml(url)}" style="${style}">${escapeHtml(text)}</a></p>`);
      dialog.value = '';
    }

    // Runs one action at a time, after making sure the latest text is saved.
    async function act(action) {
      busy.value = true;
      try {
        await save();
        await action();
      } catch (error) {
        problem(error);
      }
      busy.value = false;
    }

    const sendTest = () =>
      act(async () => {
        const { started } = await api.post(`/api/campaigns/${id}/test`, { email: testEmail.value });
        remember('mailer.test', testEmail.value.trim());
        dialog.value = '';
        toast(started ? 'Test queued. The run is starting, so it should arrive in a minute or two.' : `Test queued.${waitHint}`);
      });

    const start = () =>
      act(async () => {
        const { queued, started } = await api.post(`/api/campaigns/${id}/start`);
        toast(`Campaign started: ${plural(queued, 'email')} queued.${started ? ' The first run is starting now.' : waitHint}`);
        emit('started');
      });

    async function remove() {
      const sure = await ask({ title: 'Delete this draft?', text: 'The draft and its content are removed for good.', action: 'Delete draft', danger: true });
      if (!sure) return;
      clearTimeout(saveTimer);
      saveState.value = 'saved';
      await api.del(`/api/campaigns/${id}`);
      go('/campaigns');
    }

    const pace = computed(() => {
      const runs = Math.ceil(audienceSize.value / settings.value.batch_size);
      const days = Math.ceil(audienceSize.value / settings.value.daily_limit);
      return `${count(settings.value.batch_size)} per run and at most ${count(settings.value.daily_limit)} a day: about ${plural(runs, 'run')}${days > 1 ? ` over ${days} days` : ''}.`;
    });

    return {
      form, lists, audienceSize, sample, mergeItems, unknownTags, editor, subjectInput, insertInSubject,
      preview, device, dialog, busy, uploading, button, testEmail, pace, settings, store, SAVE_LABELS, saveState,
      openButtonDialog, closeButtonDialog, insertButton, sendTest, start, count, plural,
      remove: () => remove().catch(problem),
    };
  },
  template: `
    <a class="back" href="#/campaigns"><Icon name="back" /> Campaigns</a>
    <div class="page-head">
      <h1>{{ form.name || 'Untitled campaign' }}</h1>
      <span class="badge ring">Draft</span>
      <div class="actions">
        <span class="save-state">{{ SAVE_LABELS[saveState] }}</span>
        <button type="button" class="btn ghost danger" title="Delete this draft" aria-label="Delete this draft" @click="remove"><Icon name="trash" /></button>
        <button type="button" class="btn" @click="dialog = 'test'"><Icon name="send" /> Send test</button>
        <button type="button" class="btn primary" @click="dialog = 'start'"><Icon name="play" /> Start sending</button>
      </div>
    </div>

    <div class="editor-layout">
      <div class="card pad stack">
        <div class="field-row">
          <div class="field">
            <label for="campaign-name">Campaign name</label>
            <input id="campaign-name" type="text" v-model="form.name" maxlength="120">
            <span class="hint">Only you see this.</span>
          </div>
          <div class="field">
            <label for="campaign-list">Send to</label>
            <select id="campaign-list" v-model="form.list">
              <option value="">All contacts</option>
              <option v-for="item in lists" :key="item.list" :value="item.list">{{ item.list }}</option>
            </select>
            <span class="hint">{{ plural(audienceSize, 'contact') }} to email. Anyone already emailed, or waiting in another campaign, is left out.</span>
          </div>
        </div>
        <div class="field">
          <label for="campaign-subject">Subject</label>
          <div class="with-menu">
            <input id="campaign-subject" ref="subjectInput" type="text" v-model="form.subject" maxlength="300" :placeholder="'Quick question, {{first_name|there}}'">
            <Menu label="Personalize" :items="mergeItems" @pick="insertInSubject" />
          </div>
        </div>
        <div class="field">
          <label for="campaign-preheader">Preview text</label>
          <input id="campaign-preheader" type="text" v-model="form.preheader" maxlength="300">
          <span class="hint">The grey line mail apps show next to the subject. Optional.</span>
        </div>
        <div class="field">
          <div class="row">
            <span class="label">Message</span>
            <span class="spacer"></span>
            <span v-if="uploading" class="muted small">Uploading image…</span>
            <Menu label="Personalize" :items="mergeItems" @pick="editor.insert($event)" />
            <button type="button" class="btn compact" @click="openButtonDialog"><Icon name="plus" /> Button</button>
          </div>
          <RichEditor ref="editor" v-model="form.body_html" @uploading="uploading = $event" />
          <span v-if="settings.footer" class="hint">Your postal address and an unsubscribe link are added below the message.</span>
        </div>
        <div v-if="unknownTags.length" class="notice problem">
          <Icon name="alert" />
          <span>No contact field matches <b>{{ unknownTags.join(', ') }}</b>. It would be left empty in the email.</span>
        </div>
      </div>

      <div class="card preview">
        <div class="card-head">
          <h2>Preview</h2>
          <span class="spacer"></span>
          <div class="segmented">
            <button type="button" :class="{ active: device === 'desktop' }" @click="device = 'desktop'">Desktop</button>
            <button type="button" :class="{ active: device === 'phone' }" @click="device = 'phone'">Phone</button>
          </div>
        </div>
        <div class="preview-meta">
          <b>{{ preview.subject || 'No subject yet' }}</b>
          <span class="muted">From {{ settings.sender_name || 'you' }} · to {{ sample.name || sample.email }}</span>
        </div>
        <div class="preview-stage" :class="device">
          <iframe title="Email preview" sandbox="allow-same-origin" :srcdoc="preview.html"></iframe>
        </div>
      </div>
    </div>

    <Modal v-if="dialog === 'button'" title="Add a button" @close="closeButtonDialog">
      <div class="field"><label for="button-text">Text on the button</label><input id="button-text" type="text" v-model="button.text" maxlength="60"></div>
      <div class="field"><label for="button-url">Link</label><input id="button-url" type="text" v-model="button.url" placeholder="https://"></div>
      <template #foot>
        <button type="button" class="btn" @click="closeButtonDialog">Cancel</button>
        <button type="button" class="btn primary" @click="insertButton">Add button</button>
      </template>
    </Modal>

    <Modal v-if="dialog === 'test'" title="Send a test email" @close="dialog = ''">
      <div class="field">
        <label for="test-email">Send it to</label>
        <input id="test-email" type="email" v-model="testEmail" placeholder="you@gmail.com" @keydown.enter="sendTest">
        <span class="hint">Filled in with the details of {{ sample.name || sample.email }}. Tests are not counted in the results.</span>
      </div>
      <template #foot>
        <button type="button" class="btn" @click="dialog = ''">Cancel</button>
        <button type="button" class="btn primary" :disabled="busy || uploading" @click="sendTest"><Icon name="send" /> Send test</button>
      </template>
    </Modal>

    <Modal v-if="dialog === 'start'" title="Start sending?" @close="dialog = ''">
      <p>This sends <b>{{ preview.subject || 'this email' }}</b> to <b>{{ plural(audienceSize, 'contact') }}</b> in {{ form.list || 'all your lists' }}. The content cannot be changed afterwards.</p>
      <p v-if="audienceSize" class="muted">{{ pace }} You can pause at any time.</p>
      <div v-if="!settings.sender_name" class="notice">
        <Icon name="info" />
        <span>Your name is not set, so the email shows only your address as the sender. <a href="#/settings">Add it in Settings</a>.</span>
      </div>
      <div v-if="!audienceSize" class="notice problem">
        <Icon name="alert" />
        <span>Everyone in this audience has already been emailed or is waiting in another campaign.</span>
      </div>
      <template #foot>
        <button type="button" class="btn" @click="dialog = ''">Cancel</button>
        <button type="button" class="btn primary" :disabled="busy || uploading || !audienceSize" @click="start"><Icon name="play" /> Start sending</button>
      </template>
    </Modal>`,
};
