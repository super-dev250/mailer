// Runs the real Worker in a local Workers runtime with an empty database,
// and walks one campaign through its whole life.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';

const SECRET = 'test-secret-0123456789abcdef';
const server = createTestHarness({
  root: fileURLToPath(new URL('..', import.meta.url)),
  workers: [{ configPath: 'app/wrangler.json', secrets: { APP_SECRET: SECRET } }],
});

before(() => server.listen());
after(() => server.close());

async function call(method, path, body, secret = SECRET) {
  const response = await server.fetch(path, {
    method,
    redirect: 'manual',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const isJson = response.headers.get('Content-Type')?.includes('json');
  return { status: response.status, headers: response.headers, body: isJson ? await response.json() : await response.text() };
}
const get = (path) => call('GET', path);
const post = (path, body = {}) => call('POST', path, body);
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const BODY = '<p>Hi {{first_name|there}}</p><p><a href="https://app.example.com/get">Get the app</a></p>';
let campaignId;
let batch;
let mailboxId;

test('the API needs the app secret; tracking endpoints do not', async () => {
  assert.equal((await call('GET', '/api/overview', undefined, 'wrong')).status, 401);
  assert.equal((await get('/api/overview')).status, 200);
  const pixel = await server.fetch(`/o/${'0'.repeat(24)}.gif`);
  assert.equal(pixel.status, 200);
  assert.equal(pixel.headers.get('Content-Type'), 'image/gif');
  assert.equal((await pixel.arrayBuffer()).byteLength, 43);
});

test('importing contacts skips invalid and existing addresses', async () => {
  const rows = [
    { email: 'Ann@Example.com ', name: 'Ann Lee', fields: { 'Truck Make': 'Volvo' } },
    { email: 'bo@example.com', name: 'Bo' },
    { email: 'cy@example.com', name: 'Cy' },
    { email: 'di@example.com', name: 'Di' },
    { email: 'ed@example.com', name: 'Ed' },
    { email: 'ann@example.com', name: 'Duplicate' },
    { email: 'not-an-email' },
  ];
  assert.deepEqual((await post('/api/contacts/import', { list: 'drivers', rows })).body, { added: 5, existing: 1, invalid: 1 });
  assert.deepEqual((await post('/api/contacts/import', { list: 'second', rows })).body, { added: 0, existing: 6, invalid: 1 });

  const { body } = await get('/api/contacts?q=ann');
  assert.equal(body.total, 1);
  assert.deepEqual(
    { email: body.rows[0].email, name: body.rows[0].name, fields: body.rows[0].fields, list: body.rows[0].list },
    { email: 'ann@example.com', name: 'Ann Lee', fields: { truck_make: 'Volvo' }, list: 'drivers' },
  );
  assert.deepEqual((await get('/api/overview')).body.lists, [{ list: 'drivers', total: 5, active: 5, available: 5 }]);
});

test('a draft can be edited and its links are indexed', async () => {
  campaignId = (await post('/api/campaigns')).body.id;
  const update = { name: 'Launch', subject: 'Hello {{first_name}}', preheader: '', body_html: BODY, list: 'drivers' };
  assert.equal((await call('PUT', `/api/campaigns/${campaignId}`, update)).status, 200);
  const { campaign } = (await get(`/api/campaigns/${campaignId}`)).body;
  assert.equal(campaign.status, 'draft');
  assert.deepEqual(campaign.links, ['https://app.example.com/get']);
});

test('a campaign cannot start or send a test without a mailbox to send from', async () => {
  const refused = await post(`/api/campaigns/${campaignId}/start`);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Add a mailbox first/);

  const created = await post('/api/mailboxes', { email: 'me@gmail.com', name: 'Main' });
  assert.equal(created.status, 200);
  mailboxId = created.body.id;
  assert.equal((await post('/api/mailboxes', { email: 'me@gmail.com' })).status, 409, 'the address is already a mailbox');
});

test('a campaign without content or contacts cannot start', async () => {
  const empty = (await post('/api/campaigns')).body.id;
  assert.equal((await post(`/api/campaigns/${empty}/start`)).status, 400);
  await call('PUT', `/api/campaigns/${empty}`, { subject: 'Hi', body_html: '<p>Hi</p>', list: 'nobody' });
  const started = await post(`/api/campaigns/${empty}/start`);
  assert.equal(started.status, 400);
  assert.match(started.body.error, /already been emailed/);
  assert.equal((await call('DELETE', `/api/campaigns/${empty}`)).status, 200);
});

test('a test email is handed out first, filled in with a real contact', async () => {
  assert.equal((await post(`/api/campaigns/${campaignId}/test`, { email: 'bad' })).status, 400);
  assert.equal((await post(`/api/campaigns/${campaignId}/test`, { email: 'me@example.com' })).status, 200);

  const { body } = await post('/api/runner/claim', { sender: 'me@gmail.com' });
  assert.equal(body.messages.length, 1);
  const [message] = body.messages;
  assert.equal(message.test, true);
  assert.equal(message.to, 'me@example.com');
  assert.equal(message.contact.email, 'ed@example.com', 'the newest contact, as in the preview');
  assert.match(message.token, /^[a-f0-9]{24}$/);
  assert.equal(body.campaigns[campaignId].subject, 'Hello {{first_name}}');
  assert.equal(body.inbox.watch, false);
  await post('/api/runner/report', { results: [{ id: message.id, status: 'sent' }] });

  const overview = (await get('/api/overview')).body;
  assert.equal(overview.mailboxes.find((mailbox) => mailbox.id === mailboxId).email, 'me@gmail.com');
  assert.equal((await get(`/api/campaigns/${campaignId}`)).body.stats.total, 0, 'tests stay out of the statistics');
});

test('starting queues one email per active contact and locks the content', async () => {
  await post('/api/contacts/status', { ids: [(await get('/api/contacts?q=ed@')).body.rows[0].id], status: 'unsubscribed' });
  const started = await post(`/api/campaigns/${campaignId}/start`);
  assert.deepEqual(started.body, { queued: 4, started: false });
  assert.equal((await post(`/api/campaigns/${campaignId}/start`)).status, 409);
  assert.equal((await call('PUT', `/api/campaigns/${campaignId}`, { subject: 'Changed' })).status, 409);
  const { stats, campaign } = (await get(`/api/campaigns/${campaignId}`)).body;
  assert.equal(campaign.status, 'sending');
  assert.deepEqual({ total: stats.total, pending: stats.pending, sent: stats.sent }, { total: 4, pending: 4, sent: 0 });
});

test('the runner gets batches within the batch size and the daily limit', async () => {
  // One test email was already sent today, so a daily limit of 4 leaves room for 3.
  await call('PUT', `/api/mailboxes/${mailboxId}`, { batch_size: 2, delay_seconds: 1, daily_limit: 4 });

  batch = (await post('/api/runner/claim')).body.messages;
  assert.deepEqual(batch.map((message) => message.to), ['ann@example.com', 'bo@example.com']);
  assert.equal(batch[0].contact.fields.truck_make, 'Volvo');
  assert.equal(batch[0].test, false);

  // Paused campaigns hand out nothing.
  await post(`/api/campaigns/${campaignId}/pause`);
  assert.equal((await post('/api/runner/claim')).body.messages.length, 0);
  await post(`/api/campaigns/${campaignId}/resume`);

  const next = (await post('/api/runner/claim')).body.messages;
  assert.deepEqual(next.map((message) => message.to), ['cy@example.com'], 'only one more fits under the daily limit');
  batch.push(...next);
  assert.equal((await post('/api/runner/claim')).body.messages.length, 0);
});

test('results from the runner update the statuses', async () => {
  const [ann, bo] = batch;
  await post('/api/runner/report', {
    results: [
      { id: ann.id, status: 'sent', at: minutesAgo(10) },
      { id: bo.id, status: 'sent', at: minutesAgo(10) },
    ],
  });
  let { stats } = (await get(`/api/campaigns/${campaignId}`)).body;
  assert.deepEqual({ pending: stats.pending, sent: stats.sent, delivered: stats.delivered }, { pending: 2, sent: 2, delivered: 0 });

  // After an inbox check with no bounce, emails sent a while ago count as delivered.
  await post('/api/runner/report', { synced: true, cursor: { uidValidity: '1', uid: 7 }, run: { sent: 2, failed: 0 } });
  ({ stats } = (await get(`/api/campaigns/${campaignId}`)).body);
  assert.equal(stats.delivered, 2);

  const claim = (await post('/api/runner/claim')).body;
  assert.deepEqual(claim.inbox, { watch: true, cursor: { uidValidity: '1', uid: 7 } });
  assert.deepEqual(claim.messages, [], 'the daily limit still holds');
  assert.equal((await get('/api/overview')).body.mailboxes.find((mailbox) => mailbox.id === mailboxId).last_run.sent, 2);
});

test('opens, clicks and unsubscribes are recorded from the email links', async () => {
  const [ann, bo] = batch;
  await server.fetch(`/o/${ann.token}.gif`);
  await server.fetch(`/o/${ann.token}.gif`);

  const click = await server.fetch(`/c/${bo.token}/0`, { redirect: 'manual' });
  assert.equal(click.status, 302);
  assert.equal(click.headers.get('Location'), 'https://app.example.com/get');
  assert.equal((await server.fetch(`/c/${bo.token}/5`, { redirect: 'manual' })).status, 404);
  assert.equal((await server.fetch(`/c/${'f'.repeat(24)}/0`, { redirect: 'manual' })).status, 404);

  // Opening the unsubscribe link only asks; confirming does it.
  assert.match(await (await server.fetch(`/u/${ann.token}`)).text(), /<form method="post">/);
  assert.equal((await get('/api/contacts?q=ann@')).body.rows[0].status, 'active');
  assert.match(await (await server.fetch(`/u/${ann.token}`, { method: 'POST' })).text(), /You are unsubscribed/);
  assert.equal((await get('/api/contacts?q=ann@')).body.rows[0].status, 'unsubscribed');

  const { stats } = (await get(`/api/campaigns/${campaignId}`)).body;
  assert.deepEqual(
    { opened: stats.opened, clicked: stats.clicked, unsubscribed: stats.unsubscribed },
    { opened: 2, clicked: 1, unsubscribed: 1 },
  );
  const rows = (await get(`/api/campaigns/${campaignId}/messages?stage=opened`)).body.rows;
  assert.deepEqual(rows.map((row) => [row.email, row.open_count, row.click_count]), [
    ['ann@example.com', 2, 0],
    ['bo@example.com', 0, 1],
  ]);
});

test('replies and bounces found in the inbox are matched to their email', async () => {
  const [ann] = batch;
  await post('/api/runner/report', {
    events: [
      { type: 'reply', token: ann.token, at: minutesAgo(1), snippet: 'Sounds good, send me the link.' },
      { type: 'reply', token: 'f'.repeat(24), snippet: 'Unrelated' },
      { type: 'bounce', token: '', email: 'BO@example.com', permanent: true, reason: '550 5.1.1 No such user' },
    ],
  });
  const { stats } = (await get(`/api/campaigns/${campaignId}`)).body;
  assert.deepEqual(
    { sent: stats.sent, delivered: stats.delivered, replied: stats.replied, bounced: stats.bounced },
    { sent: 2, delivered: 1, replied: 1, bounced: 1 },
  );
  const [reply] = (await get(`/api/campaigns/${campaignId}/messages?stage=replied`)).body.rows;
  assert.equal(reply.email, 'ann@example.com');
  assert.equal(reply.reply_snippet, 'Sounds good, send me the link.');
  const [bounce] = (await get(`/api/campaigns/${campaignId}/messages?stage=bounced`)).body.rows;
  assert.equal(bounce.error, '550 5.1.1 No such user');
  assert.equal((await get('/api/contacts?q=bo@')).body.rows[0].status, 'bounced');
});

test('contacts who leave before their turn are skipped, and the campaign finishes', async () => {
  // The run stopped before reaching Cy, so that email goes back to the queue.
  await post('/api/runner/report', { results: [{ id: batch[2].id, status: 'queued' }] });
  await call('PUT', `/api/mailboxes/${mailboxId}`, { batch_size: 10, delay_seconds: 1, daily_limit: 100 });
  const di = (await get('/api/contacts?q=di@')).body.rows[0];
  assert.deepEqual((await post('/api/contacts/delete', { ids: [di.id] })).body, { deleted: 1 });

  const { messages } = (await post('/api/runner/claim')).body;
  assert.deepEqual(messages.map((message) => message.to), ['cy@example.com']);
  await post('/api/runner/report', { results: [{ id: messages[0].id, status: 'failed', error: '550 mailbox unavailable' }], run: { sent: 0, failed: 1 } });

  const { campaign, stats } = (await get(`/api/campaigns/${campaignId}`)).body;
  assert.equal(campaign.status, 'done');
  assert.deepEqual({ total: stats.total, pending: stats.pending, failed: stats.failed }, { total: 4, pending: 0, failed: 2 });
  const failed = (await get(`/api/campaigns/${campaignId}/messages?stage=failed`)).body.rows;
  assert.deepEqual(failed.map((row) => [row.email, row.status, row.name]), [
    ['cy@example.com', 'failed', 'Cy'],
    ['di@example.com', 'skipped', null],
  ]);
});

test('a campaign can be copied into a new draft', async () => {
  const copyId = (await post('/api/campaigns', { copy_of: campaignId })).body.id;
  const { campaign, stats } = (await get(`/api/campaigns/${copyId}`)).body;
  assert.deepEqual([campaign.name, campaign.status, campaign.body_html, stats.total], ['Launch (copy)', 'draft', BODY, 0]);
  const list = (await get('/api/campaigns')).body.campaigns;
  assert.deepEqual(list.map((item) => [item.name, item.stats.sent]), [['Launch (copy)', 0], ['Launch', 2]]);
});

test('uploaded images are served publicly', async () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  assert.equal((await post('/api/images', { type: 'image/svg+xml', data: png })).status, 400);
  const { body } = await post('/api/images', { type: 'image/png', data: png });
  assert.match(body.url, /\/img\/[a-f0-9]{24}\.png$/);
  const image = await server.fetch(new URL(body.url).pathname);
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(png, 'base64'));
  assert.equal((await server.fetch(`/img/${'0'.repeat(24)}.png`)).status, 404);
});

