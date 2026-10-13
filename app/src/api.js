// Everything the web app calls. All of it requires the app secret.

import { PART_BYTES, attachmentProblem, partsFor } from '../public/shared/attachments.js';
import { cleanEmail, extractLinks, fieldKey } from '../public/shared/email.js';
import { check } from './http.js';
import { DEFAULT_MAILBOX_PACE, DEFAULT_SETTINGS, getValues, now, setValue } from './db.js';
import { canDispatch, dispatch } from './github.js';
import { canScrape } from './scrape.js';
import { canScrape as canScrapeSlack } from './slack.js';

const PAGE_SIZE = 50;
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };
const MAX_IMAGE_BASE64 = 1_900_000; // D1 holds at most 2 MB in one value

// A contact a new campaign may email: active, never emailed before, and not already
// waiting in another campaign. Nobody gets a campaign email twice.
const AVAILABLE = `status = 'active' AND last_emailed_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM messages m WHERE m.contact_id = contacts.id AND m.is_test = 0 AND m.status IN ('queued', 'sending'))`;

const text = (value, max) => String(value ?? '').slice(0, max);
const whole = (value, min, max, fallback) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};
const page = (query) => ({
  limit: whole(query.get('limit') ?? PAGE_SIZE, 1, 500, PAGE_SIZE),
  offset: whole(query.get('offset') ?? 0, 0, Number.MAX_SAFE_INTEGER, 0),
});

// null means "everyone available"; otherwise a positive whole number of contacts to queue.
function parseSendLimit(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.round(Number(value));
  check(Number.isInteger(n) && n > 0, 400, 'How many to send must be a positive whole number, or left blank for everyone available.');
  return n;
}

// null means "not chosen yet" — resolved automatically at send time if there is exactly one
// mailbox. Whether this id still refers to a real, active mailbox is checked then, not here,
// the same way a chosen `list` is not checked against existing lists until it matters.
function parseMailboxId(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.round(Number(value));
  check(Number.isInteger(n) && n > 0, 400, 'That is not a valid mailbox.');
  return n;
}

// ---- Overview and settings ----

export async function overview({ db, env }) {
  const [values, lists, mailboxes] = await Promise.all([
    getValues(db),
    db
      .prepare(
        `SELECT list, COUNT(*) AS total, SUM(status = 'active') AS active, SUM(${AVAILABLE}) AS available
         FROM contacts GROUP BY list ORDER BY list`,
      )
      .all(),
    db
      .prepare(
        `SELECT id, email, name, sender_name, batch_size, delay_seconds, daily_limit, status, last_run, created_at
         FROM mailboxes ORDER BY id`,
      )
      .all(),
  ]);
  return {
    settings: { ...DEFAULT_SETTINGS, ...values.settings },
    lists: lists.results,
    mailboxes: mailboxes.results.map((row) => ({ ...row, last_run: row.last_run ? JSON.parse(row.last_run) : null })),
    github: { repo: env.GITHUB_REPO ?? '', can_dispatch: canDispatch(env) },
    scraper: { can_scrape: canScrape(env) },
    slack: { can_scrape: canScrapeSlack(env) },
  };
}

export async function saveSettings({ db, body }) {
  const input = await body();
  const settings = {
    footer: Boolean(input.footer),
    postal_address: text(input.postal_address, 300).trim(),
    unsubscribe_text: text(input.unsubscribe_text, 100).trim() || DEFAULT_SETTINGS.unsubscribe_text,
    // The Worker's cron ticks every 5 minutes, so anything finer than that cannot actually happen.
    run_every_minutes: whole(input.run_every_minutes, 5, 1440, DEFAULT_SETTINGS.run_every_minutes),
    track_opens: Boolean(input.track_opens),
    track_clicks: Boolean(input.track_clicks),
  };
  await setValue(db, 'settings', settings).run();
  return { settings };
}

export async function runNow({ env }) {
  check(canDispatch(env), 400, 'Starting a run from here needs the optional DISPATCH_TOKEN secret. See the README.');
  await dispatch(env);
  return { started: true };
}

