import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanEmail, extractLinks, fieldKey, fillTags, findTags, mergeValues, renderEmail } from '../app/public/shared/email.js';

const settings = {
  sender_name: 'Sam Road',
  footer: true,
  postal_address: '1 Depot Way\nAustin, TX',
  unsubscribe_text: 'Unsubscribe',
  track_opens: true,
  track_clicks: true,
};
const contact = { email: 'lee@example.com', name: 'Lee Carter', fields: { truck: 'Volvo <VNL>' } };
const base = 'https://mailer.example.workers.dev';
const token = 'a'.repeat(24);

test('merge tags use contact fields, a derived first name and fallbacks', () => {
  const values = mergeValues(contact);
  assert.equal(fillTags('Hi {{first_name}} / {{ Name }} / {{truck}}', values), 'Hi Lee / Lee Carter / Volvo <VNL>');
  assert.equal(fillTags('Hi {{first_name|there}},', mergeValues({ email: 'x@example.com' })), 'Hi there,');
  assert.equal(fillTags('[{{missing}}]', values), '[]');
  assert.deepEqual(findTags('{{first_name|there}} {{truck}} {{first_name}}'), ['first_name', 'truck']);
});

test('one address written different ways is cleaned to the same form', () => {
  const same = ['lee@example.com', ' LEE@Example.com ', 'Lee Carter <lee@example.com>', 'mailto:lee@example.com', 'lee@example.com.', 'lee\u200B@example.com\uFEFF'];
  assert.deepEqual([...new Set(same.map(cleanEmail))], ['lee@example.com']);
  assert.equal(cleanEmail('no address here'), '');
  assert.equal(cleanEmail(undefined), '');
});

test('column names become merge tag names', () => {
  assert.equal(fieldKey(' First Name '), 'first_name');
  assert.equal(fieldKey('Truck #'), 'truck');
  assert.equal(fieldKey('Имя'), 'имя');
});

test('only real web links with ordinary text are tracked', () => {
  const html = `
    <a href="https://app.example.com/get?a=1&amp;b=2">Get the app</a>
    <a class="x" href='https://app.example.com/get?a=1&amp;b=2'><b>Again</b></a>
    <a href="https://example.com">https://example.com</a>
    <a href="https://example.com/docs">example.com/docs</a>
    <a href="mailto:me@example.com">Email me</a>
    <a href="{{unsubscribe_url}}">Stop</a>
    <a href="https://play.example.com">Android</a>`;
  assert.deepEqual(extractLinks(html), ['https://app.example.com/get?a=1&b=2', 'https://play.example.com']);
});

test('a sent email carries tracking, personalisation, footer and escaped values', () => {
  const body =
    '<p>Hi {{first_name}}, you drive a {{truck}}.</p><p><a href="https://app.example.com">Get it</a></p><img src="https://x/y.png" width="900">';
  const campaign = { subject: ' Hello  {{first_name}} ', preheader: 'A quick note', body_html: body, links: extractLinks(body) };
  const { subject, html, unsubscribeUrl } = renderEmail({ campaign, contact, settings, token, baseUrl: base });

  assert.equal(subject, 'Hello Lee');
  assert.equal(unsubscribeUrl, `${base}/u/${token}`);
  assert.match(html, /<p style="margin:0 0 16px;">Hi Lee, you drive a Volvo &lt;VNL&gt;\.<\/p>/);
  assert.match(html, new RegExp(`<a href="${base}/c/${token}/0">Get it</a>`));
  assert.match(html, new RegExp(`<img src="${base}/o/${token}\\.gif"`));
  assert.match(html, /<img style="max-width:100%;height:auto;" src="https:\/\/x\/y\.png"/);
  assert.match(html, /Sam Road &middot; 1 Depot Way, Austin, TX<br>/);
  assert.match(html, new RegExp(`<a href="${base}/u/${token}"[^>]*>Unsubscribe</a>`));
  assert.match(html, />A quick note<\/div>/);
});

test('without the footer the email ends with the message', () => {
  const campaign = { subject: 'Hi', preheader: '', body_html: '<p>Bye</p>', links: [] };
  const { html } = renderEmail({ campaign, contact, settings: { ...settings, footer: false }, token, baseUrl: base });
  assert.doesNotMatch(html, /Unsubscribe|1 Depot Way|\/u\//);
  assert.match(html, /<p style="margin:0 0 16px;">Bye<\/p>\n<\/div>/);
});

test('tracking can be switched off, and a preview tracks nothing', () => {
  const body = '<a href="https://app.example.com">Get it</a>';
  const campaign = { subject: 'Hi', preheader: '', body_html: body, links: extractLinks(body) };

  const untracked = renderEmail({
    campaign, contact, token, baseUrl: base,
    settings: { ...settings, track_opens: false, track_clicks: false },
  });
  assert.match(untracked.html, /<a href="https:\/\/app\.example\.com">/);
  assert.doesNotMatch(untracked.html, /\/o\//);

  const preview = renderEmail({ campaign, contact, settings });
  assert.match(preview.html, /<a href="https:\/\/app\.example\.com">/);
  assert.doesNotMatch(preview.html, /\/o\/|\/c\//);
  assert.equal(preview.unsubscribeUrl, '#');

  assert.equal(renderEmail({ campaign, contact, settings, token, baseUrl: base, test: true }).subject, '[Test] Hi');
});