test('nobody is emailed twice, and a reply is recognised by its sender', async () => {
  // Ann and Bo were emailed, Cy's email failed, Di was deleted and Ed unsubscribed: only Cy is left.
  assert.equal((await get('/api/overview')).body.lists[0].available, 1);
  const second = (await post('/api/campaigns')).body.id;
  await call('PUT', `/api/campaigns/${second}`, { name: 'Second', subject: 'Hi', body_html: '<p>Hi</p>', list: 'drivers' });
  assert.deepEqual((await post(`/api/campaigns/${second}/start`)).body, { queued: 1, started: false });

  const [cy] = (await post('/api/runner/claim')).body.messages;
  assert.equal(cy.to, 'cy@example.com');
  await post('/api/runner/report', { results: [{ id: cy.id, status: 'sent', at: minutesAgo(10) }] });

  const emailed = (await get('/api/contacts?status=emailed')).body.rows.map((row) => row.email);
  assert.deepEqual(emailed.sort(), ['ann@example.com', 'bo@example.com', 'cy@example.com']);
  assert.deepEqual((await get('/api/contacts?status=new')).body.rows.map((row) => row.email), ['ed@example.com']);

  const third = (await post('/api/campaigns')).body.id;
  await call('PUT', `/api/campaigns/${third}`, { name: 'Third', subject: 'Hi', body_html: '<p>Hi</p>', list: 'drivers' });
  const refused = await post(`/api/campaigns/${third}/start`);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /already been emailed/);

  // A new email from Cy, not quoting ours, still counts as a reply.
  assert.deepEqual((await post('/api/runner/match', { emails: ['CY@example.com', 'stranger@example.com'] })).body, { emails: ['cy@example.com'] });
  await post('/api/runner/report', { events: [{ type: 'reply', token: '', email: 'cy@example.com', at: minutesAgo(1), snippet: 'Tell me more' }] });
  assert.equal((await get(`/api/campaigns/${second}`)).body.stats.replied, 1);
  assert.deepEqual((await post('/api/runner/match', { emails: ['cy@example.com'] })).body, { emails: [] }, 'already replied');
});

