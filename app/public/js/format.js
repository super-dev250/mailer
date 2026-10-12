const dateTime = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const when = (iso) => (iso ? dateTime.format(new Date(iso)) : '');

export function ago(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 36) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

export const count = (value) => Number(value ?? 0).toLocaleString();

export function percent(part, whole) {
  if (!whole) return '–';
  const value = (part / whole) * 100;
  return value > 0 && value < 1 ? '<1%' : `${Math.round(value)}%`;
}

export const plural = (number, one, many = `${one}s`) => `${count(number)} ${Number(number) === 1 ? one : many}`;

// How far one email got. The blues run light to dark in this order.
export const STAGES = {
  queued: { label: 'Queued', dot: 'var(--stage-queued)' },
  sent: { label: 'Sent', dot: 'var(--stage-sent)' },
  delivered: { label: 'Delivered', dot: 'var(--stage-delivered)' },
  opened: { label: 'Opened', dot: 'var(--stage-opened)' },
  clicked: { label: 'Clicked', dot: 'var(--stage-clicked)' },
  replied: { label: 'Replied', dot: 'var(--stage-replied)' },
  bounced: { label: 'Bounced', dot: 'var(--critical)' },
  failed: { label: 'Not sent', dot: 'var(--critical)', ring: true },
};

/** The furthest stage a recipient row reached. */
export function stageOf(row) {
  if (row.status === 'bounced') return 'bounced';
  if (row.status === 'failed' || row.status === 'skipped') return 'failed';
  if (row.status !== 'sent') return 'queued';
  if (row.replied_at) return 'replied';
  if (row.clicked_at) return 'clicked';
  if (row.opened_at) return 'opened';
  return row.delivered_at ? 'delivered' : 'sent';
}

export const CAMPAIGN_STATUS = {
  draft: { label: 'Draft', dot: 'var(--stage-queued)', ring: true },
  sending: { label: 'Sending', dot: 'var(--stage-opened)' },
  paused: { label: 'Paused', dot: 'var(--warning)' },
  done: { label: 'Finished', dot: 'var(--ink-2)' },
};

export const audienceName = (list) => list || 'All contacts';
