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

// One mailbox: GMAIL_USER/GMAIL_APP_PASSWORD, as before, used by slot 0 only. Several:
// GMAIL_ACCOUNTS holds all of them as JSON, and the workflow hands each of its fixed slots a
// MAILBOX_INDEX into that list. An index past the end of the list (or past 0, for the single
// legacy mailbox) is a normal, unused slot, not an error — most of the workflow's slots are
// unused on a day with only one or two mailboxes configured, and exit quietly below.
const index = Number(env.MAILBOX_INDEX ?? 0);

function account() {
  if (env.GMAIL_ACCOUNTS?.trim()) {
    const accounts = JSON.parse(env.GMAIL_ACCOUNTS); // malformed JSON is a real error: let it throw
    const picked = accounts[index];
    return picked?.user && picked?.app_password ? picked : null;
  }
  if (index === 0 && env.GMAIL_USER?.trim() && env.GMAIL_APP_PASSWORD?.trim()) {
    return { user: env.GMAIL_USER, app_password: env.GMAIL_APP_PASSWORD };
  }
  return null;
}

let picked;
try {
  picked = account();
} catch (error) {
  // Only the first slot reports a real misconfiguration, so it is not repeated five times over.
  if (index === 0) console.log(`::warning::GMAIL_ACCOUNTS is not set up correctly: ${error.message} See the README.`);
  process.exit(0);
}
if (!picked) {
  if (index === 0 && !env.GMAIL_ACCOUNTS?.trim() && !env.GMAIL_USER?.trim()) {
    // Not a failure: the schedule starts with the first push, before setup is finished.
    console.log('::warning::Mailer is not set up yet. Missing secrets: GMAIL_USER, GMAIL_APP_PASSWORD (or GMAIL_ACCOUNTS). See the README.');
  } else {
    console.log(`No mailbox configured for slot ${index}.`);
  }
  process.exit(0);
}

const user = picked.user.trim();
// Google shows app passwords in four groups separated by spaces.
const auth = { user, pass: picked.app_password.replace(/\s+/g, '') };
// The defaults are Gmail's. Another mailbox works by setting SMTP_HOST and IMAP_HOST.
const smtpPort = Number(env.SMTP_PORT) || 465;
const smtp = { host: env.SMTP_HOST || 'smtp.gmail.com', port: smtpPort, secure: smtpPort === 465, auth };
const imap = { host: env.IMAP_HOST || 'imap.gmail.com', port: Number(env.IMAP_PORT) || 993, secure: true, auth };
// Brevo's HTTP API sends the mail itself if brevo_api_key is set (per account in GMAIL_ACCOUNTS,
// or BREVO_API_KEY as a shared fallback for every account / the legacy single mailbox) — unlike
// its SMTP relay, the API isn't locked to a pre-authorized IP, so it works from GitHub's own
// hosted runners. The Gmail login above still reads that mailbox's inbox for replies and
// bounces either way, since Brevo has no inbox of its own to check.
const brevoApiKey = (picked.brevo_api_key || env.BREVO_API_KEY)?.trim();

let summary;
try {
  summary = await run({
    app: createApp(env.APP_URL, env.APP_SECRET.trim()),
    mailer: createMailer({ user, transport: smtp, brevoApiKey }),
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
