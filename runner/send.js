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

export function createMailer({ user, transport }) {
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

/**
 * Decides what a failed send means: `stop` ends the run and leaves the remaining emails queued,
 * otherwise only this one email is marked as failed. `badAddress` says the mail server refused
 * the recipient itself, so the contact should not be mailed again.
 */
export function explainSendError(error) {
  const detail = String(error.response || error.message || error).replace(/\s+/g, ' ').trim();
  if (error.code === 'EAUTH') {
    return { stop: true, reason: `The mailbox rejected the login. Check GMAIL_USER and GMAIL_APP_PASSWORD, or BREVO_SMTP_LOGIN and BREVO_SMTP_KEY if sending through Brevo. (${detail})` };
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