test('an address already in the contacts is never added again, however it is written', async () => {
  const known = await post('/api/contacts/existing', { emails: ['Ann <ANN@example.com>', 'new@example.com', 'bo\u200B@example.com'] });
  assert.deepEqual(known.body.existing.sort(), ['ann@example.com', 'bo@example.com']);
  const imported = await post('/api/contacts/import', { list: 'again', rows: [{ email: ' ANN@example.com\uFEFF' }, { email: 'Bo <bo@example.com>' }] });
  assert.deepEqual(imported.body, { added: 0, existing: 2, invalid: 0 });
});

test('files are attached in parts, copied with the campaign and handed to the runner', async () => {
  const id = (await post('/api/campaigns')).body.id;
  await call('PUT', `/api/campaigns/${id}`, { name: 'With a file', subject: 'Hi', body_html: '<p>Hi</p>', list: 'drivers' });

  const refused = await post(`/api/campaigns/${id}/attachments`, { name: 'driver-app.apk', type: 'application/vnd.android.package-archive', size: 10 });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Gmail does not send \.apk files/);

  const bytes = Buffer.alloc(1_500_000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const created = await post(`/api/campaigns/${id}/attachments`, { name: 'C:\\docs\\flyer.pdf', type: 'application/pdf', size: bytes.length });
  assert.equal(created.body.parts, 2, '1.5 MB is stored in two parts');
  const fileId = created.body.id;
  await call('PUT', `/api/attachments/${fileId}/parts/0`, { data: bytes.subarray(0, 1_400_000).toString('base64') });

  let { attachments } = (await get(`/api/campaigns/${id}`)).body;
  assert.deepEqual(attachments.map((file) => [file.name, file.complete]), [['flyer.pdf', false]]);
  const early = await post(`/api/campaigns/${id}/test`, { email: 'me@example.com' });
  assert.equal(early.status, 400);
  assert.match(early.body.error, /did not finish uploading/);

  assert.equal((await call('PUT', `/api/attachments/${fileId}/parts/2`, { data: 'AAAA' })).status, 400, 'no third part');
  await call('PUT', `/api/attachments/${fileId}/parts/1`, { data: bytes.subarray(1_400_000).toString('base64') });
  ({ attachments } = (await get(`/api/campaigns/${id}`)).body);
  assert.deepEqual(attachments.map((file) => [file.name, file.type, file.size, file.complete]), [['flyer.pdf', 'application/pdf', 1_500_000, true]]);

  // The runner gets the file's description with the test email, and fetches the parts.
  assert.equal((await post(`/api/campaigns/${id}/test`, { email: 'me@example.com' })).status, 200);
  const { messages, campaigns } = (await post('/api/runner/claim')).body;
  assert.equal(messages.length, 1);
  assert.deepEqual(campaigns[id].attachments, [{ id: fileId, name: 'flyer.pdf', type: 'application/pdf', size: 1_500_000, parts: 2 }]);
  const parts = await Promise.all([0, 1].map(async (part) => Buffer.from((await post('/api/runner/part', { id: fileId, part })).body.data, 'base64')));
  assert.ok(Buffer.concat(parts).equals(bytes));
  await post('/api/runner/report', { results: [{ id: messages[0].id, status: 'sent' }] });

  // A copy carries its own copy of the file; removing it from the copy leaves the original alone.
  const copy = (await post('/api/campaigns', { copy_of: id })).body.id;
  const [copied] = (await get(`/api/campaigns/${copy}`)).body.attachments;
  assert.deepEqual([copied.name, copied.complete], ['flyer.pdf', true]);
  assert.notEqual(copied.id, fileId);
  assert.equal((await call('DELETE', `/api/attachments/${copied.id}`)).status, 200);
  assert.deepEqual((await get(`/api/campaigns/${copy}`)).body.attachments, []);
  assert.equal((await get(`/api/campaigns/${id}`)).body.attachments.length, 1);

  // Deleting a campaign removes its files too.
  assert.equal((await call('DELETE', `/api/campaigns/${id}`)).status, 200);
  assert.equal((await post('/api/runner/part', { id: fileId, part: 0 })).status, 404);
});

