// Runs the runner against the real Worker (local runtime) and a local SMTP server
// standing in for Gmail. Only the mailbox check is replaced, by a function that
// returns what an IMAP check would have found.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { simpleParser } from 'mailparser';
import { SMTPServer } from 'smtp-server';
import { createTestHarness } from 'wrangler';
import { createApp } from '../runner/app.js';
import { run } from '../runner/run.js';
import { createMailer } from '../runner/send.js';

const SECRET = 'test-secret-0123456789abcdef';
const USER = 'sam@gmail.com';
const server = createTestHarness({
  root: fileURLToPath(new URL('..', import.meta.url)),
  workers: [{ configPath: 'app/wrangler.json', secrets: { APP_SECRET: SECRET } }],
});

// Accepts every email except those to an address starting with "gone".
const received = [];
const smtp = new SMTPServer({
  authOptional: true,
  disabledCommands: ['STARTTLS'],
  onRcptTo(address, session, done) {
    if (!address.address.startsWith('gone')) return done();
    done(Object.assign(new Error('5.1.1 No such user here'), { responseCode: 550 }));
  },
  onData(stream, session, done) {
    simpleParser(stream).then((mail) => {
      received.push(mail);
      done();
    }, done);
  },
});

let app;
let api;
let base;
let transport;

before(async () => {
  const { url } = await server.listen();
  base = url.origin;
  app = createApp(url.href, SECRET);
  api = async (method, path, body) => {
    const response = await fetch(new URL(path, url), {
      method,
      headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body),
    });
    return response.json();
  };
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  transport = { host: '127.0.0.1', port: smtp.server.address().port, secure: false, ignoreTLS: true };
});

after(async () => {
  await new Promise((resolve) => smtp.close(resolve));
  await server.close();
});

const noPause = async () => {};
const quiet = () => {};
let campaignId;

