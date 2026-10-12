// Turns an Excel or CSV file into contacts. Runs entirely in the browser.

import { fieldKey } from '/shared/email.js';
import { loadScript } from './load.js';

// Also finds the address inside cells such as "Lee Carter <lee@example.com>".
const EMAIL = /[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']+/;

/** Reads the first sheet of a file into { headers, lines }, every cell as trimmed text. */
export async function readTable(file) {
  await loadScript('/vendor/xlsx.js');
  const { read, utils } = window.XLSX;
  // codepage 65001 reads CSV files that carry no encoding mark as UTF-8, so accented names survive.
  const book = read(await file.arrayBuffer(), { type: 'array', raw: true, codepage: 65001 });
  const sheet = book.Sheets[book.SheetNames[0]];
  const grid = utils
    .sheet_to_json(sheet, { header: 1, defval: '', blankrows: false, raw: false })
    .map((line) => line.map((cell) => String(cell).trim()));
  if (!grid.length) throw new Error('That file has no rows.');

  // A first row with no email address in it is a header row.
  const hasHeader = !grid[0].some((cell) => EMAIL.test(cell));
  const width = grid.reduce((max, line) => Math.max(max, line.length), 0);
  const headers = Array.from({ length: width }, (_, i) => (hasHeader && grid[0][i]) || `Column ${i + 1}`);
  return { headers, lines: hasHeader ? grid.slice(1) : grid };
}

/** Best guess at which columns hold the email address and the name. -1 means none. */
export function guessColumns({ headers, lines }) {
  const sample = lines.slice(0, 50);
  const hits = headers.map((_, i) => sample.filter((line) => EMAIL.test(line[i] ?? '')).length);
  const email = hits.indexOf(Math.max(...hits));
  const keys = headers.map(fieldKey);
  let name = keys.findIndex((key) => /^(full_?)?name$/.test(key));
  if (name < 0) name = keys.findIndex((key, i) => i !== email && key.includes('name') && !/first|last|user|company|file/.test(key));
  return { email, name };
}

/** Builds the contacts to import, leaving out rows without a usable address and repeats. */
export function toContacts({ headers, lines }, columns) {
  const keys = headers.map(fieldKey);
  const seen = new Set();
  const contacts = [];
  let invalid = 0;
  let repeated = 0;
  for (const line of lines) {
    const email = (line[columns.email] ?? '').match(EMAIL)?.[0].toLowerCase();
    if (!email) invalid++;
    else if (seen.has(email)) repeated++;
    else {
      seen.add(email);
      // Every other column is kept as a field that emails can be personalised with.
      const fields = {};
      keys.forEach((key, i) => {
        if (key && i !== columns.email && i !== columns.name && line[i]) fields[key] = line[i];
      });
      const fromParts = [fields.first_name ?? fields.firstname, fields.last_name ?? fields.lastname].filter(Boolean).join(' ');
      contacts.push({ email, name: (columns.name >= 0 && line[columns.name]) || fromParts, fields });
    }
  }
  return { contacts, invalid, repeated };
}
