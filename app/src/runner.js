// The API used by the GitHub Actions runner: hand out the next emails to send,
// then record what the runner reports back.

import { check } from './http.js';
import { DEFAULT_MAILBOX_PACE, DEFAULT_SETTINGS, ago, getValues, now } from './db.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const STUCK_AFTER = 15 * MINUTE; // a claimed email with no result: the run died mid-send
const DELIVERED_AFTER = 5 * MINUTE; // bounces normally come back within seconds
const WATCH_INBOX_FOR = 45 * DAY; // how long after sending replies are still looked for

const idsOf = (rows, key) => JSON.stringify([...new Set(rows.map((row) => row[key]).filter(Boolean))]);

// Finds (or, the first time this mailbox is ever seen, creates) the mailbox a claim or report
// belongs to. With no `sender` at all, there must be exactly one mailbox in the whole app for
// this to resolve — the runner itself always sends its own address, so this only matters for
// callers that do not (nothing in production; it keeps a single-mailbox setup simple to test).
async function resolveMailbox(db, sender) {
  if (sender) {
    const email = String(sender).trim().toLowerCase();
    const existing = await db.prepare('SELECT * FROM mailboxes WHERE email = ?').bind(email).first();
    if (existing) return existing;
    return db
      .prepare(
        `INSERT INTO mailboxes (email, name, sender_name, batch_size, delay_seconds, daily_limit, status, created_at)
         VALUES (?1, ?1, '', ?2, ?3, ?4, 'active', ?5) RETURNING *`,
      )
      .bind(email, DEFAULT_MAILBOX_PACE.batch_size, DEFAULT_MAILBOX_PACE.delay_seconds, DEFAULT_MAILBOX_PACE.daily_limit, now())
      .first();
  }
  const { results } = await db.prepare('SELECT * FROM mailboxes').all();
  return results.length === 1 ? results[0] : null;
}

