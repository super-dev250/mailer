// Finds the registered email address of every member of a Slack workspace, from the user
// directory rather than scanning message text: a directory entry is the address someone actually
// signed up with, not a best-effort guess scraped out of free-text messages. Needs the optional
// SLACK_API_TOKEN secret: a token with the users:read.email scope, which Slack treats as
// sensitive and only grants to a workspace admin/owner's token or an app an admin has approved.

import { EXCLUDED_LOCATIONS, LOOKS_GENERATED } from './emailFilters.js';
import { check, HttpError } from './http.js';

const PER_PAGE = 200; // Slack's own documented maximum page size for users.list.

export const canScrape = (env) => Boolean(env.SLACK_API_TOKEN);

export async function search({ env, body }) {
  check(canScrape(env), 400, 'Finding Slack contacts needs the optional SLACK_API_TOKEN secret. See the README.');
  const input = await body();
  const cursor = String(input.cursor ?? '').trim();

  const url = new URL('https://slack.com/api/users.list');
  url.searchParams.set('limit', String(PER_PAGE));
  if (cursor) url.searchParams.set('cursor', cursor);

  const response = await fetch(url, { headers: { Authorization: `Bearer ${env.SLACK_API_TOKEN}` } });
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after')) || 60;
    throw new HttpError(429, 'Slack is rate-limiting these requests.', { retry_after: retryAfter });
  }
  if (!response.ok) throw new HttpError(502, `Slack directory lookup failed (HTTP ${response.status}).`);
  const data = await response.json();
  if (!data.ok) {
    if (data.error === 'invalid_auth' || data.error === 'not_authed' || data.error === 'token_revoked') {
      throw new HttpError(400, 'SLACK_API_TOKEN was rejected by Slack. Check the secret.');
    }
    if (data.error === 'missing_scope') {
      throw new HttpError(400, 'SLACK_API_TOKEN is missing the users:read.email scope. See the README.');
    }
    if (data.error === 'ratelimited') throw new HttpError(429, 'Slack is rate-limiting these requests.', { retry_after: 60 });
    throw new HttpError(502, `Slack directory lookup failed (${data.error}).`);
  }

  const rows = [];
  for (const member of data.members ?? []) {
    // Deactivated accounts, bots and installed apps have no real inbox behind them. Slackbot
    // itself always shows up in this list too, and is never a real person.
    if (member.deleted || member.is_bot || member.is_app_user || member.id === 'USLACKBOT') continue;
    const email = String(member.profile?.email ?? '').trim().toLowerCase();
    if (!email || LOOKS_GENERATED.test(email.split('@')[0])) continue;
    // users.list already carries each member's timezone, so no extra per-user request is needed
    // here the way GitHub's separate profile lookup was: best-effort only, same as there.
    const location = member.tz_label || member.tz || '';
    if (location && EXCLUDED_LOCATIONS.test(location)) continue;
    rows.push({
      name: String(member.profile?.real_name || member.real_name || member.name || '').trim(),
      email,
      user_id: member.id,
      url: member.team_id ? `slack://user?team=${encodeURIComponent(member.team_id)}&id=${encodeURIComponent(member.id)}` : '',
    });
  }
  const next = data.response_metadata?.next_cursor ?? '';
  return { rows, cursor: next, has_more: Boolean(next) };
}
