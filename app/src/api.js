// Everything the web app calls. All of it requires the app secret.

import { extractLinks, fieldKey } from '../public/shared/email.js';
import { check } from './http.js';
import { DEFAULT_SETTINGS, getValues, now, setValue } from './db.js';
import { canDispatch, dispatch } from './github.js';

const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/;
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

// ---- Overview and settings ----

export async function overview({ db, env }) {
  const [values, lists] = await Promise.all([
    getValues(db),
    db
      .prepare(
        `SELECT list, COUNT(*) AS total, SUM(status = 'active') AS active, SUM(${AVAILABLE}) AS available
         FROM contacts GROUP BY list ORDER BY list`,
      )
      .all(),
  ]);
  return {
    settings: { ...DEFAULT_SETTINGS, ...values.settings },
    lists: lists.results,
    last_run: values.last_run ?? null,
    sender_email: values.sender_email ?? '',
    github: { repo: env.GITHUB_REPO ?? '', can_dispatch: canDispatch(env) },
  };
}

export async function saveSettings({ db, body }) {
  const input = await body();
  const settings = {
    sender_name: text(input.sender_name, 100).trim(),
    footer: Boolean(input.footer),
    postal_address: text(input.postal_address, 300).trim(),
    unsubscribe_text: text(input.unsubscribe_text, 100).trim() || DEFAULT_SETTINGS.unsubscribe_text,
    batch_size: whole(input.batch_size, 1, 500, DEFAULT_SETTINGS.batch_size),
    delay_seconds: whole(input.delay_seconds, 1, 120, DEFAULT_SETTINGS.delay_seconds),
    daily_limit: whole(input.daily_limit, 1, 2000, DEFAULT_SETTINGS.daily_limit),
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
    const email = text(row?.email, 254).trim().toLowerCase();
    if (EMAIL.test(email)) valid.push({ email, name: text(row.name, 200).trim(), fields: cleanFields(row.fields) });
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

function contactSelection(input) {
  if (Array.isArray(input.ids)) return { where: 'id IN (SELECT value FROM json_each(?))', arg: JSON.stringify(input.ids) };
  check(typeof input.list === 'string', 400, 'Choose the contacts to change.');
  return { where: 'list = ?', arg: input.list };
}

export async function deleteContacts({ db, body }) {
  const { where, arg } = contactSelection(await body());
  // Counted from the returned rows: the change count would also include the messages
  // that the delete detaches from these contacts.
  const { results } = await db.prepare(`DELETE FROM contacts WHERE ${where} RETURNING id`).bind(arg).all();
  return { deleted: results.length };
}

export async function setContactStatus({ db, body }) {
  const input = await body();
  check(['active', 'unsubscribed'].includes(input.status), 400, 'Unknown status.');
  const { where, arg } = contactSelection(input);
  const result = await db.prepare(`UPDATE contacts SET status = ? WHERE ${where}`).bind(input.status, arg).run();
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

function campaignId(params) {
  const id = Number(params.id);
  check(Number.isInteger(id), 404, 'Campaign not found.');
  return id;
}

async function loadCampaign(db, params) {
  const campaign = await db.prepare('SELECT * FROM campaigns WHERE id = ?').bind(campaignId(params)).first();
  check(campaign, 404, 'Campaign not found.');
  return campaign;
}

function checkSendable(campaign) {
  check(campaign.subject.trim(), 400, 'Add a subject line first.');
  check(!isBlank(campaign.body_html), 400, 'The email has no content yet.');
  check(!hasInlineImage(campaign.body_html), 400, 'An image is still uploading. Wait a moment and try again.');
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
      `INSERT INTO campaigns (name, subject, preheader, body_html, list, links, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      source ? `${source.name} (copy)` : 'Untitled campaign',
      source?.subject ?? '',
      source?.preheader ?? '',
      source?.body_html ?? '',
      source?.list ?? '',
      source?.links ?? '[]',
      now(),
    )
    .first();
  return { id: row.id };
}

export async function getCampaign({ db, params }) {
  const campaign = await loadCampaign(db, params);
  const stats = await db
    .prepare(`SELECT ${STATS} FROM messages WHERE campaign_id = ? AND is_test = 0`)
    .bind(campaign.id)
    .first();
  return { campaign: { ...campaign, links: JSON.parse(campaign.links) }, stats: counts(stats) };
}

export async function updateCampaign({ db, params, body }) {
  const campaign = await loadCampaign(db, params);
  check(campaign.status === 'draft', 409, 'This campaign has started, so its content is locked. Duplicate it to change it.');
  const input = await body();
  const html = text(input.body_html, 500_000);
  await db
    .prepare('UPDATE campaigns SET name = ?, subject = ?, preheader = ?, body_html = ?, list = ?, links = ? WHERE id = ?')
    .bind(
      text(input.name, 120).trim() || 'Untitled campaign',
      text(input.subject, 300),
      text(input.preheader, 300),
      html,
      text(input.list, 100),
      JSON.stringify(extractLinks(html)),
      campaign.id,
    )
    .run();
  return { ok: true };
}

export async function deleteCampaign({ db, params }) {
  const id = campaignId(params);
  await db.batch([
    db.prepare('DELETE FROM messages WHERE campaign_id = ?').bind(id),
    db.prepare('DELETE FROM campaigns WHERE id = ?').bind(id),
  ]);
  return { ok: true };
}

// Fixes the recipients: one queued message per contact in the audience who was never emailed.
export async function startCampaign({ db, env, params }) {
  const campaign = await loadCampaign(db, params);
  check(campaign.status === 'draft', 409, 'This campaign has already started.');
  checkSendable(campaign);
  const audience = `(?1 = '' OR list = ?1) AND ${AVAILABLE}`;
  const size = await db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE ${audience}`).bind(campaign.list).first('n');
  check(size > 0, 400, 'Everyone in this audience has already been emailed, or is waiting in another campaign.');

  const stamp = now();
  await db.batch([
    db.prepare(`UPDATE campaigns SET status = 'sending', started_at = ? WHERE id = ?`).bind(stamp, campaign.id),
    db
      .prepare(
        `INSERT INTO messages (campaign_id, contact_id, email, token, queued_at)
         SELECT ?2, id, email, lower(hex(randomblob(12))), ?3 FROM contacts WHERE ${audience} ORDER BY id`,
      )
      .bind(campaign.list, campaign.id, stamp),
  ]);
  return { queued: size, started: await dispatch(env).catch(() => false) };
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
export const resumeCampaign = changeStatus('paused', 'sending');

// A test goes through exactly the same path as a real email, to one address, outside the statistics.
export async function testCampaign({ db, env, params, body }) {
  const campaign = await loadCampaign(db, params);
  const email = text((await body()).email, 254).trim().toLowerCase();
  check(EMAIL.test(email), 400, 'Enter a valid email address for the test.');
  checkSendable(campaign);
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
