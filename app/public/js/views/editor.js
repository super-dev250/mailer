// Writing a campaign: who it goes to, the subject, the message, and a live preview.

import { computed, onBeforeUnmount, onMounted, reactive, ref, watch, watchEffect } from '/vendor/vue.js';
import { PART_BYTES, attachmentProblem, formatBytes } from '/shared/attachments.js';
import { escapeHtml, findTags, renderEmail } from '/shared/email.js';
import { api } from '../api.js';
import { RichEditor } from '../editor.js';
import { blobToBase64 } from '../images.js';
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
  // `locked`: this is a paused campaign being edited, not a fresh draft. The audience was already
  // fixed when it started, and there is no "start sending" left to do, only to save and go back.
  props: { campaign: Object, attachments: Array, locked: { type: Boolean, default: false } },
  emits: ['started', 'done'],
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

    // ---- Attachments: stored straight away, apart from the text ----
    let newKey = 0;
    const files = ref(props.attachments.map((file) => ({ ...file, key: file.id, progress: '' })));
    const sendingFiles = computed(() => files.value.some((file) => file.progress));

    async function attachOne(file) {
      const problemText = attachmentProblem(file.name, file.size, files.value);
      if (problemText) throw new Error(problemText);
      const entry = reactive({ key: `new${++newKey}`, id: null, name: file.name, size: file.size, complete: false, progress: 'Starting…' });
      files.value.push(entry);
      try {
        const created = await api.post(`/api/campaigns/${id}/attachments`, { name: file.name, type: file.type, size: file.size });
        entry.id = created.id;
        // In parts, because the app stores at most 1.4 MB in one piece.
        for (let part = 0; part < created.parts; part++) {
          entry.progress = `Uploading ${Math.round((part / created.parts) * 100)}%`;
          const data = await blobToBase64(file.slice(part * PART_BYTES, (part + 1) * PART_BYTES));
          await api.put(`/api/attachments/${entry.id}/parts/${part}`, { data });
        }
        Object.assign(entry, { complete: true, progress: '' });
      } catch (error) {
        files.value = files.value.filter((item) => item !== entry);
        if (entry.id) api.del(`/api/attachments/${entry.id}`).catch(() => {});
        throw error;
      }
    }
    async function attach(list) {
      for (const file of list) await attachOne(file).catch(problem);
    }
    async function detach(file) {
      await api.del(`/api/attachments/${file.id}`);
      files.value = files.value.filter((item) => item !== file);
    }
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

    // act() already saves before running its action, so this just needs to wait for that and leave.
    const finishEditing = () => act(async () => emit('done'));

    return {
      files, sendingFiles, attach, formatBytes, detach: (file) => detach(file).catch(problem),
      form, lists, audienceSize, sample, mergeItems, unknownTags, editor, subjectInput, insertInSubject,
      preview, device, dialog, busy, uploading, button, testEmail, pace, settings, store, SAVE_LABELS, saveState,
      openButtonDialog, closeButtonDialog, insertButton, sendTest, start, finishEditing, count, plural,
      remove: () => remove().catch(problem),
    };
  },
  template: `
    <a class="back" href="#/campaigns"><Icon name="back" /> Campaigns</a>
    <div class="page-head">
      <h1>{{ form.name || 'Untitled campaign' }}</h1>
      <span class="badge ring">{{ locked ? 'Paused — editing' : 'Draft' }}</span>
      <div class="actions">
        <span class="save-state">{{ SAVE_LABELS[saveState] }}</span>
        <button v-if="!locked" type="button" class="btn ghost danger" title="Delete this draft" aria-label="Delete this draft" @click="remove"><Icon name="trash" /></button>
        <button type="button" class="btn" @click="dialog = 'test'"><Icon name="send" /> Send test</button>
        <button v-if="locked" type="button" class="btn primary" :disabled="busy" @click="finishEditing"><Icon name="check" /> Done editing</button>
        <button v-else type="button" class="btn primary" @click="dialog = 'start'"><Icon name="play" /> Start sending</button>
      </div>
    </div>

    <div v-if="locked" class="notice">
      <Icon name="info" />
      <span>Recipients already emailed keep what they got. Anyone not yet emailed gets whatever this is set to once sending resumes.</span>
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
            <select id="campaign-list" v-model="form.list" :disabled="locked">
              <option value="">All contacts</option>
              <option v-for="item in lists" :key="item.list" :value="item.list">{{ item.list }}</option>
            </select>
            <span class="hint">
              <template v-if="locked">Set when this campaign started; it cannot be changed now.</template>
              <template v-else>{{ plural(audienceSize, 'contact') }} to email. Anyone already emailed, or waiting in another campaign, is left out.</template>
            </span>
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
        <div class="field">
          <div class="row">
            <span class="label">Attachments</span>
            <span class="spacer"></span>
            <label class="btn compact">
              <Icon name="paperclip" /> Attach files
              <input type="file" multiple hidden @change="attach([...$event.target.files]); $event.target.value = ''">
            </label>
          </div>
          <div v-if="files.length" class="files">
            <div v-for="file in files" :key="file.key" class="file">
              <Icon name="paperclip" />
              <span class="file-name" :title="file.name">{{ file.name }}</span>
              <span class="muted small nowrap">{{ file.progress || (file.complete ? formatBytes(file.size) : 'Upload did not finish') }}</span>
              <button v-if="!file.progress" type="button" class="btn ghost compact" :aria-label="'Remove ' + file.name" @click="detach(file)"><Icon name="x" /></button>
            </div>
          </div>
          <span class="hint">Up to 5 files, 10 MB in all. Files in a first email make spam filters more careful: a link to the file is often safer.</span>
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
          <span v-if="files.length" class="muted"><Icon name="paperclip" /> {{ files.map((file) => file.name).join(', ') }}</span>
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
        <button type="button" class="btn primary" :disabled="busy || uploading || sendingFiles" @click="sendTest"><Icon name="send" /> Send test</button>
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
        <button type="button" class="btn primary" :disabled="busy || uploading || sendingFiles || !audienceSize" @click="start"><Icon name="play" /> Start sending</button>
      </template>
    </Modal>`,
};
