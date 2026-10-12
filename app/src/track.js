// Public endpoints that the emails themselves point at. No login: the token in the URL
// is the only thing a recipient has, and it identifies exactly one email.

import { TOKEN } from '../public/shared/email.js';
import { now } from './db.js';

// A transparent 1x1 GIF.
const PIXEL = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=='), (char) =>
  char.charCodeAt(0),
);

export function open({ db, params, waitUntil }) {
  const token = params.token.replace(/\.gif$/, '');
  if (TOKEN.test(token)) {
    waitUntil(
      db
        .prepare(
          `UPDATE messages SET open_count = open_count + 1, opened_at = COALESCE(opened_at, ?1),
             delivered_at = COALESCE(delivered_at, ?1)
           WHERE token = ?2 AND status = 'sent'`,
        )
        .bind(now(), token)
        .run()
        .catch(console.error),
    );
  }
  return new Response(PIXEL, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store, max-age=0' } });
}

export async function click({ db, params, waitUntil }) {
  const gone = new Response('This link is no longer available.', { status: 404 });
  if (!TOKEN.test(params.token)) return gone;
  const row = await db
    .prepare('SELECT m.id, c.id AS campaign_id, c.links FROM messages m JOIN campaigns c ON c.id = m.campaign_id WHERE m.token = ?')
    .bind(params.token)
    .first();
  const index = Number(params.index);
  const target = row && JSON.parse(row.links)[index];
  if (!target || !URL.canParse(target)) return gone;

  // Someone who clicked has also seen the email, even if their mail client blocked the pixel.
  waitUntil(
    db
      .batch([
        db
          .prepare(
            `UPDATE messages SET click_count = click_count + 1, clicked_at = COALESCE(clicked_at, ?1),
               opened_at = COALESCE(opened_at, ?1), delivered_at = COALESCE(delivered_at, ?1)
             WHERE id = ?2 AND status = 'sent'`,
          )
          .bind(now(), row.id),
        // Which link, not just that some link was clicked, so a report can break clicks down per link.
        db
          .prepare('INSERT INTO link_clicks (campaign_id, message_id, link_index, clicked_at) VALUES (?, ?, ?, ?)')
          .bind(row.campaign_id, row.id, index, now()),
      ])
      .catch(console.error),
  );
  return Response.redirect(target, 302);
}

const page = (title, body) =>
  new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; color: #1f2937; background: #f6f7f9; }
  main { max-width: 420px; margin: 15vh auto; padding: 32px; background: #fff; border-radius: 12px; text-align: center; }
  h1 { margin: 0 0 8px; font-size: 20px; }
  p { margin: 0 0 20px; color: #6b7280; }
  button { font: inherit; font-weight: 600; padding: 10px 20px; border: 0; border-radius: 8px; background: #1f2937; color: #fff; cursor: pointer; }
</style>
</head>
<body><main>${body}</main></body>
</html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );

// The link only shows a confirmation, so that mail scanners following links unsubscribe nobody.
export function unsubscribePage() {
  return page(
    'Unsubscribe',
    `<h1>Unsubscribe?</h1><p>You will stop receiving these emails.</p><form method="post"><button>Unsubscribe</button></form>`,
  );
}

// Reached from the button above, and from the one-click unsubscribe of mail clients.
export async function unsubscribe({ db, params }) {
  if (TOKEN.test(params.token)) {
    await db.batch([
      db
        .prepare(
          `UPDATE contacts SET status = 'unsubscribed'
           WHERE status = 'active' AND id = (SELECT contact_id FROM messages WHERE token = ?)`,
        )
        .bind(params.token),
      db
        .prepare('UPDATE messages SET unsubscribed_at = COALESCE(unsubscribed_at, ?) WHERE token = ?')
        .bind(now(), params.token),
    ]);
  }
  return page('Unsubscribed', '<h1>You are unsubscribed</h1><p>You will not receive more emails from this sender.</p>');
}

export async function image({ db, params }) {
  const id = params.file.split('.')[0];
  const row = TOKEN.test(id) ? await db.prepare('SELECT type, data FROM images WHERE id = ?').bind(id).first() : null;
  let binary;
  try {
    binary = atob(row.data);
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Response(bytes, {
    headers: {
      'Content-Type': row.type,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