export async function claim({ db, url, body }) {
  const { sender } = await body();
  const mailbox = await resolveMailbox(db, sender);
  check(mailbox, 400, 'Which mailbox is this? Pass "sender".');
  const values = await getValues(db);
  const settings = {
    ...DEFAULT_SETTINGS,
    ...values.settings,
    sender_name: mailbox.sender_name,
    batch_size: mailbox.batch_size,
    delay_seconds: mailbox.delay_seconds,
    daily_limit: mailbox.daily_limit,
  };

  const [, , stuck, used, recent] = await db.batch([
    // Never mail someone who unsubscribed, bounced or was deleted after the campaign started,
    db.prepare(
      `UPDATE messages SET status = 'skipped', error = 'Removed, unsubscribed or bounced before this email was sent'
       WHERE status = 'queued' AND is_test = 0
         AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = messages.contact_id AND c.status = 'active')`,
    ),
    // or who has been emailed by another campaign in the meantime.
    db.prepare(
      `UPDATE messages SET status = 'skipped', error = 'Already emailed by another campaign'
       WHERE status = 'queued' AND is_test = 0
         AND contact_id IN (SELECT id FROM contacts WHERE last_emailed_at IS NOT NULL)`,
    ),
    // Stuck and recent are scoped to this mailbox: each mailbox's run only ever reports on,
    // or is paced by, the emails that actually went out through it.
    db
      .prepare(
        `SELECT m.id, m.token FROM messages m JOIN campaigns c ON c.id = m.campaign_id
         WHERE m.status = 'sending' AND m.claimed_at < ?1 AND c.mailbox_id = ?2 LIMIT 50`,
      )
      .bind(ago(STUCK_AFTER), mailbox.id),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m JOIN campaigns c ON c.id = m.campaign_id
         WHERE c.mailbox_id = ?2 AND (m.status = 'sending' OR m.sent_at > ?1)`,
      )
      .bind(ago(DAY), mailbox.id),
    db
      .prepare(
        `SELECT 1 FROM messages m JOIN campaigns c ON c.id = m.campaign_id
         WHERE c.mailbox_id = ?2 AND m.sent_at > ?1 LIMIT 1`,
      )
      .bind(ago(WATCH_INBOX_FOR), mailbox.id),
  ]);

  // Paused: hand out nothing new, but still look for replies to what this mailbox already sent.
  const room = mailbox.status === 'active' ? Math.max(0, Math.min(settings.batch_size, settings.daily_limit - used.results[0].n)) : 0;
  const claimed = room
    ? (
        await db
          .prepare(
            `UPDATE messages SET status = 'sending', claimed_at = ?1
             WHERE id IN (
               SELECT m.id FROM messages m JOIN campaigns c ON c.id = m.campaign_id
               WHERE m.status = 'queued' AND c.mailbox_id = ?3 AND (m.is_test = 1 OR c.status = 'sending')
               ORDER BY m.is_test DESC, m.id LIMIT ?2)
             RETURNING id, token, email, campaign_id, contact_id, is_test`,
          )
          .bind(now(), room, mailbox.id)
          .all()
      ).results.sort((a, b) => b.is_test - a.is_test || a.id - b.id)
    : [];

  const campaigns = {};
  const contacts = new Map();
  if (claimed.length) {
    const [campaignRows, contactRows, fileRows] = await db.batch([
      db
        .prepare('SELECT id, subject, preheader, body_html, links, list FROM campaigns WHERE id IN (SELECT value FROM json_each(?))')
        .bind(idsOf(claimed, 'campaign_id')),
      db
        .prepare('SELECT id, email, name, fields FROM contacts WHERE id IN (SELECT value FROM json_each(?))')
        .bind(idsOf(claimed, 'contact_id')),
      // Only files whose upload finished. The runner fetches their content part by part.
      db
        .prepare(
          `SELECT a.id, a.campaign_id, a.name, a.type, a.size, a.parts FROM attachments a
           WHERE a.campaign_id IN (SELECT value FROM json_each(?))
             AND (SELECT COUNT(*) FROM attachment_parts p WHERE p.attachment_id = a.id) = a.parts
           ORDER BY a.id`,
        )
        .bind(idsOf(claimed, 'campaign_id')),
    ]);
    for (const row of campaignRows.results) campaigns[row.id] = { ...row, links: JSON.parse(row.links), attachments: [] };
    for (const row of contactRows.results) contacts.set(row.id, { ...row, fields: JSON.parse(row.fields) });
    for (const { campaign_id, ...file } of fileRows.results) campaigns[campaign_id].attachments.push(file);
  }

  // A test is addressed to you but filled in with a real contact from the audience:
  // the newest one, which is also the contact the editor's preview shows.
  const samples = new Map();
  const sample = async (list) => {
    if (!samples.has(list)) {
      const row = await db
        .prepare(`SELECT email, name, fields FROM contacts WHERE status = 'active' AND (?1 = '' OR list = ?1) ORDER BY id DESC LIMIT 1`)
        .bind(list)
        .first();
      samples.set(list, row && { ...row, fields: JSON.parse(row.fields) });
    }
    return samples.get(list);
  };
  const messages = [];
  for (const row of claimed) {
    const contact = row.is_test ? await sample(campaigns[row.campaign_id].list) : contacts.get(row.contact_id);
    messages.push({
      id: row.id,
      token: row.token,
      to: row.email,
      campaign_id: row.campaign_id,
      test: Boolean(row.is_test),
      contact: contact ?? { email: row.email, name: '', fields: {} },
    });
  }

  return {
    base_url: url.origin,
    settings,
    campaigns,
    messages,
    stuck: stuck.results,
    inbox: {
      watch: mailbox.status === 'active' && (recent.results.length > 0 || stuck.results.length > 0),
      cursor: mailbox.inbox_cursor ? JSON.parse(mailbox.inbox_cursor) : null,
    },
  };
}

/** One stored part of an attached file, base64-encoded. */
export async function part({ db, body }) {
  const { id, part: index } = await body();
  check(Number.isInteger(id) && Number.isInteger(index), 400, 'Give the attachment id and the part number.');
  const row = await db.prepare('SELECT data FROM attachment_parts WHERE attachment_id = ? AND part = ?').bind(id, index).first();
  check(row, 404, 'That part of the attachment is missing.');
  return { data: row.data };
}

/**
 * Which of these sender addresses are people a campaign emailed and who have not replied yet.
 * Lets the runner recognise a reply that does not quote our email's Message-ID, such as a
 * new email written to you instead of a reply.
 */
export async function match({ db, body }) {
  const { emails } = await body();
  check(Array.isArray(emails) && emails.length <= 500, 400, 'Send at most 500 addresses at a time.');
  const { results } = await db
    .prepare(
      `SELECT DISTINCT email FROM messages
       WHERE email IN (SELECT lower(value) FROM json_each(?1))
         AND is_test = 0 AND status = 'sent' AND replied_at IS NULL AND sent_at > ?2`,
    )
    .bind(JSON.stringify(emails), ago(WATCH_INBOX_FOR))
    .all();
  return { emails: results.map((row) => row.email) };
}

// Finds the email an inbox event belongs to: by its token when known, otherwise the
// latest email sent to that address.
const MATCH = `SELECT id FROM messages WHERE (token = ?1 OR email = ?2) AND status IN ('sent', 'bounced')
               ORDER BY (token = ?1) DESC, sent_at DESC LIMIT 1`;

export async function report({ db, body }) {
  const input = await body();
  const results = input.results ?? [];
  const events = input.events ?? [];
  check(results.length + events.length <= 20, 400, 'Report at most 20 items at a time.');
  const stamp = now();
  const statements = [];
  // Which mailbox this run was for, so its cursor and summary are saved on it, not shared
  // globally. Same single-mailbox fallback as claim(): real runs always send `sender`.
  const mailbox = input.cursor || input.run ? await resolveMailbox(db, input.sender) : null;

  for (const result of results) {
    if (result.status === 'sent') {
      statements.push(
        db
          .prepare(`UPDATE messages SET status = 'sent', sent_at = ?, error = NULL WHERE id = ? AND status = 'sending'`)
          .bind(result.at ?? stamp, result.id),
        // Remembered on the contact, so later campaigns leave them out even if this one is deleted.
        db
          .prepare(
            `UPDATE contacts SET last_emailed_at = ?1
             WHERE id = (SELECT contact_id FROM messages WHERE id = ?2 AND is_test = 0)`,
          )
          .bind(result.at ?? stamp, result.id),
      );
    } else if (result.status === 'failed') {
      if (result.bad_address) {
        // The mail server refused this address outright: treat it like a bounce.
        statements.push(
          db
            .prepare(
              `UPDATE contacts SET status = 'bounced'
               WHERE status = 'active' AND id = (SELECT contact_id FROM messages WHERE id = ? AND is_test = 0)`,
            )
            .bind(result.id),
        );
      }
      statements.push(
        db
          .prepare(`UPDATE messages SET status = 'failed', error = ? WHERE id = ? AND status = 'sending'`)
          .bind(String(result.error ?? 'Unknown error').slice(0, 500), result.id),
      );
    } else {
      // Not attempted after all: back to the queue for the next run.
      statements.push(
        db.prepare(`UPDATE messages SET status = 'queued', claimed_at = NULL WHERE id = ? AND status = 'sending'`).bind(result.id),
      );
    }
  }

  for (const event of events) {
    const token = String(event.token ?? '');
    const email = String(event.email ?? '').toLowerCase();
    const at = event.at ?? stamp;
    if (event.type === 'reply') {
      // Replying implies the email arrived and was read. A message written before the email
      // went out is not a reply to it.
      statements.push(
        db
          .prepare(
            `UPDATE messages SET replied_at = COALESCE(replied_at, ?3), reply_snippet = COALESCE(reply_snippet, ?4),
               opened_at = COALESCE(opened_at, ?3), delivered_at = COALESCE(delivered_at, ?3)
             WHERE id = (${MATCH}) AND status = 'sent' AND sent_at <= ?3`,
          )
          .bind(token, email, at, String(event.snippet ?? '').slice(0, 500)),
      );
    } else if (event.type === 'bounce') {
      if (event.permanent) {
        statements.push(
          db
            .prepare(
              `UPDATE contacts SET status = 'bounced'
               WHERE status = 'active' AND id = (SELECT contact_id FROM messages WHERE id = (${MATCH}))`,
            )
            .bind(token, email),
        );
      }
      statements.push(
        db
          .prepare(
            `UPDATE messages SET status = 'bounced', bounced_at = ?3, error = ?4, delivered_at = NULL
             WHERE id = (${MATCH}) AND status = 'sent'`,
          )
          .bind(token, email, at, String(event.reason ?? 'Delivery failed').slice(0, 500)),
      );
    }
  }

  if (input.cursor && mailbox) {
    statements.push(db.prepare('UPDATE mailboxes SET inbox_cursor = ? WHERE id = ?').bind(JSON.stringify(input.cursor), mailbox.id));
  }
  if (input.synced) {
    // The inbox was just checked: anything sent a while ago with no bounce counts as delivered.
    statements.push(
      db
        .prepare(`UPDATE messages SET delivered_at = ? WHERE status = 'sent' AND delivered_at IS NULL AND sent_at < ?`)
        .bind(stamp, ago(DELIVERED_AFTER)),
    );
  }
  if (input.run && mailbox) {
    statements.push(
      db.prepare('UPDATE mailboxes SET last_run = ? WHERE id = ?').bind(JSON.stringify({ ...input.run, at: stamp }), mailbox.id),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE campaigns SET status = 'done', finished_at = ? WHERE status = 'sending' AND NOT EXISTS (
           SELECT 1 FROM messages m WHERE m.campaign_id = campaigns.id AND m.is_test = 0 AND m.status IN ('queued', 'sending'))`,
      )
      .bind(stamp),
  );

  await db.batch(statements);
  return { ok: true };
}
