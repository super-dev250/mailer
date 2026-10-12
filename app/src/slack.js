// Finds public contact details on Slack: given a search query, looks through message search
// results for the email address people posted, alongside their display name and a permalink to
// the message. Needs the optional SLACK_API_TOKEN secret: a user token with the search:read
// scope, because Slack's search API only works with a token that can search as a real member.

import { cleanEmail } from '../public/shared/email.js';
import { ALLOWED_DOMAINS, EXCLUDED_LOCATIONS, LOOKS_GENERATED } from './emailFilters.js';
import { check, HttpError } from './http.js';

const PER_PAGE = 100;
const MAX_PAGE = 100; // Slack's search API returns at most 10,000 results for one query: 100 pages of 100.

// One Worker invocation gets a limited number of outgoing requests; this leaves headroom for the
// search request itself plus a safety margin, so a page with unusually many distinct posters
// degrades to "not all of them checked" instead of failing outright.
const MAX_LOCATION_LOOKUPS = 40;

async function excludedLocations(env, userIds) {
  const unique = [...new Set(userIds)].slice(0, MAX_LOCATION_LOOKUPS);
  const excluded = new Set();
  await Promise.all(
    unique.map(async (id) => {
      try {
        const response = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(id)}`, {
          headers: { Authorization: `Bearer ${env.SLACK_API_TOKEN}` },
        });
        if (!response.ok) return; // unknown: kept, not excluded
        const data = await response.json();
        if (!data.ok) return;
        // Slack profiles have no free-text "location" field; the timezone label is the closest
        // proxy available (e.g. "Pakistan Standard Time"), and just as unreliable as GitHub's.
        const label = data.user?.tz_label || data.user?.tz || '';
        if (label && EXCLUDED_LOCATIONS.test(label)) excluded.add(id);
      } catch {
        // Unknown: kept, not excluded.
      }
    }),
  );
  return excluded;
}

export const canScrape = (env) => Boolean(env.SLACK_API_TOKEN);

export async function search({ env, body }) {
  check(canScrape(env), 400, 'Finding Slack contacts needs the optional SLACK_API_TOKEN secret. See the README.');
  const input = await body();
  const query = String(input.query ?? '').trim();
  check(query, 400, 'Enter a search query.');
  const page = Math.min(MAX_PAGE, Math.max(1, Math.round(Number(input.page)) || 1));

  const response = await fetch(
    `https://slack.com/api/search.messages?query=${encodeURIComponent(query)}&count=${PER_PAGE}&page=${page}&sort=timestamp`,
    { headers: { Authorization: `Bearer ${env.SLACK_API_TOKEN}` } },
  );
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('retry-after')) || 60;
    throw new HttpError(429, 'Slack is rate-limiting these searches.', { retry_after: retryAfter });
  }
  if (!response.ok) throw new HttpError(502, `Slack search failed (HTTP ${response.status}).`);
  const data = await response.json();
  if (!data.ok) {
    if (data.error === 'invalid_auth' || data.error === 'not_authed' || data.error === 'token_revoked') {
      throw new HttpError(400, 'SLACK_API_TOKEN was rejected by Slack. Check the secret.');
    }
    if (data.error === 'ratelimited') throw new HttpError(429, 'Slack is rate-limiting these searches.', { retry_after: 60 });
    throw new HttpError(502, `Slack search failed (${data.error}).`);
  }

  const seen = new Set();
  let rows = [];
  for (const item of data.messages?.matches ?? []) {
    const email = cleanEmail(item.text);
    if (!email || !ALLOWED_DOMAINS.test(email) || LOOKS_GENERATED.test(email.split('@')[0]) || seen.has(email)) continue;
    seen.add(email);
    rows.push({
      name: String(item.username ?? '').trim(),
      email,
      user_id: item.user ?? '',
      url: item.permalink ?? '',
    });
  }
  const excluded = await excludedLocations(env, rows.filter((row) => row.user_id).map((row) => row.user_id));
  if (excluded.size) rows = rows.filter((row) => !excluded.has(row.user_id));

  // Slack reports the true match count here even though it only lets us page through the first
  // 10,000: that is how the caller knows a query needs to be narrowed to get the rest.
  const total = data.messages?.total ?? 0;
  const reachable = Math.min(total, MAX_PAGE * PER_PAGE);
  return {
    rows,
    page,
    has_more: page < MAX_PAGE && page * PER_PAGE < reachable,
    total,
    truncated: total > MAX_PAGE * PER_PAGE,
  };
}
