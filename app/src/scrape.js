// Finds public contact details on GitHub: given a search query, looks through commit history
// for the name and email people committed with, alongside their GitHub login and profile URL.
// Needs the optional GH_API_TOKEN secret, because GitHub only allows commit search when signed in.

import { cleanEmail } from '../public/shared/email.js';
import { ALLOWED_DOMAINS, LOOKS_GENERATED } from './emailFilters.js';
import { check, HttpError } from './http.js';

const PER_PAGE = 100;
const MAX_PAGE = 10; // GitHub's search API returns at most 1000 results for one query: 10 pages of 100.

export const canScrape = (env) => Boolean(env.GH_API_TOKEN);

export async function search({ env, body }) {
  check(canScrape(env), 400, 'Finding GitHub contacts needs the optional GH_API_TOKEN secret. See the README.');
  const input = await body();
  const query = String(input.query ?? '').trim();
  check(query, 400, 'Enter a search query.');
  const page = Math.min(MAX_PAGE, Math.max(1, Math.round(Number(input.page)) || 1));

  const response = await fetch(
    `https://api.github.com/search/commits?q=${encodeURIComponent(query)}&per_page=${PER_PAGE}&page=${page}`,
    {
      headers: {
        Authorization: `Bearer ${env.GH_API_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'mailer',
      },
    },
  );
  if (response.status === 422) throw new HttpError(400, 'GitHub did not understand that search query.');
  if (response.status === 401) throw new HttpError(400, 'GH_API_TOKEN was rejected by GitHub. Check the secret.');
  if (response.status === 403 || response.status === 429) {
    // GitHub says how long to back off for, either directly or as when its rate-limit window resets.
    const retryAfter = Number(response.headers.get('retry-after'));
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    const seconds = retryAfter || (reset ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : 60);
    throw new HttpError(429, 'GitHub is rate-limiting these searches.', { retry_after: seconds });
  }
  if (!response.ok) throw new HttpError(502, `GitHub search failed (HTTP ${response.status}).`);
  const data = await response.json();

  const seen = new Set();
  const rows = [];
  for (const item of data.items ?? []) {
    const email = cleanEmail(item.commit?.author?.email);
    if (!email || !ALLOWED_DOMAINS.test(email) || LOOKS_GENERATED.test(email.split('@')[0]) || seen.has(email)) continue;
    seen.add(email);
    rows.push({
      name: String(item.commit?.author?.name ?? '').trim(),
      email,
      login: item.author?.login ?? '',
      url: item.author?.html_url ?? '',
    });
  }
  // GitHub reports the true match count here even though it only lets us page through the first
  // 1000: that is how the caller knows a query needs to be split into narrower ones to get the rest.
  const total = data.total_count ?? 0;
  const reachable = Math.min(total, MAX_PAGE * PER_PAGE);
  // How much of GitHub's own quota is left, so the browser can slow down before it runs out
  // instead of only finding out by being refused.
  const rateRemaining = Number(response.headers.get('x-ratelimit-remaining'));
  const rateReset = Number(response.headers.get('x-ratelimit-reset'));
  return {
    rows,
    page,
    has_more: page < MAX_PAGE && page * PER_PAGE < reachable,
    total,
    truncated: total > MAX_PAGE * PER_PAGE,
    rate_remaining: Number.isFinite(rateRemaining) ? rateRemaining : null,
    rate_reset: Number.isFinite(rateReset) ? rateReset : null,
  };
}
