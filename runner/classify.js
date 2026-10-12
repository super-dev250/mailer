// Decides what a message found in the mailbox means for a campaign: a reply, a bounce, or nothing.

import { simpleParser } from 'mailparser';

const OUR_MESSAGE_ID = /<mailer-([a-f0-9]{24})@/g;

/** Tokens of our own emails mentioned in a piece of text, usually a header. */
export const tokensIn = (text) => [...String(text ?? '').matchAll(OUR_MESSAGE_ID)].map((match) => match[1]);

/** The part of a reply that the person actually wrote, without the quoted original. */
export function snippet(text) {
  const written = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^\s*>/.test(line) || /^\s*-{2,}\s*(original|forwarded) message/i.test(line)) break;
    written.push(line.trim());
  }
  return written
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*\bOn\b[^>]{5,200}(<[^>]*>)?\s*wrote:\s*$/, '')
    .trim()
    .slice(0, 300);
}

/**
 * Cheap test on the headers alone, to decide whether a message is worth downloading.
 * `from` is the sender address, `headers` the raw header lines.
 */
export function isCandidate(from, headers) {
  return (
    tokensIn(headers).length > 0 ||
    /^(mailer-daemon|postmaster)@/i.test(from) ||
    /^x-failed-recipients:/im.test(headers) ||
    /multipart\/report/i.test(headers)
  );
}

/**
 * @param {Buffer} source the raw message
 * @returns the event to report, or null when the message is unrelated
 */
export async function classify(source) {
  const raw = source.toString('latin1');
  const head = raw.slice(0, raw.search(/\r?\n\r?\n/)).replace(/\r?\n[ \t]+/g, ' ');
  const header = (name) => head.match(new RegExp(`^${name}:(.*)$`, 'im'))?.[1].trim() ?? '';

  const mail = await simpleParser(source);
  const from = mail.from?.value?.[0]?.address?.toLowerCase() ?? '';
  const at = (mail.date instanceof Date && !Number.isNaN(mail.date.getTime()) ? mail.date : new Date()).toISOString();

  const failedRecipients = header('x-failed-recipients');
  const isReport =
    /multipart\/report/i.test(header('content-type')) || failedRecipients || /^(mailer-daemon|postmaster)@/.test(from);
  if (isReport) {
    // Only a final failure is a bounce. "delayed" means the mail server is still trying.
    const action = raw.match(/^Action:\s*(\w+)/im)?.[1].toLowerCase();
    if (action ? action !== 'failed' : !failedRecipients) return null;
    const status = raw.match(/^Status:\s*(\d\.\d{1,3}\.\d{1,3})/im)?.[1] ?? '';
    const recipient = failedRecipients || raw.match(/^(?:Final|Original)-Recipient:\s*rfc822;\s*(\S+)/im)?.[1] || '';
    const diagnostic = raw.match(/^Diagnostic-Code:\s*(.+(?:\r?\n[ \t]+.+)*)/im)?.[1].replace(/\s+/g, ' ').trim();
    const email = recipient.split(',')[0].trim().replace(/^<|>$/g, '').toLowerCase();
    // The report quotes the original email, including its Message-ID.
    const token = tokensIn(raw)[0] ?? '';
    if (!token && !email) return null;
    return {
      type: 'bounce',
      token,
      email,
      at,
      permanent: !status.startsWith('4'),
      reason: (diagnostic || `Delivery failed${status ? ` (${status})` : ''}`).slice(0, 300),
    };
  }

  // Out-of-office and other automatic answers are not replies.
  const automatic =
    /^(?!no\b)\S/i.test(header('auto-submitted')) ||
    header('x-autoreply') ||
    header('x-autorespond') ||
    /^(auto_reply|bulk|junk)/i.test(header('precedence'));
  if (automatic) return null;

  const token = tokensIn(header('in-reply-to'))[0] ?? tokensIn(header('references')).at(-1);
  if (!token) return null;
  return { type: 'reply', token, at, snippet: snippet(mail.text) };
}
