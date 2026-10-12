// The small amount of state shared by every screen.

import { reactive } from '/vendor/vue.js';

// Storage can be unavailable (private windows). The app then simply asks again.
export function stored(key) {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
export function remember(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Nothing to do: the value just is not remembered.
  }
}

const SECRET = 'mailer.secret';

// "#/campaigns/12" -> { view: 'campaigns', id: 12 }
function parseRoute() {
  const [view, id] = location.hash.replace(/^#\/?/, '').split('/');
  return { view: view || 'campaigns', id: id ? Number(id) : null };
}

export const store = reactive({
  secret: stored(SECRET),
  overview: null,
  route: parseRoute(),
  toasts: [],
  dialog: null,
});

addEventListener('hashchange', () => {
  store.route = parseRoute();
});

export function go(path) {
  location.hash = path;
}

export function signIn(secret) {
  store.secret = secret;
  remember(SECRET, secret);
}

export function signOut() {
  store.secret = '';
  store.overview = null;
  remember(SECRET, '');
}

let lastToast = 0;
export function toast(text, kind = 'info') {
  const id = ++lastToast;
  store.toasts.push({ id, text, kind });
  setTimeout(() => {
    store.toasts = store.toasts.filter((item) => item.id !== id);
  }, kind === 'problem' ? 9000 : 5000);
}

/** Shows an error from a failed action. Use as `.catch(problem)`. */
export const problem = (error) => toast(error.message, 'problem');

/** Asks for confirmation: { title, text, action, danger }. Resolves to true when confirmed. */
export function ask(options) {
  return new Promise((resolve) => {
    store.dialog = { ...options, resolve };
  });
}
