import { signOut, store } from './store.js';

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${store.secret}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) signOut();
  if (!response.ok) {
    const error = new Error(data.error ?? `The request failed (${response.status}).`);
    error.status = response.status;
    error.retryAfter = data.retry_after;
    throw error;
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
};

/** Settings, lists and the state of the last run: what the sidebar and most screens need. */
export async function refreshOverview() {
  store.overview = await api.get('/api/overview');
}