// ---- Mailboxes ----
// Each Gmail account the app can send from: its own pace (so one account's reputation never
// affects another's) and its own sender name. A campaign sends through exactly one.

const PACE_BOUNDS = { batch_size: [1, 500], delay_seconds: [1, 120], daily_limit: [1, 2000] };
const mailboxPace = (input, fallback) =>
  Object.fromEntries(Object.entries(PACE_BOUNDS).map(([key, [min, max]]) => [key, whole(input[key], min, max, fallback[key])]));

export async function createMailbox({ db, body }) {
  const input = await body();
  const email = cleanEmail(text(input.email, 300));
  check(email, 400, 'Enter the Gmail address for this mailbox.');
  const pace = mailboxPace(input, DEFAULT_MAILBOX_PACE);
  const row = await db
    .prepare(
      `INSERT INTO mailboxes (email, name, sender_name, batch_size, delay_seconds, daily_limit, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?) RETURNING id`,
    )
    .bind(
      email,
      text(input.name, 100).trim() || email,
      text(input.sender_name, 100).trim(),
      pace.batch_size,
      pace.delay_seconds,
      pace.daily_limit,
      now(),
    )
    .first()
    .catch((error) => {
      check(!String(error.message).includes('UNIQUE'), 409, 'A mailbox with that address already exists.');
      throw error;
    });
  return { id: row.id };
}

export async function updateMailbox({ db, params, body }) {
  const id = idOf(params.id, 'Mailbox');
  const existing = await db.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(id).first();
  check(existing, 404, 'Mailbox not found.');
  const input = await body();
  const pace = mailboxPace(input, existing);
  const status = ['active', 'paused'].includes(input.status) ? input.status : existing.status;
  // Each field is only touched when given, so a Pause/Resume click (which sends just `status`)
  // leaves the rest exactly as they were.
  const name = input.name !== undefined ? text(input.name, 100).trim() || existing.email : existing.name;
  const senderName = input.sender_name !== undefined ? text(input.sender_name, 100).trim() : existing.sender_name;
  await db
    .prepare('UPDATE mailboxes SET name = ?, sender_name = ?, batch_size = ?, delay_seconds = ?, daily_limit = ?, status = ? WHERE id = ?')
    .bind(name, senderName, pace.batch_size, pace.delay_seconds, pace.daily_limit, status, id)
    .run();
  return { ok: true };
}

export async function deleteMailbox({ db, params }) {
  const id = idOf(params.id, 'Mailbox');
  const active = await db
    .prepare(`SELECT 1 FROM campaigns WHERE mailbox_id = ? AND status IN ('sending', 'paused') LIMIT 1`)
    .bind(id)
    .first();
  check(!active, 409, 'This mailbox has a campaign still sending or paused. Finish, pause-and-delete, or reassign it first.');
  const result = await db.prepare('DELETE FROM mailboxes WHERE id = ?').bind(id).run();
  check(result.meta.changes, 404, 'Mailbox not found.');
  return { ok: true };
}

// ---- Contacts ----

function contactFilter(query) {
  const where = [];
  const args = [];
  const search = (query.get('q') ?? '').trim();
  if (search) {
    where.push('(email LIKE ? OR name LIKE ?)');
    args.push(`%${search}%`, `%${search}%`);
  }
  if (query.has('list')) {
    where.push('list = ?');
    args.push(query.get('list'));
  }
  const status = query.get('status');
  if (status === 'new') where.push('last_emailed_at IS NULL');
  else if (status === 'emailed') where.push('last_emailed_at IS NOT NULL');
  else if (status) {
    where.push('status = ?');
    args.push(status);
  }
  return { where: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

export async function listContacts({ db, url }) {
  const { where, args } = contactFilter(url.searchParams);
  const { limit, offset } = page(url.searchParams);
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT id, email, name, fields, list, status, created_at, last_emailed_at
         FROM contacts ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...args, limit, offset),
    db.prepare(`SELECT COUNT(*) AS n FROM contacts ${where}`).bind(...args),
  ]);
  return {
    rows: rows.results.map((row) => ({ ...row, fields: JSON.parse(row.fields) })),
    total: total.results[0].n,
  };
}

