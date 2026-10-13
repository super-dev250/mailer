// Entry point of the Mailer workflow. Reads its configuration from the environment,
// which GitHub Actions fills from the repository secrets.

import { appendFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { checkInbox } from './inbox.js';
import { run } from './run.js';
import { createMailer } from './send.js';

const env = process.env;

const missing = ['APP_URL', 'APP_SECRET'].filter((name) => !env[name]?.trim());
if (missing.length) {
  // Not a failure: the schedule starts with the first push, before setup is finished.
  console.log(`::warning::Mailer is not set up yet. Missing secrets: ${missing.join(', ')}. See the README.`);
  process.exit(0);
}

// One mailbox: GMAIL_USER/GMAIL_APP_PASSWORD, as before. Several: GMAIL_ACCOUNTS holds all of
// them as JSON, and the workflow's matrix picks one by MAILBOX_INDEX for this particular job.
// See the README for how the workflow builds that matrix from the same secret.
function account() {
  if (env.GMAIL_ACCOUNTS?.trim()) {
    const accounts = JSON.parse(env.GMAIL_ACCOUNTS);
    const index = Number(env.MAILBOX_INDEX ?? 0);
    const picked = accounts[index];
    if (!picked?.user || !picked?.app_password) throw new Error(`GMAIL_ACCOUNTS has no usable entry at index ${index}.`);
    return picked;
  }
  if (env.GMAIL_USER?.trim() && env.GMAIL_APP_PASSWORD?.trim()) return { user: env.GMAIL_USER, app_password: env.GMAIL_APP_PASSWORD };
  return null;
}

let picked;
try {
  picked = account();
} catch (error) {
  console.log(`::warning::Mailer is not set up yet. ${error.message} See the README.`);
  process.exit(0);
}
if (!picked) {
  console.log('::warning::Mailer is not set up yet. Missing secrets: GMAIL_USER, GMAIL_APP_PASSWORD (or GMAIL_ACCOUNTS). See the README.');
  process.exit(0);
}

const user = picked.user.trim();
// Google shows app passwords in four groups separated by spaces.
const auth = { user, pass: picked.app_password.replace(/\s+/g, '') };
// The defaults are Gmail's. Another mailbox works by setting SMTP_HOST and IMAP_HOST.
const smtpPort = Number(env.SMTP_PORT) || 465;
const smtp = { host: env.SMTP_HOST || 'smtp.gmail.com', port: smtpPort, secure: smtpPort === 465, auth };
const imap = { host: env.IMAP_HOST || 'imap.gmail.com', port: Number(env.IMAP_PORT) || 993, secure: true, auth };

let summary;
try {
  summary = await run({
    app: createApp(env.APP_URL, env.APP_SECRET.trim()),
    mailer: createMailer({ user, transport: smtp }),
    checkInbox: (state) => checkInbox({ imap, user, ...state }),
    user,
  });
} catch (error) {
  summary = { sent: 0, failed: 0, replies: 0, bounces: 0, error: error.message };
}

const line = `Sent ${summary.sent} · Failed ${summary.failed} · Replies ${summary.replies} · Bounces ${summary.bounces}`;
console.log(line);
if (summary.error) console.log(`::error::${summary.error}`);
if (env.GITHUB_STEP_SUMMARY) {
  await appendFile(env.GITHUB_STEP_SUMMARY, `### Mailer run\n\n${line}\n${summary.error ? `\n**Problem:** ${summary.error}\n` : ''}`);
}
process.exit(summary.error ? 1 : 0);
