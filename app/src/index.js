// The Worker: tracking endpoints for the emails, an API for the web app, and an API for
// the GitHub Actions runner. The web app itself is static files in ../public.

import * as api from './api.js';
import { ready } from './db.js';
import { HttpError, json } from './http.js';
import * as runner from './runner.js';
import * as track from './track.js';

const routes = [];
const route = (method, path, handler, isPublic = false) =>
  routes.push({ method, parts: path.split('/'), handler, isPublic });

// Reached from inside the emails, so no login.
route('GET', '/o/:token', track.open, true);
route('GET', '/c/:token/:index', track.click, true);
route('GET', '/u/:token', track.unsubscribePage, true);
route('POST', '/u/:token', track.unsubscribe, true);
route('GET', '/img/:file', track.image, true);

route('GET', '/api/overview', api.overview);
route('PUT', '/api/settings', api.saveSettings);
route('POST', '/api/run', api.runNow);

route('GET', '/api/contacts', api.listContacts);
route('POST', '/api/contacts/import', api.importContacts);
route('POST', '/api/contacts/delete', api.deleteContacts);
route('POST', '/api/contacts/status', api.setContactStatus);

route('GET', '/api/campaigns', api.listCampaigns);
route('POST', '/api/campaigns', api.createCampaign);
route('GET', '/api/campaigns/:id', api.getCampaign);
route('PUT', '/api/campaigns/:id', api.updateCampaign);
route('DELETE', '/api/campaigns/:id', api.deleteCampaign);
route('POST', '/api/campaigns/:id/start', api.startCampaign);
route('POST', '/api/campaigns/:id/pause', api.pauseCampaign);
route('POST', '/api/campaigns/:id/resume', api.resumeCampaign);
route('POST', '/api/campaigns/:id/test', api.testCampaign);
route('GET', '/api/campaigns/:id/messages', api.listMessages);
route('POST', '/api/images', api.uploadImage);

route('POST', '/api/runner/claim', runner.claim);
route('POST', '/api/runner/report', runner.report);

function match(method, pathname) {
  const parts = pathname.split('/');
  for (const candidate of routes) {
    if (candidate.method !== method || candidate.parts.length !== parts.length) continue;
    const params = {};
    const fits = candidate.parts.every((part, i) => {
      if (!part.startsWith(':')) return part === parts[i];
      params[part.slice(1)] = parts[i];
      return true;
    });
    if (fits) return { ...candidate, params };
  }
  return null;
}

// The app secret is the only credential: the web app and the runner both send it as a bearer token.
async function authorize(request, env) {
  const secret = env.APP_SECRET ?? '';
  if (secret.length < 16) {
    throw new HttpError(503, 'APP_SECRET is not set, or is shorter than 16 characters. Set it and deploy again.');
  }
  const given = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const digest = (value) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(given), digest(secret)]);
  if (!crypto.subtle.timingSafeEqual(a, b)) throw new HttpError(401, 'That app secret is not correct.');
}

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    try {
      const found = match(request.method, url.pathname);
      if (!found) throw new HttpError(404, 'Not found.');
      if (!found.isPublic) await authorize(request, env);
      await ready(env.DB);
      const result = await found.handler({
        env,
        db: env.DB,
        url,
        params: found.params,
        body: () => request.json().catch(() => ({})),
        waitUntil: (promise) => context.waitUntil(promise),
      });
      return result instanceof Response ? result : json(result);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status);
      console.error(error);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  },
};