test('a run sends the queued emails and records each result', async () => {
  await api('PUT', '/api/settings', {
    sender_name: 'Sam Road', footer: true, postal_address: '1 Depot Way', batch_size: 10, delay_seconds: 1, daily_limit: 100, track_opens: true, track_clicks: true,
  });
  await api('POST', '/api/contacts/import', {
    list: 'drivers',
    rows: [
      { email: 'lee@example.com', name: 'Lee Carter' },
      { email: 'gone@example.com', name: 'Gone' },
      { email: 'kim@example.com', name: 'Kim' },
    ],
  });
  campaignId = (await api('POST', '/api/campaigns', {})).id;
  await api('PUT', `/api/campaigns/${campaignId}`, {
    name: 'Launch',
    subject: 'Hello {{first_name}}',
    preheader: 'A quick note',
    body_html: '<p>Hi {{first_name}}, <a href="https://app.example.com/get">get the app</a>.</p>',
    list: 'drivers',
  });
  await api('POST', `/api/campaigns/${campaignId}/start`, {});

  const inboxCalls = [];
  const summary = await run({
    app,
    mailer: createMailer({ user: USER, transport }),
    checkInbox: async (state) => {
      inboxCalls.push(state);
      return { events: [], reconciled: [], cursor: { path: 'INBOX', uidValidity: '1', uid: 10 } };
    },
    user: USER,
    log: quiet,
    pause: noPause,
  });

  assert.deepEqual(summary, { sent: 2, failed: 1, replies: 0, bounces: 0, error: '' });
  assert.deepEqual(inboxCalls.map(({ cursor, stuck }) => ({ cursor, stuck })), [{ cursor: null, stuck: [] }], 'the mailbox is checked right after the first send');
  assert.deepEqual(await inboxCalls[0].matchSenders(['LEE@example.com', 'stranger@example.com']), ['lee@example.com'], 'senders are matched against the people emailed');
  assert.deepEqual(received.map((mail) => mail.to.text), ['lee@example.com', 'kim@example.com']);

  const [mail] = received;
  const token = mail.messageId.match(/^<mailer-([a-f0-9]{24})@gmail\.com>$/)[1];
  const rawHeader = (name) => mail.headerLines.find((header) => header.key === name)?.line;
  assert.equal(mail.subject, 'Hello Lee');
  assert.equal(mail.from.text, '"Sam Road" <sam@gmail.com>');
  assert.equal(rawHeader('list-unsubscribe'), `List-Unsubscribe: <${base}/u/${token}>`);
  assert.equal(rawHeader('list-unsubscribe-post'), 'List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  assert.ok(mail.html.includes(`<a href="${base}/c/${token}/0">get the app</a>`));
  assert.ok(mail.html.includes(`<img src="${base}/o/${token}.gif"`));
  assert.ok(mail.html.includes('Sam Road &middot; 1 Depot Way'));
  assert.match(mail.text, /Hi Lee, get the app \[.+\/c\/[a-f0-9]{24}\/0\]\./);
  assert.match(mail.text, /Unsubscribe \[.+\/u\/[a-f0-9]{24}\]/);

  const { campaign, stats } = await api('GET', `/api/campaigns/${campaignId}`);
  assert.equal(campaign.status, 'done');
  assert.deepEqual({ sent: stats.sent, failed: stats.failed, pending: stats.pending }, { sent: 2, failed: 1, pending: 0 });
  const [failed] = (await api('GET', `/api/campaigns/${campaignId}/messages?stage=failed`)).rows;
  assert.equal(failed.email, 'gone@example.com');
  assert.match(failed.error, /550 5\.1\.1 No such user here/);
  const statuses = (await api('GET', '/api/contacts')).rows.map((row) => [row.email, row.status]);
  assert.deepEqual(statuses, [['kim@example.com', 'active'], ['gone@example.com', 'bounced'], ['lee@example.com', 'active']], 'a refused address is not mailed again');

  const overview = await api('GET', '/api/overview');
  assert.equal(overview.sender_email, USER);
  assert.deepEqual({ sent: overview.last_run.sent, failed: overview.last_run.failed, error: overview.last_run.error }, { sent: 2, failed: 1, error: '' });
});

test('a later run reports the replies and bounces found in the mailbox', async () => {
  const [lee, kim] = received.map((mail) => mail.messageId.slice(8, 32));
  const summary = await run({
    app,
    mailer: createMailer({ user: USER, transport }),
    checkInbox: async ({ cursor }) => {
      assert.deepEqual(cursor, { path: 'INBOX', uidValidity: '1', uid: 10 }, 'the check resumes where the last one stopped');
      return {
        events: [
          { type: 'reply', token: lee, at: new Date().toISOString(), snippet: 'Send me the link' },
          { type: 'bounce', token: kim, email: 'kim@example.com', permanent: true, reason: '550 mailbox unavailable' },
        ],
        reconciled: [],
        cursor: { path: 'INBOX', uidValidity: '1', uid: 14 },
      };
    },
    user: USER,
    log: quiet,
    pause: noPause,
  });

  assert.deepEqual(summary, { sent: 0, failed: 0, replies: 1, bounces: 1, error: '' });
  const { stats } = await api('GET', `/api/campaigns/${campaignId}`);
  assert.deepEqual(
    { sent: stats.sent, delivered: stats.delivered, opened: stats.opened, replied: stats.replied, bounced: stats.bounced },
    { sent: 2, delivered: 1, opened: 1, replied: 1, bounced: 1 },
  );
});

test('when the mailbox refuses the login, nothing is lost and the run reports why', async () => {
  await api('POST', '/api/contacts/import', { list: 'second', rows: [{ email: 'pat@example.com' }, { email: 'rae@example.com' }] });
  const second = (await api('POST', '/api/campaigns', { copy_of: campaignId })).id;
  await api('PUT', `/api/campaigns/${second}`, { name: 'Second', subject: 'Hi', body_html: '<p>Hi</p>', list: 'second' });
  await api('POST', `/api/campaigns/${second}/start`, {});

  const refused = {
    send: async () => {
      throw Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 });
    },
    close: () => {},
  };
  const summary = await run({
    app, mailer: refused, user: USER, log: quiet, pause: noPause,
    checkInbox: async () => ({ events: [], reconciled: [], cursor: { path: 'INBOX', uidValidity: '1', uid: 14 } }),
  });
  assert.equal(summary.sent, 0);
  assert.match(summary.error, /rejected the login.*GMAIL_APP_PASSWORD/);
  assert.match((await api('GET', '/api/overview')).last_run.error, /rejected the login/);

  // Both emails are back in the queue and go out once the login works.
  const before = received.length;
  const retry = await run({
    app, mailer: createMailer({ user: USER, transport }), user: USER, log: quiet, pause: noPause,
    checkInbox: async () => ({ events: [], reconciled: [], cursor: { path: 'INBOX', uidValidity: '1', uid: 14 } }),
  });
  assert.equal(retry.sent, 2);
  assert.deepEqual(received.slice(before).map((mail) => mail.to.text), ['pat@example.com', 'rae@example.com']);
  assert.equal(received.at(-1).subject, 'Hi');
});