// Extra spreadsheet columns become merge fields, stored under their merge-tag name.
function cleanFields(fields) {
  const entries = Object.entries(fields ?? {})
    .map(([label, value]) => [fieldKey(label), text(value, 500).trim()])
    .filter(([key, value]) => key && value)
    .slice(0, 40);
  return JSON.stringify(Object.fromEntries(entries));
}

// A contact that already exists is left untouched, so importing the same file twice is harmless
// and a new list only ever holds people who were not contacted through an earlier one.
export async function importContacts({ db, body }) {
  const { list, rows } = await body();
  check(Array.isArray(rows) && rows.length <= 1000, 400, 'Send at most 1000 contacts at a time.');
  const valid = [];
  for (const row of rows) {
    const email = cleanEmail(text(row?.email, 300));
    if (email && email.length <= 254) valid.push({ email, name: text(row.name, 200).trim(), fields: cleanFields(row.fields) });
  }
  let added = 0;
  if (valid.length) {
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO contacts (email, name, fields, list, created_at)
         SELECT value ->> 'email', value ->> 'name', value ->> 'fields', ?2, ?3 FROM json_each(?1)`,
      )
      .bind(JSON.stringify(valid), text(list, 100).trim(), now())
      .run();
    added = result.meta.changes;
  }
  return { added, existing: valid.length - added, invalid: rows.length - valid.length };
}

/** Which of these addresses are contacts already. The import screen leaves them out before importing. */
export async function existingContacts({ db, body }) {
  const { emails } = await body();
  check(Array.isArray(emails) && emails.length <= 1000, 400, 'Check at most 1000 addresses at a time.');
  const { results } = await db
    .prepare('SELECT email FROM contacts WHERE email IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(emails.map(cleanEmail).filter(Boolean)))
    .all();
  return { existing: results.map((row) => row.email) };
}

function contactSelection(input) {
  if (Array.isArray(input.ids)) return { where: 'id IN (SELECT value FROM json_each(?))', args: [JSON.stringify(input.ids)] };
  if (input.all === true) return { where: '1 = 1', args: [] };
  check(typeof input.list === 'string', 400, 'Choose the contacts to change.');
  return { where: 'list = ?', args: [input.list] };
}

export async function deleteContacts({ db, body }) {
  const { where, args } = contactSelection(await body());
  // Counted from the returned rows: the change count would also include the messages
  // that the delete detaches from these contacts.
  const { results } = await db.prepare(`DELETE FROM contacts WHERE ${where} RETURNING id`).bind(...args).all();
  return { deleted: results.length };
}

export async function setContactStatus({ db, body }) {
  const input = await body();
  check(['active', 'unsubscribed'].includes(input.status), 400, 'Unknown status.');
  const { where, args } = contactSelection(input);
  const result = await db.prepare(`UPDATE contacts SET status = ? WHERE ${where}`).bind(input.status, ...args).run();
  return { changed: result.meta.changes };
}

// ---- Campaigns ----

// "sent" counts every email that left, including the ones that later bounced.
const STATS = `
  COUNT(*) AS total,
  SUM(status IN ('queued', 'sending')) AS pending,
  SUM(status IN ('sent', 'bounced')) AS sent,
  SUM(status = 'sent' AND delivered_at IS NOT NULL) AS delivered,
  SUM(status = 'sent' AND opened_at IS NOT NULL) AS opened,
  SUM(status = 'sent' AND clicked_at IS NOT NULL) AS clicked,
  SUM(status = 'sent' AND replied_at IS NOT NULL) AS replied,
  SUM(status = 'bounced') AS bounced,
  SUM(status IN ('failed', 'skipped')) AS failed,
  SUM(unsubscribed_at IS NOT NULL) AS unsubscribed`;

// The same groups, as filters for the recipient table.
const STAGES = {
  pending: `m.status IN ('queued', 'sending')`,
  sent: `m.status IN ('sent', 'bounced')`,
  delivered: `m.status = 'sent' AND m.delivered_at IS NOT NULL`,
  opened: `m.status = 'sent' AND m.opened_at IS NOT NULL`,
  clicked: `m.status = 'sent' AND m.clicked_at IS NOT NULL`,
  replied: `m.status = 'sent' AND m.replied_at IS NOT NULL`,
  bounced: `m.status = 'bounced'`,
  failed: `m.status IN ('failed', 'skipped')`,
  unsubscribed: `m.unsubscribed_at IS NOT NULL`,
};

// SUM() over no rows is NULL.
const counts = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value ?? 0]));
const NO_STATS = counts({
  total: 0, pending: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0, failed: 0, unsubscribed: 0,
});

// An image that was never uploaded: mail apps would show nothing in its place.
const hasInlineImage = (html) => /src\s*=\s*["'](data|blob):/i.test(html);
const isBlank = (html) => !html.replace(/<(?!img\b)[^>]*>|&nbsp;|\s/g, '');

const LOCKED = 'Pause this campaign to change its content, or duplicate it to change it without pausing.';
// Content can be changed while nothing is actively being sent: a draft, or a campaign paused
// mid-way through. Recipients already sent to keep what they got; anyone not yet sent to gets
// whatever the content is at the moment their email actually goes out.
const canEditContent = (status) => status === 'draft' || status === 'paused';

function idOf(value, what) {
  const id = Number(value);
  check(Number.isInteger(id), 404, `${what} not found.`);
  return id;
}
const campaignId = (params) => idOf(params.id, 'Campaign');

async function loadCampaign(db, params) {
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(campaignId(params)).first();
  check(campaign, 404, 'Campaign not found.');
  return campaign;
}

// A campaign's attached files. A file is complete once all of its parts are stored.
async function loadAttachments(db, id) {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.name, a.type, a.size, a.parts,
         (SELECT COUNT(*) FROM attachment_parts p WHERE p.attachment_id = a.id) AS stored
       FROM attachments a WHERE a.campaign_id = ? ORDER BY a.id`,
    )
    .bind(id)
    .all();
  return results.map(({ stored, ...file }) => ({ ...file, complete: stored === file.parts }));
}

