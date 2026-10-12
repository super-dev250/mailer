// Client for the two runner endpoints of the web app.

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createApp(url, secret) {
  const base = url.trim().replace(/\/+$/, '');

  // Both calls are safe to repeat: a report is idempotent, and emails claimed by a request whose
  // answer got lost are found again by the next run.
  async function post(path, body) {
    let failure;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await fetch(base + path, {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        const data = await response.json().catch(() => ({}));
        if (response.ok) return data;
        failure = new Error(`The app answered ${response.status}: ${data.error ?? 'no details'}`);
        if (response.status < 500) break;
      } catch (error) {
        failure = new Error(`Could not reach the app at ${base}: ${error.message}`);
      }
      if (attempt < 3) await sleep(attempt * 2000);
    }
    throw failure;
  }

  return {
    claim: (sender) => post('/api/runner/claim', { sender }),
    match: (emails) => post('/api/runner/match', { emails }),
    report: (body) => post('/api/runner/report', body),
  };
}
