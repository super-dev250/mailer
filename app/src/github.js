// Starts the Mailer workflow right away instead of waiting for its next scheduled run.
// Optional: without DISPATCH_TOKEN the app still works, on the workflow's own schedule.

import { HttpError } from './http.js';

export const canDispatch = (env) => Boolean(env.DISPATCH_TOKEN && env.GITHUB_REPO);

export async function dispatch(env) {
  if (!canDispatch(env)) return false;
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/mailer.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.DISPATCH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'mailer',
      },
      body: JSON.stringify({ ref: env.GITHUB_BRANCH || 'main' }),
    },
  );
  if (!response.ok) {
    throw new HttpError(502, `GitHub did not start the workflow (HTTP ${response.status}). Check DISPATCH_TOKEN.`);
  }
  return true;
}
