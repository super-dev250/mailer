// The contact list, and importing it from a spreadsheet.

import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from '/vendor/vue.js';
import { api, refreshOverview } from '../api.js';
import { count, plural, when } from '../format.js';
import { guessColumns, readTable, toContacts } from '../import.js';
import { ask, problem, store, toast } from '../store.js';

const PAGE_SIZE = 50;
const CHUNK = 500;
const STATUS = {
  active: { label: 'Active', dot: 'var(--good)' },
  unsubscribed: { label: 'Unsubscribed', dot: 'var(--stage-queued)', ring: true },
  bounced: { label: 'Bounced', dot: 'var(--critical)' },
};

export const ContactsView = {
  setup() {
    // ---- The table ----
    const rows = ref([]);
    const total = ref(0);
    const search = ref('');
    const list = ref(null); // null: every list
    const status = ref('');
    const offset = ref(0);
    const selected = ref(new Set());
    const busy = ref(false);

    async function loadRows() {
      const query = new URLSearchParams({ offset: offset.value, limit: PAGE_SIZE });
      if (search.value.trim()) query.set('q', search.value.trim());
      if (list.value !== null) query.set('list', list.value);
      if (status.value) query.set('status', status.value);
      const data = await api.get(`/api/contacts?${query}`);
      rows.value = data.rows;
      total.value = data.total;
      selected.value = new Set();
    }
    const reload = () => loadRows().catch(problem);
    const fromStart = () => (offset.value === 0 ? reload() : (offset.value = 0));
    let searchTimer;
    watch([list, status], fromStart);
    watch(search, () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(fromStart, 300);
    });
    watch(offset, reload);
    onMounted(reload);
    onBeforeUnmount(() => clearTimeout(searchTimer));

    const afterChange = () => Promise.all([loadRows(), refreshOverview()]);
    const totalContacts = computed(() => store.overview.lists.reduce((sum, item) => sum + item.total, 0));
    const allSelected = computed(() => rows.value.length > 0 && rows.value.every((row) => selected.value.has(row.id)));
    function toggle(id) {
      const next = new Set(selected.value);
      if (!next.delete(id)) next.add(id);
      selected.value = next;
    }
    const toggleAll = () => (selected.value = allSelected.value ? new Set() : new Set(rows.value.map((row) => row.id)));

    const act = (work) => async () => {
      busy.value = true;
      await work().catch(problem);
      busy.value = false;
    };
    const setStatus = (value) =>
      act(async () => {
        const { changed } = await api.post('/api/contacts/status', { ids: [...selected.value], status: value });
        toast(`${plural(changed, 'contact')} updated.`);
        await afterChange();
      })();
    const removeSelected = act(async () => {
      const amount = plural(selected.value.size, 'contact');
      if (!(await ask({ title: `Delete ${amount}?`, text: 'Results of emails already sent to them are kept.', action: 'Delete', danger: true }))) return;
      await api.post('/api/contacts/delete', { ids: [...selected.value] });
      await afterChange();
    });
    const removeList = act(async () => {
      const name = list.value || 'contacts without a list';
      if (!(await ask({ title: `Delete the whole list “${name}”?`, text: `All ${count(total.value)} contacts on it are removed.`, action: 'Delete list', danger: true }))) return;
      const { deleted } = await api.post('/api/contacts/delete', { list: list.value });
      toast(`${plural(deleted, 'contact')} deleted.`);
      list.value = null;
      await refreshOverview();
    });

    // ---- Dialogs ----
    const dialog = ref('');
    const fresh = reactive({ email: '', name: '', list: '' });
    const addContact = act(async () => {
      const result = await api.post('/api/contacts/import', { list: fresh.list.trim() || 'Added by hand', rows: [{ ...fresh }] });
      if (result.invalid) throw new Error('That does not look like an email address.');
      toast(result.added ? 'Contact added.' : 'That address is already in your contacts.');
      Object.assign(fresh, { email: '', name: '' });
      dialog.value = '';
      await afterChange();
    });

    // ---- Import: pick a file, check the columns, send in chunks ----
    const table = ref(null);
    const columns = reactive({ email: 0, name: -1 });
    const listName = ref('');
    const dragging = ref(false);
    const progress = ref(null);
    const result = ref(null);
    const parsed = computed(() => (table.value ? toContacts(table.value, columns) : null));

    function openImport() {
      table.value = null;
      result.value = null;
      progress.value = null;
      dialog.value = 'import';
    }
    const readFile = (file) =>
      act(async () => {
        if (!file) return;
        const data = await readTable(file);
        Object.assign(columns, guessColumns(data));
        listName.value = file.name.replace(/\.[^.]+$/, '');
        table.value = data;
      })();
    function onDrop(event) {
      dragging.value = false;
      readFile(event.dataTransfer.files[0]);
    }
    const runImport = act(async () => {
      const { contacts } = parsed.value;
      const totals = { added: 0, existing: 0, invalid: 0 };
      progress.value = 0;
      for (let start = 0; start < contacts.length; start += CHUNK) {
        const chunk = await api.post('/api/contacts/import', { list: listName.value.trim(), rows: contacts.slice(start, start + CHUNK) });
        for (const key of Object.keys(totals)) totals[key] += chunk[key];
        progress.value = Math.min(contacts.length, start + CHUNK);
      }
      result.value = totals;
      await afterChange();
    });

    return {
      PAGE_SIZE, STATUS, store, rows, total, search, list, status, offset, selected, busy, totalContacts, allSelected, toggle, toggleAll,
      setStatus, removeSelected, removeList, dialog, fresh, addContact, table, columns, listName, dragging, progress, result, parsed,
      openImport, readFile, onDrop, runImport, count, plural, when,
    };
  },
  template: `
    <div class="page-head">
      <h1>Contacts</h1>
      <span class="muted">{{ count(totalContacts) }}</span>
      <div class="actions">
        <button type="button" class="btn" @click="dialog = 'add'"><Icon name="plus" /> Add contact</button>
        <button type="button" class="btn primary" @click="openImport"><Icon name="upload" /> Import file</button>
      </div>
    </div>

    <div v-if="!totalContacts" class="card empty">
      <h2>No contacts yet</h2>
      <p>Import the Excel or CSV file that holds your email addresses.</p>
      <button type="button" class="btn primary" @click="openImport"><Icon name="upload" /> Import file</button>
    </div>
    <div v-else class="card">
      <div class="card-head">
        <template v-if="selected.size">
          <b>{{ selected.size }} selected</b>
          <button type="button" class="btn compact" :disabled="busy" @click="setStatus('unsubscribed')">Unsubscribe</button>
          <button type="button" class="btn compact" :disabled="busy" @click="setStatus('active')">Mark active</button>
          <button type="button" class="btn compact danger" :disabled="busy" @click="removeSelected">Delete</button>
          <button type="button" class="btn compact ghost" @click="selected = new Set()">Clear</button>
        </template>
        <template v-else>
          <input type="search" v-model="search" placeholder="Search name or email" aria-label="Search contacts" style="width: 230px">
          <select v-model="list" aria-label="List" style="width: auto">
            <option :value="null">All lists</option>
            <option v-for="item in store.overview.lists" :key="item.list" :value="item.list">{{ item.list || 'No list' }} ({{ count(item.total) }})</option>
          </select>
          <select v-model="status" aria-label="Status" style="width: auto">
            <option value="">Any status</option>
            <option v-for="(item, key) in STATUS" :key="key" :value="key">{{ item.label }}</option>
          </select>
          <span class="spacer"></span>
          <button v-if="list !== null" type="button" class="btn compact ghost danger" :disabled="busy" @click="removeList">Delete this list</button>
        </template>
      </div>
      <div v-if="rows.length" class="table-wrap">
        <table>
          <thead>
            <tr>
              <th class="narrow"><input type="checkbox" :checked="allSelected" aria-label="Select all on this page" @change="toggleAll"></th>
              <th>Email</th><th>Name</th><th>List</th><th>Status</th><th>Added</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td class="narrow"><input type="checkbox" :checked="selected.has(row.id)" :aria-label="'Select ' + row.email" @change="toggle(row.id)"></td>
              <td class="cell-title">{{ row.email }}</td>
              <td>{{ row.name }}</td>
              <td>{{ row.list }}</td>
              <td><span class="badge" :class="{ ring: STATUS[row.status].ring }" :style="{ '--dot': STATUS[row.status].dot }">{{ STATUS[row.status].label }}</span></td>
              <td class="nowrap muted">{{ when(row.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty">No contacts match.</div>
      <Pager v-model:offset="offset" :size="PAGE_SIZE" :total="total" />
    </div>

    <Modal v-if="dialog === 'add'" title="Add a contact" @close="dialog = ''">
      <div class="field"><label for="new-email">Email</label><input id="new-email" type="email" v-model="fresh.email" @keydown.enter="addContact"></div>
      <div class="field"><label for="new-name">Name</label><input id="new-name" type="text" v-model="fresh.name" maxlength="200" @keydown.enter="addContact"></div>
      <div class="field">
        <label for="new-list">List</label>
        <input id="new-list" type="text" v-model="fresh.list" list="known-lists" maxlength="100" placeholder="Added by hand">
        <datalist id="known-lists"><option v-for="item in store.overview.lists" :key="item.list" :value="item.list"></option></datalist>
      </div>
      <template #foot>
        <button type="button" class="btn" @click="dialog = ''">Cancel</button>
        <button type="button" class="btn primary" :disabled="busy" @click="addContact">Add contact</button>
      </template>
    </Modal>

    <Modal v-if="dialog === 'import'" title="Import contacts" wide @close="dialog = ''">
      <template v-if="!table">
        <label class="dropzone" :class="{ over: dragging }" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
          <Icon name="upload" />
          <b>{{ busy ? 'Reading the file…' : 'Choose an Excel or CSV file' }}</b>
          <span>or drop it here. The first sheet is used.</span>
          <input type="file" accept=".csv,.tsv,.txt,.xlsx,.xls,.ods" hidden @change="readFile($event.target.files[0])">
        </label>
      </template>

      <template v-else-if="!result">
        <div class="field-row">
          <div class="field">
            <label for="column-email">Email column</label>
            <select id="column-email" v-model.number="columns.email">
              <option v-for="(header, index) in table.headers" :key="index" :value="index">{{ header }}</option>
            </select>
          </div>
          <div class="field">
            <label for="column-name">Name column</label>
            <select id="column-name" v-model.number="columns.name">
              <option :value="-1">None</option>
              <option v-for="(header, index) in table.headers" :key="index" :value="index">{{ header }}</option>
            </select>
          </div>
          <div class="field">
            <label for="list-name">List name</label>
            <input id="list-name" type="text" v-model="listName" maxlength="100">
          </div>
        </div>
        <p>
          <b>{{ plural(parsed.contacts.length, 'contact') }}</b> to import<template v-if="parsed.invalid"> · {{ plural(parsed.invalid, 'row') }} without a valid email</template><template v-if="parsed.repeated"> · {{ plural(parsed.repeated, 'repeat') }} left out</template>.
          The other columns are kept so you can use them to personalize emails.
        </p>
        <div class="card table-wrap">
          <table>
            <thead><tr><th>Email</th><th>Name</th><th>Other fields</th></tr></thead>
            <tbody>
              <tr v-for="contact in parsed.contacts.slice(0, 5)" :key="contact.email">
                <td class="cell-title">{{ contact.email }}</td>
                <td class="nowrap">{{ contact.name }}</td>
                <td class="muted small">{{ Object.entries(contact.fields).map(([key, value]) => key + ': ' + value).join(' · ') }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="progress !== null" class="muted">Importing… {{ count(progress) }} of {{ count(parsed.contacts.length) }}</p>
      </template>

      <template v-else>
        <div class="notice"><Icon name="check" /><span><b>{{ plural(result.added, 'contact') }} added</b> to “{{ listName.trim() }}”.</span></div>
        <p v-if="result.existing" class="muted">{{ plural(result.existing, 'address', 'addresses') }} already existed and were left as they are.</p>
      </template>

      <template #foot>
        <button type="button" class="btn" @click="dialog = ''">{{ result ? 'Done' : 'Cancel' }}</button>
        <button v-if="table && !result" type="button" class="btn primary" :disabled="busy || !parsed.contacts.length || !listName.trim()" @click="runImport">
          Import {{ plural(parsed.contacts.length, 'contact') }}
        </button>
      </template>
    </Modal>`,
};
