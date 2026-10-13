// Finds public contact details on GitHub by searching the user base, not raw commit history: a
// commit-history scan revisits the same prolific author's commits over and over as it walks
// through time, burning the scarce search quota on people it already found without surfacing
// anyone new. Each candidate user is resolved to at most one email lookup: first for free from
// their public profile (a different, far more generous rate limit), and only when that is not
// set, one single targeted commit search — never more than one commit lookup per person.
// Needs the optional GH_API_TOKEN secret, because GitHub only allows this kind of search when signed in.

import { cleanEmail } from '../public/shared/email.js';
import { ALLOWED_DOMAINS, LOOKS_GENERATED } from './emailFilters.js';
import { check, HttpError } from './http.js';

const PER_PAGE = 100;
const MAX_PAGE = 10; // GitHub's search API returns at most 1000 results for one query: 10 pages of 100.
// One Worker invocation gets a limited number of outgoing requests. This leaves headroom for the
// user-search request itself plus the commit-search fallbacks below, so a page with unusually
// many candidates degrades to "not all of them resolved this page" instead of failing outright.
const MAX_RESOLUTIONS = 40;
// Resolving a profile's public email is free (a different, generous rate limit). Falling back to
// a commit search is not: it shares the same scarce quota as the listing request itself, so only
// a few of those happen per page, keeping most of that quota free for covering more of the user base.
const MAX_COMMIT_FALLBACKS = 8;

async function githubFetch(env, url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${env.GH_API_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mailer',
    },
  });
  return response;
}

function ok(email) {
  return email && ALLOWED_DOMAINS.test(email) && !LOOKS_GENERATED.test(email.split('@')[0]) ? email : '';
}

// The public email on a GitHub profile, if the person chose to set one. Most have not, which is
// exactly why this is tried first: it costs nothing against the scarce search quota either way.
async function profileContact(env, login) {
  try {
    const response = await githubFetch(env, `https://api.github.com/users/${encodeURIComponent(login)}`);
    if (!response.ok) return null;
    const { email, name } = await response.json();
    const clean = ok(cleanEmail(email));
    return clean ? { name: String(name ?? '').trim(), email: clean } : null;
  } catch {
    return null;
  }
}

// The one commit this person's login is allowed to cost: their most recent, nothing more. A
// prolific committer is worth exactly the same one email as someone with a single commit.
async function commitContact(env, login) {
  try {
    const q = `author:${login}`;
    const response = await githubFetch(
      env,
      `https://api.github.com/search/commits?q=${encodeURIComponent(q)}&per_page=1&page=1&sort=author-date&order=desc`,
    );
    if (!response.ok) return null;
    const { items } = await response.json();
    const clean = ok(cleanEmail(items?.[0]?.commit?.author?.email));
    return clean ? { name: String(items[0].commit?.author?.name ?? '').trim(), email: clean } : null;
  } catch {
    return null;
  }
}

export const canScrape = (env) => Boolean(env.GH_API_TOKEN);

export async function search({ env, body }) {
  check(canScrape(env), 400, 'Finding GitHub contacts needs the optional GH_API_TOKEN secret. See the README.');
  const input = await body();
  const query = String(input.query ?? '').trim();
  check(query, 400, 'Enter a search query.');
  const page = Math.min(MAX_PAGE, Math.max(1, Math.round(Number(input.page)) || 1));

  const response = await githubFetch(
    env,
    `https://api.github.com/search/users?q=${encodeURIComponent(query)}&per_page=${PER_PAGE}&page=${page}`,
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

  const candidates = (data.items ?? []).slice(0, MAX_RESOLUTIONS);
  let fallbacksLeft = MAX_COMMIT_FALLBACKS;
  const rows = (
    await Promise.all(
      candidates.map(async (user) => {
        const login = user.login ?? '';
        if (!login) return null;
        let contact = await profileContact(env, login);
        if (!contact && fallbacksLeft > 0) {
          fallbacksLeft--;
          contact = await commitContact(env, login);
        }
        return contact ? { ...contact, login, url: user.html_url ?? '' } : null;
      }),
    )
  ).filter(Boolean);
  // One login can only ever appear once in one page of user search results, but two different
  // logins can share one email (a work and a personal account, say): still only counted once.
  const seen = new Set();
  const unique = rows.filter((row) => (seen.has(row.email) ? false : seen.add(row.email)));

  // GitHub reports the true match count here even though it only lets us page through the first
  // 1000: that is how the caller knows a query needs to be split into narrower ones to get the rest.
  const total = data.total_count ?? 0;
  const reachable = Math.min(total, MAX_PAGE * PER_PAGE);
  // How much of GitHub's own quota is left, so the browser can slow down before it runs out
  // instead of only finding out by being refused.
  const rateRemaining = Number(response.headers.get('x-ratelimit-remaining'));
  const rateReset = Number(response.headers.get('x-ratelimit-reset'));
  return {
    rows: unique,
    page,
    has_more: page < MAX_PAGE && page * PER_PAGE < reachable,
    total,
    truncated: total > MAX_PAGE * PER_PAGE,
    rate_remaining: Number.isFinite(rateRemaining) ? rateRemaining : null,
    rate_reset: Number.isFinite(rateReset) ? rateReset : null,
  };
}
