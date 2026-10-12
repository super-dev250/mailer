// Reads the mailbox over IMAP to find replies and bounces that arrived since the last run.

import { ImapFlow } from 'imapflow';
import { classify, isCandidate } from './classify.js';
import { messageId } from './send.js';

const DAY = 24 * 60 * 60_000;
const MAX_DOWNLOAD = 300_000; // enough for the headers, the text and a quoted original

/**
 * @param cursor where the previous run stopped: { path, uidValidity, uid }, or null on the first run
 * @param stuck emails that were being sent when an earlier run died: [{ id, token }]
 * @param matchSenders given sender addresses, resolves to the ones a campaign emailed
 * @returns { events, reconciled, cursor }
 */
export async function checkInbox({ imap, user, cursor, stuck, matchSenders }) {
  const client = new ImapFlow({ ...imap, logger: false });
  await client.connect();
  try {
    // Gmail's "All Mail" also holds replies that were archived or filed before this run, and
    // every sent email. Its name depends on the account language, so it is found by its role.
    const all = (await client.list()).find((box) => box.specialUse === '\\All');
    const path = all?.path ?? 'INBOX';
    const lock = await client.getMailboxLock(path);
    try {
      const uidValidity = String(client.mailbox.uidValidity);
      const resume = cursor && cursor.path === path && cursor.uidValidity === uidValidity;
      const range = resume ? { uid: `${cursor.uid + 1}:*` } : { since: new Date(Date.now() - 2 * DAY) };
      // Everything below this number exists now, so the next run starts after it.
      let last = Math.max(client.mailbox.uidNext - 1, resume ? cursor.uid : 0);

      // No other command may run while a fetch is streaming, so collect first and download after.
      const candidates = [];
      const senders = new Map(); // uid -> sender, for everything else
      const query = { uid: true, envelope: true, headers: ['in-reply-to', 'references', 'content-type', 'x-failed-recipients'] };
      for await (const message of client.fetch(range, query, { uid: true })) {
        last = Math.max(last, message.uid);
        // "n:*" always returns the newest message, even when it is older than n.
        if (resume && message.uid <= cursor.uid) continue;
        const from = message.envelope?.from?.[0]?.address?.toLowerCase() ?? '';
        if (from === user.toLowerCase()) continue;
        if (isCandidate(from, message.headers?.toString() ?? '')) candidates.push(message.uid);
        else if (from) senders.set(message.uid, from);
      }

      // Mail from people a campaign emailed is worth a look too, even when it does not refer to our email.
      const known = senders.size && matchSenders ? new Set(await matchSenders([...new Set(senders.values())])) : new Set();
      const fromKnown = [...senders].filter(([, from]) => known.has(from)).map(([uid]) => uid);

      const events = [];
      for (const uid of [...candidates, ...fromKnown]) {
        const message = await client.fetchOne(String(uid), { source: { maxLength: MAX_DOWNLOAD } }, { uid: true });
        const event = message?.source ? await classify(message.source, { knownSender: fromKnown.includes(uid) }) : null;
        if (event) events.push(event);
      }

      const reconciled = [];
      for (const { id, token } of stuck) {
        if (!all) {
          // Without a folder that is known to hold sent mail there is no way to tell, and
          // sending twice is worse than sending once too few.
          reconciled.push({ id, status: 'failed', error: 'A run was interrupted while sending this email. It may or may not have been sent.' });
          continue;
        }
        const found = await client.search({ header: { 'message-id': messageId(token, user) } }, { uid: true });
        reconciled.push({ id, status: found?.length ? 'sent' : 'queued' });
      }

      return { events, reconciled, cursor: { path, uidValidity, uid: last } };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => client.close());
  }
}