test('a campaign can cap how many of its available contacts to queue', async () => {
  await post('/api/contacts/import', {
    list: 'big-list',
    rows: [{ email: 'a1@example.com' }, { email: 'a2@example.com' }, { email: 'a3@example.com' }, { email: 'a4@example.com' }, { email: 'a5@example.com' }],
  });

  const id = (await post('/api/campaigns')).body.id;
  await call('PUT', `/api/campaigns/${id}`, { name: 'Batch 1', subject: 'Hi', body_html: '<p>Hi</p>', list: 'big-list', send_limit: 2 });
  assert.equal((await get(`/api/campaigns/${id}`)).body.campaign.send_limit, 2);

  assert.equal((await call('PUT', `/api/campaigns/${id}`, { send_limit: 0 })).status, 400);
  assert.equal((await call('PUT', `/api/campaigns/${id}`, { send_limit: -3 })).status, 400);
  assert.equal((await call('PUT', `/api/campaigns/${id}`, { send_limit: 'lots' })).status, 400);

  const started = await post(`/api/campaigns/${id}/start`);
  assert.deepEqual(started.body, { queued: 2, started: false });
  const { rows } = (await get(`/api/campaigns/${id}/messages`)).body;
  assert.deepEqual(rows.map((row) => row.email), ['a1@example.com', 'a2@example.com']);

  // The other 3 contacts on the list were never queued, so they stay available for another campaign.
  assert.equal((await get('/api/overview')).body.lists.find((item) => item.list === 'big-list').available, 3);
  const second = (await post('/api/campaigns')).body.id;
  await call('PUT', `/api/campaigns/${second}`, { name: 'Batch 2', subject: 'Hi', body_html: '<p>Hi</p>', list: 'big-list', send_limit: 100 });
  const startedSecond = await post(`/api/campaigns/${second}/start`);
  assert.deepEqual(startedSecond.body, { queued: 3, started: false }, 'a cap larger than what is left just takes everyone left');

  // A copy keeps the same cap.
  const copy = (await post('/api/campaigns', { copy_of: id })).body.id;
  assert.equal((await get(`/api/campaigns/${copy}`)).body.campaign.send_limit, 2);

  // Once a campaign has started, its cap is fixed, like its audience.
  assert.equal((await call('PUT', `/api/campaigns/${id}`, { send_limit: 5 })).status, 409);
  assert.equal((await get(`/api/campaigns/${id}`)).body.campaign.send_limit, 2);
});

