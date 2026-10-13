// Used by the Mailer workflow to build its matrix: one job per Gmail account in the GMAIL_ACCOUNTS
// secret, or a single job for the older single-mailbox GMAIL_USER/GMAIL_APP_PASSWORD secrets.
// Prints the matrix as JSON, e.g. [0,1,2] or [] when neither secret is set up yet. Never prints
// the secrets themselves, only how many accounts they describe.

const env = process.env;
let count = 0;
if (env.GMAIL_ACCOUNTS?.trim()) {
  try {
    count = JSON.parse(env.GMAIL_ACCOUNTS).length;
  } catch {
    count = 0;
  }
} else if (env.GMAIL_USER?.trim() && env.GMAIL_APP_PASSWORD?.trim()) {
  count = 1;
}
console.log(JSON.stringify(Array.from({ length: count }, (_, i) => i)));
