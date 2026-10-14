// The safe pace to start a brand-new Gmail mailbox at, and how often GitHub Actions should run.
// Used both as the actual server-side defaults (a new mailbox with no pace of its own, e.g. one
// the runner auto-registers) and as what the app's "Use safe defaults" buttons set the fields to.

// A cautious starting pace for a mailbox with no sending history: spread across the day rather
// than front-loaded into the first couple of runs, and well under Gmail's own 500-a-day cap.
export const DEFAULT_MAILBOX_PACE = { batch_size: 4, delay_seconds: 40, daily_limit: 40 };

// How often the Mailer workflow runs, in minutes. The Worker's own Cloudflare Cron Trigger ticks
// every 5 minutes (see app/wrangler.json) and checks this on each tick, so the real interval is
// this value rounded up to the next multiple of 5. Needs the optional DISPATCH_TOKEN secret to
// take effect reliably; without it, GitHub's own hourly schedule in the workflow file is what runs.
export const DEFAULT_RUN_EVERY_MINUTES = 60;
