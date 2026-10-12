// Small building blocks used by several screens. Registered globally in main.js.

import { onBeforeUnmount, onMounted, ref } from '/vendor/vue.js';
import { count } from './format.js';
import { store } from './store.js';

export const Modal = {
  props: { title: String, wide: Boolean },
  emits: ['close'],
  setup(props, { emit }) {
    const onKey = (event) => {
      if (event.key === 'Escape') emit('close');
    };
    onMounted(() => document.addEventListener('keydown', onKey));
    onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
  },
  template: `
    <div class="overlay" @mousedown.self="$emit('close')">
      <div class="modal" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title">
        <div class="modal-head">
          <h2>{{ title }}</h2>
          <span class="spacer"></span>
          <button type="button" class="btn ghost compact" aria-label="Close" @click="$emit('close')"><Icon name="x" /></button>
        </div>
        <div class="modal-body"><slot /></div>
        <div class="modal-foot"><slot name="foot" /></div>
      </div>
    </div>`,
};

/** A button that opens a short list: items are { label, hint, value }. */
export const Menu = {
  props: { label: String, items: Array },
  emits: ['pick'],
  setup(props, { emit }) {
    const open = ref(false);
    const root = ref(null);
    const onOutside = (event) => {
      if (!root.value?.contains(event.target)) open.value = false;
    };
    onMounted(() => document.addEventListener('mousedown', onOutside));
    onBeforeUnmount(() => document.removeEventListener('mousedown', onOutside));
    const pick = (item) => {
      open.value = false;
      emit('pick', item.value);
    };
    return { open, root, pick };
  },
  // Preventing mousedown keeps the text cursor where it is, so a pick lands at the cursor.
  template: `
    <div class="menu" ref="root">
      <button type="button" class="btn compact" @mousedown.prevent @click="open = !open">{{ label }} <Icon name="chevron" /></button>
      <div v-if="open" class="menu-list">
        <button v-for="item in items" :key="item.value" type="button" @mousedown.prevent @click="pick(item)">
          <span>{{ item.label }}</span><code>{{ item.hint }}</code>
        </button>
      </div>
    </div>`,
};

export const Pager = {
  props: { offset: Number, size: Number, total: Number },
  emits: ['update:offset'],
  setup: () => ({ count }),
  template: `
    <div class="pager" v-if="total > size">
      <span>{{ count(offset + 1) }}–{{ count(Math.min(offset + size, total)) }} of {{ count(total) }}</span>
      <span class="spacer"></span>
      <button type="button" class="btn compact" :disabled="offset === 0" @click="$emit('update:offset', Math.max(0, offset - size))">Previous</button>
      <button type="button" class="btn compact" :disabled="offset + size >= total" @click="$emit('update:offset', offset + size)">Next</button>
    </div>`,
};

export const Toasts = {
  setup: () => ({ store }),
  template: `
    <div class="toasts" aria-live="polite">
      <div v-for="item in store.toasts" :key="item.id" class="toast" :class="item.kind">{{ item.text }}</div>
    </div>`,
};

/** Renders the question raised by ask() in store.js. */
export const ConfirmDialog = {
  setup() {
    const answer = (value) => {
      store.dialog.resolve(value);
      store.dialog = null;
    };
    return { store, answer };
  },
  template: `
    <Modal v-if="store.dialog" :title="store.dialog.title" @close="answer(false)">
      <p>{{ store.dialog.text }}</p>
      <template #foot>
        <button type="button" class="btn" @click="answer(false)">Cancel</button>
        <button type="button" class="btn" :class="store.dialog.danger ? 'danger' : 'primary'" @click="answer(true)">{{ store.dialog.action }}</button>
      </template>
    </Modal>`,
};
