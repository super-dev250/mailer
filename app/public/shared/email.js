// Shared by the browser preview, the Worker and the GitHub Actions runner,
// so the preview is produced by the same code that produces the real email.

/** Identifies one email to one recipient. Used in tracking URLs and in the Message-ID. */
export const TOKEN = /^[a-f0-9]{24}$/;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (char) => ESCAPES[char]);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const decodeEntities = (text) => text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => ENTITIES[name]);

// Invisible characters that come along when addresses are copied from web pages, chats or spreadsheets.
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const ADDRESS = /[^\s@,;:<>()[\]"']+@[^\s@,;:<>()[\]"']+\.[^\s@,;:<>()[\]"']+/;

/**
 * The email address found in a piece of text, cleaned up and in lower case, or '' when there is none.
 * "Lee <LEE@Example.com>", "mailto:lee@example.com" and the same address with invisible characters
 * all give "lee@example.com", so they are recognised as one contact.
 */
export function cleanEmail(text) {
  const found = String(text ?? '').replace(INVISIBLE, '').match(ADDRESS)?.[0] ?? '';
  return found.toLowerCase().replace(/\.+$/, '');
}

/** "First Name" -> "first_name": the form used in merge tags and for stored column names. */
export const fieldKey = (label) =>
  String(label ?? '').trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');

const TAG = /\{\{\s*([\p{L}\p{N}_]+)\s*(?:\|([^}]*))?\}\}/gu;

/** The values merge tags can resolve to for one contact. */
export function mergeValues(contact) {
  const fields = contact.fields ?? {};
  const name = String(contact.name ?? '').trim();
  return { ...fields, email: contact.email ?? '', name, first_name: fields.first_name || name.split(/\s+/)[0] };
}

/** Replaces {{field}} and {{field|fallback}}. Pass `escape` when the result is HTML. */
export function fillTags(template, values, escape = (value) => value) {
  return String(template ?? '').replace(TAG, (_, key, fallback) => {
    const value = String(values[key.toLowerCase()] ?? '').trim();
    return value ? escape(value) : (fallback ?? '').trim();
  });
}

/** The field names used by merge tags in a template. */
export function findTags(template) {
  return [...new Set([...String(template ?? '').matchAll(TAG)].map((match) => match[1].toLowerCase()))];
}

const ANCHOR = /<a\b([^>]*?\s)href\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi;
const looksLikeAddress = (text) => /^(https?:\/\/|www\.)\S+$|^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(text);

// Calls `replace(url)` for every link worth tracking and swaps in the URL it returns.
// A link whose visible text is itself a web address is left alone: mail clients warn
// readers when such text points somewhere else.
function mapLinks(html, replace) {
  return html.replace(ANCHOR, (anchor, before, quote, href, after, inner) => {
    const url = decodeEntities(href.trim());
    const label = decodeEntities(inner.replace(/<[^>]*>/g, '')).trim();
    if (!/^https?:\/\//i.test(url) || url.includes('{{') || looksLikeAddress(label)) return anchor;
    const tracked = replace(url);
    return tracked ? `<a${before}href=${quote}${escapeHtml(tracked)}${quote}${after}>${inner}</a>` : anchor;
  });
}

/** The distinct link targets of an email body, in order. A click URL refers to one by its position. */
export function extractLinks(html) {
  const links = [];
  mapLinks(String(html ?? ''), (url) => {
    if (!links.includes(url)) links.push(url);
  });
  return links;
}

// Puts `css` first in a tag's style attribute, so anything the writer set themselves still wins.
function addStyle(tag, css) {
  return /\sstyle\s*=\s*"/i.test(tag)
    ? tag.replace(/(\sstyle\s*=\s*")/i, `$1${css}`)
    : tag.replace(/^<(\w+)/, `<$1 style="${css}"`);
}

// Mail apps disagree on defaults, so the two things that matter most are spelled out:
// images never wider than the screen, and the same space between paragraphs everywhere.
function normalise(html) {
  return html
    .replace(/<img\b[^>]*>/gi, (tag) => (/max-width/i.test(tag) ? tag : addStyle(tag, 'max-width:100%;height:auto;')))
    .replace(/<p\b[^>]*>/gi, (tag) => (/margin/i.test(tag) ? tag : addStyle(tag, 'margin:0 0 16px;')));
}

/**
 * Builds the subject and full HTML of one email.
 * Without a `token` nothing is tracked, which is what the in-app preview uses.
 */
export function renderEmail({ campaign, contact, settings, token = '', baseUrl = '', test = false }) {
  const unsubscribeUrl = token ? `${baseUrl}/u/${token}` : '#';
  const values = { ...mergeValues(contact), unsubscribe_url: unsubscribeUrl };

  let body = String(campaign.body_html ?? '');
  if (token && settings.track_clicks) {
    body = mapLinks(body, (url) => {
      const index = campaign.links.indexOf(url);
      return index < 0 ? null : `${baseUrl}/c/${token}/${index}`;
    });
  }
  body = normalise(fillTags(body, values, escapeHtml));

  const subject = fillTags(campaign.subject, values).replace(/\s+/g, ' ').trim();
  const preheader = fillTags(campaign.preheader, values).trim();
  // Optional (Settings): your name and postal address, and an unsubscribe link.
  let footer = '';
  if (settings.footer) {
    const sender = [settings.sender_name, settings.postal_address]
      .map((part) => String(part ?? '').trim().replace(/\s*\n\s*/g, ', '))
      .filter(Boolean)
      .map(escapeHtml)
      .join(' &middot; ');
    const link = `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280;text-decoration:underline;">${escapeHtml(settings.unsubscribe_text || 'Unsubscribe')}</a>`;
    footer = `<div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#6b7280;">
${sender ? `${sender}<br>` : ''}${link}
</div>
`;
  }
  const pixel = token && settings.track_opens
    ? `<img src="${baseUrl}/o/${token}.gif" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;">`
    : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#ffffff;">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>` : ''}
<div style="max-width:600px;margin:0 auto;padding:24px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#1f2937;">
${body}
${footer}</div>
${pixel}
</body>
</html>`;

  return { subject: test ? `[Test] ${subject}` : subject, html, unsubscribeUrl };
}
