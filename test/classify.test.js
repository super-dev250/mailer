import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, isCandidate, snippet } from '../runner/classify.js';

const SENT = 'a'.repeat(24);
const message = (lines) => Buffer.from(lines.join('\r\n'));

const reply = (extraHeaders = [], body = ['Sounds good, send me the link.']) =>
  message([
    'From: Lee Carter <Lee@Example.com>',
    'To: Sam <sam@gmail.com>',
    'Subject: Re: Hello Lee',
    'Date: Mon, 5 Oct 2026 15:14:00 +0000',
    'Message-ID: <CAF123@mail.example.com>',
    `In-Reply-To: <mailer-${SENT}@gmail.com>`,
    `References: <older@example.com>`,
    ` <mailer-${SENT}@gmail.com>`,
    ...extraHeaders,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    ...body,
  ]);

const report = ({ action, status, quoteOriginal = true, failedHeader = true }) =>
  message([
    'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    'To: sam@gmail.com',
    'Subject: Delivery Status Notification',
    'Date: Mon, 05 Oct 2026 08:00:05 -0700',
    ...(failedHeader ? ['X-Failed-Recipients: Nobody@example.com'] : []),
    ...(quoteOriginal ? [`References: <mailer-${SENT}@gmail.com>`] : []),
    'Auto-Submitted: auto-replied',
    'Content-Type: multipart/report; boundary="b1"; report-type=delivery-status',
    '',
    '--b1',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    'Your message was not delivered to nobody@example.com.',
    '',
    '--b1',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; googlemail.com',
    '',
    'Final-Recipient: rfc822; nobody@example.com',
    `Action: ${action}`,
    `Status: ${status}`,
    'Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.',
    ' Please try double-checking the address. x1si123 - gsmtp',
    '',
    ...(quoteOriginal
      ? ['--b1', 'Content-Type: message/rfc822', '', 'From: Sam <sam@gmail.com>', `Message-ID: <mailer-${SENT}@gmail.com>`, '', 'Hi']
      : []),
    '--b1--',
  ]);

test('a reply is matched through the Message-ID it answers', async () => {
  const quoted = ['Sounds good,', 'send me the link.', '', 'On Mon, Oct 5, 2026 at 3:00 PM Sam <sam@gmail.com> wrote:', '> Hi Lee,', '> Try the app.'];
  assert.deepEqual(await classify(reply([], quoted)), {
    type: 'reply',
    token: SENT,
    at: '2026-10-05T15:14:00.000Z',
    snippet: 'Sounds good, send me the link.',
  });
});

test('an HTML-only reply still yields the written text', async () => {
  const html = message([
    'From: lee@example.com',
    `In-Reply-To: <mailer-${SENT}@gmail.com>`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    '<div>Yes please &amp; thanks</div><blockquote>Hi Lee, try the app.</blockquote>',
  ]);
  const event = await classify(html);
  assert.equal(event.type, 'reply');
  assert.equal(event.snippet, 'Yes please & thanks');
});

test('a failure report is a bounce, even though it looks like an automatic reply', async () => {
  assert.deepEqual(await classify(report({ action: 'failed', status: '5.1.1' })), {
    type: 'bounce',
    token: SENT,
    email: 'nobody@example.com',
    at: '2026-10-05T15:00:05.000Z',
    permanent: true,
    reason: 'smtp; 550-5.1.1 The email account that you tried to reach does not exist. Please try double-checking the address. x1si123 - gsmtp',
  });
});

test('a bounce without the original email is matched by address, and 4.x.x is not permanent', async () => {
  const event = await classify(report({ action: 'failed', status: '4.2.2', quoteOriginal: false, failedHeader: false }));
  assert.deepEqual([event.type, event.token, event.email, event.permanent], ['bounce', '', 'nobody@example.com', false]);
});

test('delay notices, automatic replies and unrelated mail are ignored', async () => {
  assert.equal(await classify(report({ action: 'delayed', status: '4.4.1' })), null);
  assert.equal(await classify(reply(['Auto-Submitted: auto-replied'])), null);
  assert.equal(await classify(reply(['Precedence: auto_reply'])), null);
  assert.equal(await classify(message(['From: friend@example.com', 'Subject: Re: lunch', 'In-Reply-To: <x@example.com>', '', 'Sure'])), null);
  assert.notEqual(await classify(reply(['Auto-Submitted: no'])), null);
});

test('only messages that could matter are downloaded', () => {
  assert.equal(isCandidate('lee@example.com', `References: <mailer-${SENT}@gmail.com>`), true);
  assert.equal(isCandidate('mailer-daemon@googlemail.com', 'Content-Type: text/plain'), true);
  assert.equal(isCandidate('x@example.com', 'Content-Type: multipart/report; report-type=delivery-status'), true);
  assert.equal(isCandidate('friend@example.com', 'References: <x@example.com>\r\nContent-Type: text/plain'), false);
});

test('the quoted original is cut from a reply', () => {
  assert.equal(snippet('Call me.\n\n-----Original Message-----\nFrom: Sam'), 'Call me.');
  assert.equal(snippet('Ok\nOn Mon, Oct 5, 2026 at 3:00 PM Sam <sam@gmail.com>\nwrote:\n> Hi'), 'Ok');
  assert.equal(snippet(''), '');
});
