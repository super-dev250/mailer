// The Gmail accounts the app can send from. One is all most people need; add a second (or
// third) to spread volume and protect any single account's reputation, each with its own pace
// and its own inbox.

import { computed, reactive, ref } from '/vendor/vue.js';
import { DEFAULT_MAILBOX_PACE } from '/shared/pace.js';
import { api, refreshOverview } from '../api.js';
import { ago, count } from '../format.js';
import { ask, problem, store, toast } from '../store.js';

const EMPTY_FORM = { email: '', name: '', sender_name: '', ...DEFAULT_MAILBOX_PACE };

export const MailboxesView = {
  setup() {
    const mailboxes = computed(() => store.overview.mailboxes);
    const dialog = ref(''); // '' | 'add' | editing mailbox's id
    const form = reactive({ ...EMPTY_FORM });
    const busy = ref(false);

    function openAdd() {
      Object.assign(form, EMPTY_FORM);
      dialog.value = 'add';
    }
    function openEdit(mailbox) {
      Object.assign(form, mailbox);
      dialog.value = mailbox.id;
    }
    // Resets just the pace fields, so a mailbox tweaked into something unsafe (or left over from
    // before this app tracked pace per mailbox) is one click from the same cautious starting point
    // every new mailbox gets.
    const useSafeDefaults = () => Object.assign(form, DEFAULT_MAILBOX_PACE);

    const act = (work) => async () => {
      busy.value = true;
      await work().catch(problem);
      busy.value = false;
    };

    const save = act(async () => {
      if (dialog.value === 'add') await api.post('/api/mailboxes', form);
      else await api.put(`/api/mailboxes/${dialog.value}`, form);
      dialog.value = '';
      await refreshOverview();
      toast('Mailbox saved.');
    });

    const toggleStatus = (mailbox) =>
      act(async () => {
        await api.put(`/api/mailboxes/${mailbox.id}`, { status: mailbox.status === 'active' ? 'paused' : 'active' });
        await refreshOverview();
      })();

    const remove = (mailbox) =>
      act(async () => {
        const sure = await ask({
          title: `Delete "${mailbox.name}"?`,
          text: 'Draft campaigns set to send from it will need another mailbox chosen before they can start. Its results so far are kept.',
          action: 'Delete mailbox',
          danger: true,
        });
        if (!sure) return;
        await api.del(`/api/mailboxes/${mailbox.id}`);
        await refreshOverview();
        toast('Mailbox deleted.');
      })();

    // What the pace settings add up to, in plain numbers — same shape as Settings' own.
    const pace = (mailbox) => {
      const runsPerDay = Math.floor(1440 / Math.max(5, store.overview.settings.run_every_minutes));
      const perDay = Math.min(mailbox.daily_limit, mailbox.batch_size * runsPerDay);
      return `${count(mailbox.batch_size)} per run, up to ${count(perDay)} a day`;
    };

    const runSummary = (mailbox) => {
      const last = mailbox.last_run;
      if (!last) return { title: 'No runs yet', problem: false };
      if (last.error) return { title: `Problem ${ago(last.at)}`, detail: last.error, problem: true };
      const parts = [`Sent ${last.sent}`];
      if (last.replies) parts.push(`${last.replies} ${last.replies === 1 ? 'reply' : 'replies'}`);
      if (last.bounces) parts.push(`${last.bounces} ${last.bounces === 1 ? 'bounce' : 'bounces'}`);
      return { title: `Last run ${ago(last.at)}`, detail: parts.join(' · '), problem: false };
    };

    return {
      mailboxes, dialog, form, busy, openAdd, openEdit, useSafeDefaults, save, toggleStatus,
      remove, pace, runSummary, count, DEFAULT_MAILBOX_PACE,
    };
  },
  template: `
    <div class="page-head">
      <h1>Mailboxes</h1>
      <div class="actions">
        <button type="button" class="btn primary" @click="openAdd"><Icon name="plus" /> Add mailbox</button>
      </div>
    </div>

    <div v-if="!mailboxes.length" class="card empty">
      <h2>No mailbox yet</h2>
      <p>Added automatically the first time the Mailer workflow runs, or add one now to send from more than one Gmail account.</p>
      <button type="button" class="btn primary" @click="openAdd"><Icon name="plus" /> Add mailbox</button>
    </div>
    <div v-else class="stack">
      <div v-if="mailboxes.length > 1" class="notice">
        <Icon name="info" />
        <span>Each new campaign now needs a mailbox chosen, in its "Send from" field.</span>
      </div>
      <div v-for="mailbox in mailboxes" :key="mailbox.id" class="card pad stack">
        <div class="row">
          <h2>{{ mailbox.name }}</h2>
          <span class="badge" :class="{ ring: mailbox.status !== 'active' }" :style="{ '--dot': mailbox.status === 'active' ? 'var(--good)' : 'var(--stage-queued)' }">
            {{ mailbox.status === 'active' ? 'Active' : 'Paused' }}
          </span>
          <span class="spacer"></span>
          <button type="button" class="btn compact" :disabled="busy" @click="toggleStatus(mailbox)">
            {{ mailbox.status === 'active' ? 'Pause' : 'Resume' }}
          </button>
          <button type="button" class="btn compact" @click="openEdit(mailbox)"><Icon name="edit" /> Edit</button>
          <button type="button" class="btn ghost compact danger" :aria-label="'Delete ' + mailbox.name" :disabled="busy" @click="remove(mailbox)"><Icon name="trash" /></button>
        </div>
        <p class="muted">{{ mailbox.email }}{{ mailbox.sender_name ? ' · shown as "' + mailbox.sender_name + '"' : '' }} · {{ pace(mailbox) }}</p>
        <p v-if="mailbox.status === 'paused'" class="muted small">Paused: no new emails go out from it, but replies and bounces already sent are still tracked.</p>
        <div class="row small">
          <span :class="{ 'notice problem': runSummary(mailbox).problem }">{{ runSummary(mailbox).title }}</span>
          <span v-if="runSummary(mailbox).detail" class="muted">{{ runSummary(mailbox).detail }}</span>
        </div>
      </div>
    </div>

    <Modal v-if="dialog" :title="dialog === 'add' ? 'Add a mailbox' : 'Edit mailbox'" @close="dialog = ''">
      <div v-if="dialog === 'add'" class="field">
        <label for="mailbox-email">Gmail address</label>
        <input id="mailbox-email" type="email" v-model="form.email" placeholder="you@gmail.com">
        <span class="hint">Needs its own app password set as a GMAIL_ACCOUNTS secret on GitHub. See the README.</span>
      </div>
      <div class="field">
        <label for="mailbox-name">Label</label>
        <input id="mailbox-name" type="text" v-model="form.name" maxlength="100" placeholder="Main, or Sam — backup">
        <span class="hint">Only you see this, to tell mailboxes apart.</span>
      </div>
      <div class="field">
        <label for="mailbox-sender">Sender name</label>
        <input id="mailbox-sender" type="text" v-model="form.sender_name" maxlength="100" placeholder="Sam Road">
        <span class="hint">Shown to recipients as who the email is from.</span>
      </div>
      <div class="row">
        <span class="label">Pace</span>
        <span class="spacer"></span>
        <button type="button" class="btn compact" @click="useSafeDefaults">Use safe defaults</button>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="mailbox-batch">Emails per run</label>
          <input id="mailbox-batch" type="number" v-model.number="form.batch_size" min="1" max="500">
        </div>
        <div class="field">
          <label for="mailbox-delay">Seconds between emails</label>
          <input id="mailbox-delay" type="number" v-model.number="form.delay_seconds" min="1" max="120">
        </div>
        <div class="field">
          <label for="mailbox-daily">Most emails in 24 hours</label>
          <input id="mailbox-daily" type="number" v-model.number="form.daily_limit" min="1" max="2000">
        </div>
      </div>
      <p class="muted small">
        "Use safe defaults" sets {{ DEFAULT_MAILBOX_PACE.batch_size }} per run, {{ DEFAULT_MAILBOX_PACE.delay_seconds }}s apart, {{ DEFAULT_MAILBOX_PACE.daily_limit }} a day
        &mdash; a cautious pace for a mailbox with no sending history. See Settings for the full guidance on raising it gradually.
      </p>
      <template #foot>
        <button type="button" class="btn" @click="dialog = ''">Cancel</button>
        <button type="button" class="btn primary" :disabled="busy || (dialog === 'add' && !form.email.trim())" @click="save">Save</button>
      </template>
    </Modal>`,
};
