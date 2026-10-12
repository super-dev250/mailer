// Filtering rules shared by every contact-finding source (GitHub commits, Slack messages, …):
// what counts as a real, reachable address, and which profile locations to leave out.

// Only the well-known public webmail providers: a real, checkable inbox someone actually reads,
// as opposed to a corporate, institutional, bot or placeholder address.
export const ALLOWED_DOMAINS = new RegExp(
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
export const LOOKS_GENERATED = /[0-9a-f]{24,}/i;

// An email address carries no country information at all, so the only signal available is
// whatever free-text location a person optionally put on their own profile (GitHub bio, Slack
// timezone label, …). It is often blank, sometimes made up, and never verified, so this can only
// ever be a best-effort filter, not a reliable one. A profile with no location, or one this list
// fails to recognise, is kept, not excluded.
export const EXCLUDED_LOCATIONS = new RegExp(
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
      "côte d'ivoire", 'ivory coast', 'kenya', 'lesotho', 'liberia', 'libya', 'madagascar', 'malawi', 'mali',
      'mauritania', 'mauritius', 'morocco', 'mozambique', 'namibia', 'niger', 'nigeria', 'rwanda', 'sao tome',
      'senegal', 'seychelles', 'sierra leone', 'somalia', 'south africa', 'south sudan', 'sudan', 'tanzania',
      'togo', 'tunisia', 'uganda', 'zambia', 'zimbabwe',
    ].join('|') +
    ')\\b',
  'i',
);