// The mailbox a campaign sends from, resolved once: if one was chosen, it must still exist and
// be active; otherwise, with exactly one mailbox in the whole app, that one is picked automatically
// and recorded, so a single-mailbox setup never needs to think about this. More than one mailbox
// (or none at all) needs an explicit choice.
async function resolveMailbox(db, campaign) {
  if (campaign.mailbox_id) {
    const mailbox = await db.prepare('SELECT * FROM mailboxes WHERE id = ?').bind(campaign.mailbox_id).first();
    check(mailbox, 400, 'The mailbox this campaign sends from no longer exists. Choose another in Mailboxes.');
    check(mailbox.status === 'active', 400, `The "${mailbox.name}" mailbox is paused. Resume it in Mailboxes, or choose another.`);
    return mailbox;
  }
  const { results } = await db.prepare(`SELECT * FROM mailboxes WHERE status = 'active'`).all();
  check(results.length > 0, 400, 'Add a mailbox first, in Mailboxes.');
  check(results.length === 1, 400, 'Choose which mailbox this campaign sends from, in Mailboxes.');
  await db.prepare('UPDATE campaigns SET mailbox_id = ? WHERE id = ?').bind(results[0].id, campaign.id).run();
  campaign.mailbox_id = results[0].id;
  return results[0];
}

async function checkSendable(db, campaign) {
  check(campaign.subject.trim(), 400, 'Add a subject line first.');
  check(!isBlank(campaign.body_html), 400, 'The email has no content yet.');
  check(!hasInlineImage(campaign.body_html), 400, 'An image is still uploading. Wait a moment and try again.');
  const files = await loadAttachments(db, campaign.id);
  check(files.every((file) => file.complete), 400, 'An attachment did not finish uploading. Remove it and attach it again.');
  await resolveMailbox(db, campaign);
}

