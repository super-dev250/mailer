// Sends one email through the mailbox's SMTP server.

import { convert } from 'html-to-text';
import nodemailer from 'nodemailer';
import { renderEmail } from '../app/public/shared/email.js';

/**
 * The Message-ID carries the email's token. Replies quote it in their References header,
 * which is how a reply is matched back to the email it answers.
 */
export const messageId = (token, user) => `<mailer-${token}@${user.split('@')[1]}>`;

const toText = (html) =>
  convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'img', format: 'skip' },
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
    ],
  });

export function createMailer({ user, transport, brevoApiKey }) {
  return brevoApiKey ? createBrevoMailer({ user, apiKey: brevoApiKey }) : createSmtpMailer({ user, transport });
}

function createSmtpMailer({ user, transport }) {
  // One connection for the whole batch instead of a new login per email.
  const connection = nodemailer.createTransport({ ...transport, pool: true, maxConnections: 1 });

  return {
    async send({ message, campaign, settings, baseUrl }) {
      const { subject, html, unsubscribeUrl } = renderEmail({
        campaign,
        contact: message.contact,
        settings,
        token: message.token,
        baseUrl,
        test: message.test,
      });
      await connection.sendMail({
        from: { name: settings.sender_name, address: user },
        to: message.to,
        subject,
        html,
        text: toText(html),
        attachments: campaign.files ?? [],
        messageId: messageId(message.token, user),
        // With the footer on, mail apps also get the unsubscribe link, for their own unsubscribe button.
        headers: settings.footer
          ? { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
          : {},
      });
    },
    close: () => connection.close(),
  };
}

// Sends through Brevo's HTTP API instead of its SMTP relay. The API isn't locked to a
// pre-authorized IP the way Brevo's SMTP login is, so it works from GitHub's shared runners.
function createBrevoMailer({ user, apiKey }) {
  return {
    async send({ message, campaign, settings, baseUrl }) {
      const { subject, html, unsubscribeUrl } = renderEmail({
        campaign,
        contact: message.contact,
        settings,
        token: message.token,
        baseUrl,
        test: message.test,
      });
      const headers = { 'Message-ID': messageId(message.token, user) };
      if (settings.footer) {
        headers['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
        headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
      }
      // Brevo rejects an empty "attachment" array outright ("missing_parameter: attachment is
      // missing") rather than treating it as no attachments, so the field is left out entirely
      // when there is nothing to attach.
      const attachment = (campaign.files ?? []).map((file) => ({ name: file.filename, content: file.content.toString('base64') }));
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: settings.sender_name, email: user },
          to: [{ email: message.to }],
          subject,
          htmlContent: html,
          textContent: toText(html),
          headers,
          ...(attachment.length ? { attachment } : {}),
        }),
      });
      if (!response.ok) throw await brevoError(response);
    },
    close: () => {},
  };
}

async function brevoError(response) {
  const body = await response.json().catch(() => ({}));
  const detail = [body.code, body.message].filter(Boolean).join(': ') || `Brevo responded ${response.status}`;
  const error = new Error(detail);
  error.response = `${response.status} ${detail}`;
  error.responseCode = response.status;
  // Brevo's API: 401 is a bad or revoked key; 400 is usually the request itself, most often a
  // recipient address Brevo won't accept — the two cases explainSendError below already handles.
  if (response.status === 401) error.code = 'EAUTH';
  if (response.status === 400) error.code = 'EENVELOPE';
  return error;
}

/**
 * Decides what a failed send means: `stop` ends the run and leaves the remaining emails queued,
 * otherwise only this one email is marked as failed. `badAddress` says the mail server refused
 * the recipient itself, so the contact should not be mailed again.
 */
export function explainSendError(error) {
  const detail = String(error.response || error.message || error).replace(/\s+/g, ' ').trim();
  if (error.code === 'EAUTH') {
    return { stop: true, reason: `The mailbox rejected the login. Check GMAIL_USER and GMAIL_APP_PASSWORD, or BREVO_API_KEY if sending through Brevo. (${detail})` };
  }
  if (/5\.4\.5|sending limit|quota exceeded/i.test(detail)) {
    return { stop: true, reason: `The mailbox reached its sending limit, so the rest waits for a later run. (${detail})` };
  }
  // A permanent refusal of this address or this message. The rest of the batch can go on.
  if (error.responseCode >= 500 || error.code === 'EENVELOPE') {
    return { stop: false, reason: detail, badAddress: error.code === 'EENVELOPE' && error.responseCode >= 500 };
  }
  return { stop: true, reason: `Sending was interrupted, so the rest waits for the next run. (${detail})` };
}
