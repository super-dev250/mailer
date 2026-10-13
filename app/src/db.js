// The database creates and upgrades its own tables on first use, so there is no migration step to run.

// Each entry upgrades the database by one version. Only ever add to the end.
export const MIGRATIONS = [
  // 1: the original tables.
  [
    `CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL DEFAULT '',
      fields TEXT NOT NULL DEFAULT '{}',
      list TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS contacts_list ON contacts (list, status)`,
    `CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      preheader TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      list TEXT NOT NULL DEFAULT '',
      links TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    )`,
    // One row per email to one recipient. `status` is how far sending got;
    // the timestamps record what happened to the email afterwards.
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
      contact_id INTEGER REFERENCES contacts (id) ON DELETE SET NULL,
      email TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      is_test INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      queued_at TEXT NOT NULL,
      claimed_at TEXT,
      sent_at TEXT,
      delivered_at TEXT,
      opened_at TEXT,
      open_count INTEGER NOT NULL DEFAULT 0,
      clicked_at TEXT,
      click_count INTEGER NOT NULL DEFAULT 0,
      replied_at TEXT,
      reply_snippet TEXT,
      bounced_at TEXT,
      unsubscribed_at TEXT,
      UNIQUE (campaign_id, contact_id)
    )`,
    `CREATE INDEX IF NOT EXISTS messages_status ON messages (status, sent_at)`,
    `CREATE INDEX IF NOT EXISTS messages_email ON messages (email)`,
    `CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
  ],
  // 2: remember who has been emailed, so nobody gets a campaign email twice.
  [
    'ALTER TABLE contacts ADD COLUMN last_emailed_at TEXT',
    `UPDATE contacts SET last_emailed_at = (
       SELECT MAX(sent_at) FROM messages m WHERE m.contact_id = contacts.id AND m.is_test = 0 AND m.status IN ('sent', 'bounced'))`,
    'CREATE INDEX IF NOT EXISTS messages_contact ON messages (contact_id, status)',
  ],
  // 3: files attached to a campaign, stored in parts that each fit in one database value.
  [
    `CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      size INTEGER NOT NULL,
      parts INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS attachments_campaign ON attachments (campaign_id)',
    `CREATE TABLE IF NOT EXISTS attachment_parts (
      attachment_id INTEGER NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
      part INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (attachment_id, part)
    )`,
  ],
  // 4: which link in a campaign was clicked, not just that some link was: `messages.click_count`
  // only ever counted clicks in aggregate, with no record of which of a campaign's several links
  // they were on, so a report could not break clicks down per link.
  [
    `CREATE TABLE IF NOT EXISTS link_clicks (
      id INTEGER PRIMARY KEY,
      campaign_id INTEGER NOT NULL REFERENCES campaigns (id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
      link_index INTEGER NOT NULL,
      clicked_at TEXT NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS link_clicks_campaign ON link_clicks (campaign_id, link_index)',
  ],
  // 5: a campaign can cap how many of its available contacts to queue, instead of always
  // queuing everyone, so a very large list can be sent to in planned batches over several campaigns.
  ['ALTER TABLE campaigns ADD COLUMN send_limit INTEGER'],
];

export const DEFAULT_SETTINGS = {
  sender_name: '',
  // Off: the email ends with the message, like a personal email.
  footer: false,
  postal_address: '',
  unsubscribe_text: 'Unsubscribe',
  // A cautious starting pace for a mailbox with no sending history: spread across the day rather
  // than front-loaded into the first couple of runs, and well under Gmail's own 500-a-day cap.
  // See the Settings page for how to raise this gradually as the mailbox earns a reputation.
  batch_size: 4,
  delay_seconds: 40,
  daily_limit: 40,
  // How often the Worker's own Cloudflare Cron Trigger asks GitHub to run, in minutes. The cron
  // itself fires every 5 minutes (see app/wrangler.json); this is checked on each of those ticks,
  // so the real interval is this value rounded up to the next multiple of 5.
  run_every_minutes: 60,
  track_opens: true,
  track_clicks: true,
};

export const now = () => new Date().toISOString();
export const ago = (milliseconds) => new Date(Date.now() - milliseconds).toISOString();

/** Everything in the key-value `settings` table, as one object. */
export async function getValues(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(results.map((row) => [row.key, JSON.parse(row.value)]));
}

export async function getSettings(db) {
  return { ...DEFAULT_SETTINGS, ...(await getValues(db)).settings };
}

/** A statement that stores one value. Run it, or include it in a batch. */
export function setValue(db, key, value) {
  return db
    .prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2')
    .bind(key, JSON.stringify(value));
}

async function schemaVersion(db) {
  const value = await db
    .prepare(`SELECT value FROM settings WHERE key = 'schema_version'`)
    .first('value')
    .catch(() => null);
  return Number(value) || 0;
}

async function migrate(db) {
  const version = await schemaVersion(db);
  if (version >= MIGRATIONS.length) return;
  const statements = MIGRATIONS.slice(version).flat().map((sql) => db.prepare(sql));
  try {
    await db.batch([...statements, setValue(db, 'schema_version', MIGRATIONS.length)]);
  } catch (error) {
    // Another Worker instance may have upgraded the database at the same moment.
    if ((await schemaVersion(db)) < MIGRATIONS.length) throw error;
  }
}

let migrated;

/** Resolves once the tables exist. Checked once per Worker instance. */
export function ready(db) {
  migrated ??= migrate(db).catch((error) => {
    migrated = undefined;
    throw error;
  });
  return migrated;
}