export async function listCampaigns({ db }) {
  const [campaigns, stats] = await db.batch([
    db.prepare('SELECT id, name, subject, list, status, created_at, started_at, finished_at FROM campaigns ORDER BY id DESC'),
    db.prepare(`SELECT campaign_id, ${STATS} FROM messages WHERE is_test = 0 GROUP BY campaign_id`),
  ]);
  const byCampaign = new Map(stats.results.map(({ campaign_id, ...row }) => [campaign_id, counts(row)]));
  return {
    campaigns: campaigns.results.map((campaign) => ({ ...campaign, stats: byCampaign.get(campaign.id) ?? NO_STATS })),
  };
}

export async function createCampaign({ db, body }) {
  const { copy_of: sourceId } = await body();
  const source = sourceId ? await loadCampaign(db, { id: sourceId }) : null;
  const row = await db
    .prepare(
      `INSERT INTO campaigns (name, subject, preheader, body_html, list, links, send_limit, mailbox_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      source ? `${source.name} (copy)` : 'Untitled campaign',
      source?.subject ?? '',
      source?.preheader ?? '',
      source?.body_html ?? '',
      source?.list ?? '',
      source?.links ?? '[]',
      source?.send_limit ?? null,
      source?.mailbox_id ?? null,
      now(),
    )
    .first();
  // A copy carries the same files. The parts are copied inside the database.
  for (const file of source ? await loadAttachments(db, source.id) : []) {
    const copy = await db
      .prepare('INSERT INTO attachments (campaign_id, name, type, size, parts, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(row.id, file.name, file.type, file.size, file.parts, now())
      .first();
    await db
      .prepare('INSERT INTO attachment_parts (attachment_id, part, data) SELECT ?, part, data FROM attachment_parts WHERE attachment_id = ?')
      .bind(copy.id, file.id)
      .run();
  }
  return { id: row.id };
}

export async function getCampaign({ db, params }) {
  const campaign = await loadCampaign(db, params);
  const stats = await db
    .prepare(`SELECT ${STATS} FROM messages WHERE campaign_id = ? AND is_test = 0`)
    .bind(campaign.id)
    .first();
  return {
    campaign: { ...campaign, links: JSON.parse(campaign.links) },
    attachments: await loadAttachments(db, campaign.id),
    stats: counts(stats),
  };
}

// Clicks per link, not just in total: how many times, and by how many distinct recipients.
export async function campaignLinkStats({ db, params }) {
  const campaign = await loadCampaign(db, params);
  const { results } = await db
    .prepare(
      `SELECT link_index, COUNT(*) AS clicks, COUNT(DISTINCT message_id) AS clickers
       FROM link_clicks WHERE campaign_id = ? GROUP BY link_index`,
    )
    .bind(campaign.id)
    .all();
  const byIndex = new Map(results.map((row) => [row.link_index, row]));
  const links = JSON.parse(campaign.links).map((url, index) => ({
    url,
    clicks: byIndex.get(index)?.clicks ?? 0,
    clickers: byIndex.get(index)?.clickers ?? 0,
  }));
  return { links };
}

export async function updateCampaign({ db, params, body }) {
  const campaign = await loadCampaign(db, params);
  check(canEditContent(campaign.status), 409, LOCKED);
  const input = await body();
  const html = text(input.body_html, 500_000);
  // The audience, how many of it to queue, and which mailbox sends it were already fixed when the
  // campaign started: that happens once, at start, so changing any of them afterwards would be
  // misleading rather than useful.
  const list = campaign.status === 'draft' ? text(input.list, 100) : campaign.list;
  const sendLimit = campaign.status === 'draft' ? parseSendLimit(input.send_limit) : campaign.send_limit;
  const mailboxId = campaign.status === 'draft' && input.mailbox_id !== undefined ? parseMailboxId(input.mailbox_id) : campaign.mailbox_id;
  await db
    .prepare(
      'UPDATE campaigns SET name = ?, subject = ?, preheader = ?, body_html = ?, list = ?, links = ?, send_limit = ?, mailbox_id = ? WHERE id = ?',
    )
    .bind(
      text(input.name, 120).trim() || 'Untitled campaign',
      text(input.subject, 300),
      text(input.preheader, 300),
      html,
      list,
      JSON.stringify(extractLinks(html)),
      sendLimit,
      mailboxId,
      campaign.id,
    )
    .run();
  return { ok: true };
}

export async function deleteCampaign({ db, params }) {
  const id = campaignId(params);
  await db.batch([
    db.prepare('DELETE FROM messages WHERE campaign_id = ?').bind(id),
    db.prepare('DELETE FROM attachment_parts WHERE attachment_id IN (SELECT id FROM attachments WHERE campaign_id = ?)').bind(id),
    db.prepare('DELETE FROM attachments WHERE campaign_id = ?').bind(id),
    db.prepare('DELETE FROM campaigns WHERE id = ?').bind(id),
  ]);
  return { ok: true };
}

// Fixes the recipients: one queued message per contact in the audience who was never emailed.
export async function startCampaign({ db, env, params }) {
  const campaign = await loadCampaign(db, params);
  check(campaign.status === 'draft', 409, 'This campaign has already started.');
  await checkSendable(db, campaign);
  const audience = `(?1 = '' OR list = ?1) AND ${AVAILABLE}`;
  const size = await db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE ${audience}`).bind(campaign.list).first('n');
  check(size > 0, 400, 'Everyone in this audience has already been emailed, or is waiting in another campaign.');
  // A cap queues only the first part of the audience (oldest contacts first); the rest stays
  // available, for this campaign's content to be duplicated into a later one, or for other campaigns.
  const queued = campaign.send_limit ? Math.min(campaign.send_limit, size) : size;

  const stamp = now();
  await db.batch([
    db.prepare(`UPDATE campaigns SET status = 'sending', started_at = ? WHERE id = ?`).bind(stamp, campaign.id),
    db
      .prepare(
        `INSERT INTO messages (campaign_id, contact_id, email, token, queued_at)
         SELECT ?2, id, email, lower(hex(randomblob(12))), ?3 FROM contacts WHERE ${audience} ORDER BY id LIMIT ?4`,
      )
      .bind(campaign.list, campaign.id, stamp, queued),
  ]);
  return { queued, started: await dispatch(env).catch(() => false) };
}

