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
  assert.equal(overview.sender_email, 'me@gmail.com');
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
  await call('PUT', '/api/settings', { sender_name: 'Sam', batch_size: 2, delay_seconds: 1, daily_limit: 4, track_opens: true, track_clicks: true });

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
  assert.equal((await get('/api/overview')).body.last_run.sent, 2);
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
  await call('PUT', '/api/settings', { sender_name: 'Sam', batch_size: 10, delay_seconds: 1, daily_limit: 100, track_opens: true, track_clicks: true });
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