test('a second mailbox needs an explicit choice, and each mailbox paces and tracks itself', async () => {
  const second = await post('/api/mailboxes', { email: 'second@gmail.com', name: 'Second', sender_name: 'Second Road', batch_size: 1, delay_seconds: 1, daily_limit: 2 });
  assert.equal(second.status, 200);
  const secondId = second.body.id;

  await post('/api/contacts/import', { list: 'multi', rows: [{ email: 'mx1@example.com' }, { email: 'mx2@example.com' }, { email: 'mx3@example.com' }] });
  const id = (await post('/api/campaigns')).body.id;
  await call('PUT', `/api/campaigns/${id}`, { name: 'Multi', subject: 'Hi', body_html: '<p>Hi</p>', list: 'multi' });

  // With two mailboxes now, nothing is auto-picked: starting or testing without a choice is refused.
  const refused = await post(`/api/campaigns/${id}/start`);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Choose which mailbox/);

  await call('PUT', `/api/campaigns/${id}`, { name: 'Multi', subject: 'Hi', body_html: '<p>Hi</p>', list: 'multi', mailbox_id: secondId });
  assert.deepEqual((await post(`/api/campaigns/${id}/start`)).body, { queued: 3, started: false });

  // The first mailbox never sees these messages: they belong to the second.
  const firstClaim = (await post('/api/runner/claim', { sender: 'me@gmail.com' })).body.messages;
  assert.ok(!firstClaim.some((message) => message.to.startsWith('mx')), "none of the second mailbox's messages turn up here");
  const second1 = (await post('/api/runner/claim', { sender: 'second@gmail.com' })).body.messages;
  assert.deepEqual(second1.map((message) => message.to), ['mx1@example.com'], 'the second mailbox has its own batch size of 1');
  await post('/api/runner/report', { sender: 'second@gmail.com', results: [{ id: second1[0].id, status: 'sent' }] });
  const second2 = (await post('/api/runner/claim', { sender: 'second@gmail.com' })).body.messages;
  assert.deepEqual(second2.map((message) => message.to), ['mx2@example.com'], 'its own daily limit of 2 leaves room for one more');
  await post('/api/runner/report', { sender: 'second@gmail.com', results: [{ id: second2[0].id, status: 'sent' }] });
  assert.deepEqual((await post('/api/runner/claim', { sender: 'second@gmail.com' })).body.messages, [], 'now at its daily limit');

  // The first mailbox's own batch size (2) and daily limit (4, with none used yet) are unaffected.
  await post('/api/contacts/import', { list: 'drivers2', rows: [{ email: 'd1@example.com' }, { email: 'd2@example.com' }] });
  const firstCampaign = (await post('/api/campaigns')).body.id;
  await call('PUT', `/api/campaigns/${firstCampaign}`, { name: 'First', subject: 'Hi', body_html: '<p>Hi</p>', list: 'drivers2', mailbox_id: mailboxId });
  await post(`/api/campaigns/${firstCampaign}/start`);
  const first1 = (await post('/api/runner/claim', { sender: 'me@gmail.com' })).body.messages;
  assert.deepEqual(first1.map((message) => message.to), ['d1@example.com', 'd2@example.com']);

  // Each mailbox's run summary and inbox cursor are kept apart.
  const firstBefore = (await get('/api/overview')).body.mailboxes.find((mailbox) => mailbox.id === mailboxId);
  await post('/api/runner/report', { sender: 'second@gmail.com', cursor: { uid: 99 }, run: { sent: 55, failed: 0, replies: 0, bounces: 0 } });
  const overview = (await get('/api/overview')).body;
  const secondMailbox = overview.mailboxes.find((mailbox) => mailbox.id === secondId);
  assert.equal(secondMailbox.last_run.sent, 55);
  assert.deepEqual(
    overview.mailboxes.find((mailbox) => mailbox.id === mailboxId),
    firstBefore,
    "the first mailbox's own run summary was not touched by the second mailbox's report",
  );
  const claimAsSecond = (await post('/api/runner/claim', { sender: 'second@gmail.com' })).body;
  assert.equal(claimAsSecond.inbox.cursor.uid, 99);

  // Pausing a mailbox refuses even a test through it, and leaves the other mailbox untouched.
  // Pause/resume only ever sends `status`, so the rest must survive untouched.
  await call('PUT', `/api/mailboxes/${secondId}`, { status: 'paused' });
  const pausedMailbox = (await get('/api/overview')).body.mailboxes.find((mailbox) => mailbox.id === secondId);
  assert.deepEqual(
    { name: pausedMailbox.name, sender_name: pausedMailbox.sender_name, batch_size: pausedMailbox.batch_size },
    { name: 'Second', sender_name: 'Second Road', batch_size: 1 },
  );
  const refusedTest = await post(`/api/campaigns/${id}/test`, { email: 'me@example.com' });
  assert.equal(refusedTest.status, 400);
  assert.match(refusedTest.body.error, /"Second" mailbox is paused/);
  assert.deepEqual((await post('/api/runner/claim', { sender: 'second@gmail.com' })).body.messages, [], 'a paused mailbox hands out nothing');
  assert.equal((await post(`/api/campaigns/${firstCampaign}/test`, { email: 'me@example.com' })).status, 200, 'the other mailbox is unaffected');

  // A mailbox cannot be deleted while a campaign is still sending through it.
  const blocked = await call('DELETE', `/api/mailboxes/${secondId}`);
  assert.equal(blocked.status, 409);
});

test('deleting a mailbox clears it from draft campaigns but keeps their results', async () => {
  const doomed = await post('/api/mailboxes', { email: 'doomed@gmail.com', name: 'Doomed' });
  const doomedId = doomed.body.id;
  const draft = (await post('/api/campaigns')).body.id;
  await call('PUT', `/api/campaigns/${draft}`, { mailbox_id: doomedId });
  assert.equal((await get(`/api/campaigns/${draft}`)).body.campaign.mailbox_id, doomedId);

  assert.equal((await call('DELETE', `/api/mailboxes/${doomedId}`)).status, 200);
  assert.equal((await get(`/api/campaigns/${draft}`)).body.campaign.mailbox_id, null);
  assert.equal((await call('DELETE', `/api/mailboxes/${doomedId}`)).status, 404);
  await call('DELETE', `/api/campaigns/${draft}`);
});