const changeStatus = (from, to) => async ({ db, env, params }) => {
  const result = await db
    .prepare('UPDATE campaigns SET status = ? WHERE id = ? AND status = ?')
    .bind(to, campaignId(params), from)
    .run();
  check(result.meta.changes, 409, 'The campaign is not in a state that allows this.');
  return { started: to === 'sending' && (await dispatch(env).catch(() => false)) };
};
export const pauseCampaign = changeStatus('sending', 'paused');

// Content can change while paused, so this is checked again here: resuming with, say, no subject
// or an image still uploading would otherwise only be caught once sending actually failed.
export async function resumeCampaign({ db, env, params }) {
  const campaign = await loadCampaign(db, params);
  check(campaign.status === 'paused', 409, 'The campaign is not in a state that allows this.');
  await checkSendable(db, campaign);
  await db.prepare(`UPDATE campaigns SET status = 'sending' WHERE id = ?`).bind(campaign.id).run();
  return { started: await dispatch(env).catch(() => false) };
}

// A test goes through exactly the same path as a real email, to one address, outside the statistics.
export async function testCampaign({ db, env, params, body }) {
  const campaign = await loadCampaign(db, params);
  const email = cleanEmail(text((await body()).email, 300));
  check(email, 400, 'Enter a valid email address for the test.');
  await checkSendable(db, campaign);
  await db
    .prepare(
      `INSERT INTO messages (campaign_id, email, token, is_test, queued_at)
       VALUES (?, ?, lower(hex(randomblob(12))), 1, ?)`,
    )
    .bind(campaign.id, email, now())
    .run();
  return { started: await dispatch(env).catch(() => false) };
}

