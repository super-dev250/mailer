// One run: send the next batch of emails, then look in the mailbox for replies and bounces.

import { explainSendError } from './send.js';

const TIME_BUDGET = 20 * 60_000; // stay well inside the workflow's 30 minute timeout
const SETTLE = 20_000; // a bounce for a wrong address comes back within seconds of sending
const REPORT_SIZE = 20;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const chunks = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size));

/**
 * @param app client of the web app (see app.js)
 * @param mailer sends one email (see send.js)
 * @param checkInbox reads the mailbox (see inbox.js)
 * @returns what happened: { sent, failed, replies, bounces, error }
 */
export async function run({ app, mailer, checkInbox, user, log = console.log, pause = sleep }) {
  const startedAt = Date.now();
  const summary = { sent: 0, failed: 0, replies: 0, bounces: 0, error: '' };
  const work = await app.claim(user);
  const delay = work.settings.delay_seconds * 1000;

  const queue = [...work.messages];
  log(`${queue.length} email(s) to send.`);
  try {
    while (queue.length && Date.now() - startedAt < TIME_BUDGET) {
      const message = queue[0];
      let failure = null;
      try {
        await mailer.send({
          message,
          campaign: work.campaigns[message.campaign_id],
          settings: work.settings,
          baseUrl: work.base_url,
        });
      } catch (error) {
        failure = explainSendError(error);
        if (failure.stop) {
          summary.error = failure.reason;
          break;
        }
      }
      queue.shift();
      // Reported one by one: if the run dies, at most one email is left in an unknown state.
      if (failure) {
        await app.report({
          results: [{ id: message.id, status: 'failed', error: failure.reason, bad_address: failure.badAddress }],
        });
        summary.failed++;
        // The reason can quote the recipient's address, so it goes to the report, not the log.
        log(`Email #${message.id} was refused. The campaign report shows why.`);
      } else {
        await app.report({ results: [{ id: message.id, status: 'sent', at: new Date().toISOString() }] });
        summary.sent++;
        log(`Email #${message.id} sent.`);
        // An uneven rhythm looks less like a machine.
        if (queue.length) await pause(delay * (0.75 + Math.random() / 2));
      }
    }
  } finally {
    mailer.close();
  }
  // Whatever was not attempted goes back to the queue for the next run.
  for (const group of chunks(queue, REPORT_SIZE)) {
    await app.report({ results: group.map(({ id }) => ({ id, status: 'queued' })) });
  }

  let checked = {};
  if (work.inbox.watch || summary.sent) {
    try {
      if (summary.sent) await pause(SETTLE);
      const found = await checkInbox({ cursor: work.inbox.cursor, stuck: work.stuck });
      for (const group of chunks(found.reconciled, REPORT_SIZE)) await app.report({ results: group });
      for (const group of chunks(found.events, REPORT_SIZE)) await app.report({ events: group });
      summary.replies = found.events.filter((event) => event.type === 'reply').length;
      summary.bounces = found.events.filter((event) => event.type === 'bounce').length;
      checked = { cursor: found.cursor, synced: true };
      log(`Mailbox checked: ${summary.replies} reply(ies), ${summary.bounces} bounce(s).`);
    } catch (error) {
      const hint = error.authenticationFailed ? ' Check GMAIL_USER and GMAIL_APP_PASSWORD.' : '';
      summary.error ||= `Could not check the mailbox for replies: ${error.responseText || error.message}.${hint}`;
    }
  }

  await app.report({ ...checked, run: summary });
  return summary;
}
