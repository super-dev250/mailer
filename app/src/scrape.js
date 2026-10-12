// Finds public contact details on GitHub: given a search query, looks through commit history
// for the name and email people committed with, alongside their GitHub login and profile URL.
// Needs the optional GH_API_TOKEN secret, because GitHub only allows commit search when signed in.

import { cleanEmail } from '../public/shared/email.js';
import { check, HttpError } from './http.js';

// Only the well-known public webmail providers: a real, checkable inbox someone actually reads,
// as opposed to a corporate, institutional, bot or placeholder address (git never validates a
// commit's author email, so those are common, and many are not reachable at all).
const ALLOWED_DOMAINS = new RegExp(
  '@(' +
    [
      'gmail\\.com',
      'googlemail\\.com',
      'outlook\\.(?:com|[a-z]{2,3})',
      'hotmail\\.(?:com|[a-z]{2,3})',
      'live\\.com',
      'msn\\.com',
      'yahoo\\.(?:com|co\\.[a-z]{2}|[a-z]{2,3})',
      'ymail\\.com',
      'rocketmail\\.com',
      'icloud\\.com',
      'me\\.com',
      'mac\\.com',
      'aol\\.com',
      'protonmail\\.(?:com|ch)',
      'proton\\.me',
      'gmx\\.(?:com|net|de)',
      'mail\\.com',
      'zoho\\.com',
      'yandex\\.(?:com|ru)',
      'qq\\.com',
      '163\\.com',
      '126\\.com',
      'naver\\.com',
      'fastmail\\.com',
      'hey\\.com',
    ].join('|') +
    ')$',
  'i',
);
// Some tools (anonymizers, migration scripts, bots) generate placeholder addresses using a long
// hash or token as the local part — e.g. "user.480d270fe8f46b...@gmail.com" — on a real provider
// domain, but nobody reads it. A run of 24+ hex characters is never something a person typed.
const LOOKS_GENERATED = /[0-9a-f]{24,}/i;
const PER_PAGE = 100;
const MAX_PAGE = 10; // GitHub's search API returns at most 1000 results for one query: 10 pages of 100.

// An email address carries no country information at all, so this is the only signal available:
// the free-text "location" a person optionally typed into their own GitHub profile. It is often
// blank, sometimes made up, and never verified by GitHub, so this can only ever be a best-effort
// filter, not a reliable one. A profile with no location, or one this list fails to recognise,
// is kept, not excluded — most GitHub profiles never set a location at all.
const EXCLUDED_LOCATIONS = new RegExp(
  '\\b(' +
    [
      'asia',
      'africa',
      // Asia
      'afghanistan', 'armenia', 'azerbaijan', 'bahrain', 'bangladesh', 'bhutan', 'brunei', 'cambodia', 'china',
      'cyprus', 'georgia', 'india', 'indonesia', 'iran', 'iraq', 'israel', 'japan', 'jordan', 'kazakhstan',
      'kuwait', 'kyrgyzstan', 'laos', 'lebanon', 'malaysia', 'maldives', 'mongolia', 'myanmar', 'burma', 'nepal',
      'north korea', 'oman', 'pakistan', 'palestine', 'philippines', 'qatar', 'saudi arabia', 'singapore',
      'south korea', '\\bkorea\\b', 'sri lanka', 'syria', 'taiwan', 'tajikistan', 'thailand', 'timor-leste',
      'turkey', 'turkiye', 'turkmenistan', 'u\\.?a\\.?e\\.?', 'united arab emirates', 'uzbekistan', 'vietnam',
      'yemen', 'hong kong', 'macau',
      // Africa
      'algeria', 'angola', 'benin', 'botswana', 'burkina faso', 'burundi', 'cabo verde', 'cape verde', 'cameroon',
      'central african republic', 'chad', 'comoros', 'congo', 'djibouti', 'egypt', 'equatorial guinea', 'eritrea',
      'eswatini', 'swaziland', 'ethiopia', 'gabon', 'gambia', 'ghana', 'guinea-bissau', 'guinea', "cote d'ivoire",
      "c\\u00f4te d'ivoire", 'ivory coast', 'kenya', 'lesotho', 'liberia', 'libya', 'madagascar', 'malawi', 'mali',
      'mauritania', 'mauritius', 'morocco', 'mozambique', 'namibia', 'niger', 'nigeria', 'rwanda', 'sao tome',
      'senegal', 'seychelles', 'sierra leone', 'somalia', 'south africa', 'south sudan', 'sudan', 'tanzania',
      'togo', 'tunisia', 'uganda', 'zambia', 'zimbabwe',
    ].join('|') +
    ')\\b',
  'i',
);
// One Worker invocation gets a limited number of outgoing requests; this leaves headroom for the
// search request itself plus a safety margin, so a page with unusually many distinct authors
// degrades to "not all of them checked" instead of failing outright.
const MAX_LOCATION_LOOKUPS = 40;

async function excludedLocations(env, logins) {
  const unique = [...new Set(logins)].slice(0, MAX_LOCATION_LOOKUPS);
  const excluded = new Set();
  await Promise.all(
    unique.map(async (login) => {
      try {
        const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
          headers: {
            Authorization: `Bearer ${env.GH_API_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'mailer',
          },
        });
        if (!response.ok) return; // unknown: kept, not excluded
        const { location } = await response.json();
        if (location && EXCLUDED_LOCATIONS.test(location)) excluded.add(login);
      } catch {
        // Unknown: kept, not excluded.
      }
    }),
  );
  return excluded;
}

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
  let rows = [];
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
  const excluded = await excludedLocations(env, rows.filter((row) => row.login).map((row) => row.login));
  if (excluded.size) rows = rows.filter((row) => !excluded.has(row.login));
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