export async function listMessages({ db, params, url }) {
  const query = url.searchParams;
  const where = ['m.campaign_id = ?', 'm.is_test = 0'];
  const args = [campaignId(params)];
  if (STAGES[query.get('stage')]) where.push(STAGES[query.get('stage')]);
  const search = (query.get('q') ?? '').trim();
  if (search) {
    where.push('m.email LIKE ?');
    args.push(`%${search}%`);
  }
  const { limit, offset } = page(query);
  const [rows, total] = await db.batch([
    db
      .prepare(
        `SELECT m.id, m.email, c.name, m.status, m.error, m.sent_at, m.delivered_at, m.opened_at, m.open_count,
                m.clicked_at, m.click_count, m.replied_at, m.reply_snippet, m.bounced_at, m.unsubscribed_at
         FROM messages m LEFT JOIN contacts c ON c.id = m.contact_id
         WHERE ${where.join(' AND ')} ORDER BY m.id LIMIT ? OFFSET ?`,
      )
      .bind(...args, limit, offset),
    db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${where.join(' AND ')}`).bind(...args),
  ]);
  return { rows: rows.results, total: total.results[0].n };
}

// ---- Attachments ----

// Registers a file. Its content follows in parts (uploadPart), because one database value holds
// at most 2 MB. The browser encodes the parts, so the Worker only stores text.
export async function addAttachment({ db, params, body }) {
  const campaign = await loadCampaign(db, params);
  check(canEditContent(campaign.status), 409, LOCKED);
  const input = await body();
  // The file's own name only: no folders, control characters or quotes.
  const name = text(input.name, 200).replace(/^.*[\\/]/, '').replace(/[\p{Cc}"]/gu, '').trim();
  const size = Number(input.size);
  check(name && Number.isInteger(size), 400, 'The file needs a name and a size.');
  const problem = attachmentProblem(name, size, await loadAttachments(db, campaign.id));
  check(!problem, 400, problem);
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(input.type ?? '') ? input.type : 'application/octet-stream';
  const row = await db
    .prepare('INSERT INTO attachments (campaign_id, name, type, size, parts, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, parts')
    .bind(campaign.id, name, type, size, partsFor(size), now())
    .first();
  return { id: row.id, parts: row.parts };
}

async function loadAttachment(db, params) {
  const file = await db
    .prepare('SELECT a.id, a.parts, c.status FROM attachments a JOIN campaigns c ON c.id = a.campaign_id WHERE a.id = ?')
    .bind(idOf(params.id, 'Attachment'))
    .first();
  check(file, 404, 'Attachment not found.');
  check(canEditContent(file.status), 409, LOCKED);
  return file;
}

export async function uploadPart({ db, params, body }) {
  const file = await loadAttachment(db, params);
  const part = Number(params.part);
  check(Number.isInteger(part) && part >= 0 && part < file.parts, 400, 'That part does not belong to the file.');
  const { data } = await body();
  check(typeof data === 'string' && data.length > 0 && data.length <= Math.ceil(PART_BYTES / 3) * 4, 400, 'That part is not valid.');
  await db
    .prepare('INSERT OR REPLACE INTO attachment_parts (attachment_id, part, data) VALUES (?, ?, ?)')
    .bind(file.id, part, data)
    .run();
  return { ok: true };
}

export async function deleteAttachment({ db, params }) {
  const file = await loadAttachment(db, params);
  await db.batch([
    db.prepare('DELETE FROM attachment_parts WHERE attachment_id = ?').bind(file.id),
    db.prepare('DELETE FROM attachments WHERE id = ?').bind(file.id),
  ]);
  return { ok: true };
}

// ---- Images ----

// Images arrive already base64-encoded and are stored that way: decoding text is far cheaper
// for the Worker than reading a binary column, which D1 returns as an array of numbers.
export async function uploadImage({ db, url, body }) {
  const { type, data } = await body();
  const extension = IMAGE_TYPES[type];
  check(extension, 400, 'Use a PNG, JPEG or GIF image.');
  check(typeof data === 'string' && data.length > 0, 400, 'The image is empty.');
  check(data.length <= MAX_IMAGE_BASE64, 413, 'That image is too large. Use one smaller than 1.4 MB.');
  const row = await db
    .prepare(
      `INSERT INTO images (id, type, data, created_at) VALUES (lower(hex(randomblob(12))), ?, ?, ?) RETURNING id`,
    )
    .bind(type, data, now())
    .first();
  return { url: `${url.origin}/img/${row.id}.${extension}` };
}
