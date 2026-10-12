// Upgrading a database that already holds contacts and sent emails, as a deployed app's does.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS, ready } from '../app/src/db.js';

// The part of Cloudflare D1's interface that db.js uses, on Node's built-in SQLite.
// Node's SQLite cannot bind numbered parameters (?1, ?2) by position, so they become plain ones.
function d1(sqlite) {
  const statement = (numberedSql, numberedValues = []) => {
    const values = [];
    const sql = numberedSql.replace(/\?(\d+)/g, (_, number) => (values.push(numberedValues[number - 1]), '?'));
    if (sql === numberedSql) values.push(...numberedValues);
    return run(sql, values, numberedSql);
  };
  const run = (sql, values, original) => ({
    bind: (...next) => statement(original, next),
    async first(column) {
      const row = sqlite.prepare(sql).get(...values);
      return column ? (row?.[column] ?? null) : (row ?? null);
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...values) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }),
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

test('a database from the first version learns who was already emailed', async () => {
  const sqlite = new DatabaseSync(':memory:');
  for (const sql of MIGRATIONS[0]) sqlite.exec(sql);
  sqlite.exec(`
    INSERT INTO settings (key, value) VALUES ('schema_version', '1');
    INSERT INTO contacts (id, email, created_at) VALUES (1, 'sent@example.com', 'x'), (2, 'queued@example.com', 'x'), (3, 'bounced@example.com', 'x');
    INSERT INTO campaigns (id, name, created_at) VALUES (1, 'Old', 'x');
    INSERT INTO messages (campaign_id, contact_id, email, token, status, queued_at, sent_at, is_test) VALUES
      (1, 1, 'sent@example.com', 'a', 'sent', 'x', '2026-10-01T10:00:00.000Z', 0),
      (1, 2, 'queued@example.com', 'b', 'queued', 'x', NULL, 0),
      (1, 3, 'bounced@example.com', 'c', 'bounced', 'x', '2026-10-01T11:00:00.000Z', 0),
      (1, NULL, 'me@example.com', 'd', 'sent', 'x', '2026-10-01T09:00:00.000Z', 1);
  `);

  await ready(d1(sqlite));

  const contacts = sqlite.prepare('SELECT email, last_emailed_at FROM contacts ORDER BY id').all().map((row) => ({ ...row }));
  assert.deepEqual(contacts, [
    { email: 'sent@example.com', last_emailed_at: '2026-10-01T10:00:00.000Z' },
    { email: 'queued@example.com', last_emailed_at: null },
    { email: 'bounced@example.com', last_emailed_at: '2026-10-01T11:00:00.000Z' },
  ]);
  assert.equal(sqlite.prepare(`SELECT value FROM settings WHERE key = 'schema_version'`).get().value, String(MIGRATIONS.length));
  const tables = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'attachment%' ORDER BY name`).all();
  assert.deepEqual(tables.map((row) => row.name), ['attachment_parts', 'attachments']);
});
