// The API used by the GitHub Actions runner: hand out the next emails to send,
// then record what the runner reports back.

import { check } from './http.js';
import { DEFAULT_SETTINGS, ago, getValues, now, setValue } from './db.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const STUCK_AFTER = 15 * MINUTE; // a claimed email with no result: the run died mid-send
const DELIVERED_AFTER = 5 * MINUTE; // bounces normally come back within seconds
const WATCH_INBOX_FOR = 45 * DAY; // how long after sending replies are still looked for

const idsOf = (rows, key) => JSON.stringify([...new Set(rows.map((row) => row[key]).filter(Boolean))]);

export async function claim({ db, url, body }) {
  const { sender } = await body();
  const values = await getValues(db);
  const settings = { ...DEFAULT_SETTINGS, ...values.settings };

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
    db.prepare(`SELECT id, token FROM messages WHERE status = 'sending' AND claimed_at < ? LIMIT 50`).bind(ago(STUCK_AFTER)),
    db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE status = 'sending' OR sent_at > ?`).bind(ago(DAY)),
    db.prepare('SELECT 1 FROM messages WHERE sent_at > ? LIMIT 1').bind(ago(WATCH_INBOX_FOR)),
  ]);

  const room = Math.max(0, Math.min(settings.batch_size, settings.daily_limit - used.results[0].n));
  const claimed = room
    ? (
        await db
          .prepare(
            `UPDATE messages SET status = 'sending', claimed_at = ?1
             WHERE id IN (
               SELECT m.id FROM messages m JOIN campaigns c ON c.id = m.campaign_id
               WHERE m.status = 'queued' AND (m.is_test = 1 OR c.status = 'sending')
               ORDER BY m.is_test DESC, m.id LIMIT ?2)
             RETURNING id, token, email, campaign_id, contact_id, is_test`,
          )
          .bind(now(), room)
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

  if (sender && sender !== values.sender_email) await setValue(db, 'sender_email', sender).run();

  return {
    base_url: url.origin,
    settings,
    campaigns,
    messages,
    stuck: stuck.results,
    inbox: { watch: recent.results.length > 0 || stuck.results.length > 0, cursor: values.inbox_cursor ?? null },
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

  if (input.cursor) statements.push(setValue(db, 'inbox_cursor', input.cursor));
  if (input.synced) {
    // The inbox was just checked: anything sent a while ago with no bounce counts as delivered.
    statements.push(
      db
        .prepare(`UPDATE messages SET delivered_at = ? WHERE status = 'sent' AND delivered_at IS NULL AND sent_at < ?`)
        .bind(stamp, ago(DELIVERED_AFTER)),
    );
  }
  if (input.run) statements.push(setValue(db, 'last_run', { ...input.run, at: stamp }));
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
