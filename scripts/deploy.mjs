// Deploys the web app to Cloudflare. Run by the "Test and deploy" workflow; it also works
// from a terminal when the same environment variables are set.
//
// The database is created by Wrangler on the first deploy and found again by its name
// ("mailer", in app/wrangler.json) on every later one, so there is no ID to copy around.

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const root = fileURLToPath(new URL('..', import.meta.url));

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const missing = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'APP_SECRET'].filter((name) => !env[name]?.trim());
if (missing.length) {
  fail(`Missing: ${missing.join(', ')}. Add them as repository secrets (Settings > Secrets and variables > Actions). See the README.`);
}
if (env.APP_SECRET.trim().length < 16) fail('APP_SECRET must be at least 16 characters long.');

const node = (script, args, options) => spawnSync(process.execPath, [join(root, script), ...args], { cwd: root, ...options });

if (node('scripts/vendor.mjs', [], { stdio: 'inherit' }).status !== 0) fail('Could not copy the browser libraries.');

// The Worker's secrets are uploaded together with the code, from a file that exists only for the deploy.
const secrets = {
  APP_SECRET: env.APP_SECRET.trim(),
  // Lets the app start the Mailer workflow. Both are empty outside GitHub Actions.
  GITHUB_REPO: env.GITHUB_REPOSITORY,
  GITHUB_BRANCH: env.GITHUB_BRANCH,
  DISPATCH_TOKEN: env.DISPATCH_TOKEN?.trim(),
  // Lets the GitHub contacts page search commits.
  GH_API_TOKEN: env.GH_API_TOKEN?.trim(),
};
const folder = mkdtempSync(join(tmpdir(), 'mailer-'));
const secretsFile = join(folder, 'secrets.json');
let deploy;
try {
  writeFileSync(secretsFile, JSON.stringify(Object.fromEntries(Object.entries(secrets).filter(([, value]) => value))));
  deploy = node('node_modules/wrangler/bin/wrangler.js', ['deploy', '--config', 'app/wrangler.json', '--secrets-file', secretsFile], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
} finally {
  rmSync(folder, { recursive: true, force: true });
}
process.stdout.write(deploy.stdout ?? '');
if (deploy.status !== 0) fail('The deploy did not succeed. The output above says why.');

const url = deploy.stdout.match(/https:\/\/\S+\.workers\.dev/)?.[0];
const summary = url
  ? `### Deployed\n\nYour app: ${url}\n\nFirst deploy? Save that address as the \`APP_URL\` repository secret, then open it and sign in with your \`APP_SECRET\`.\n`
  : '### Deployed\n\nThe address of the app is shown in the Cloudflare dashboard under Workers & Pages > mailer.\n';
console.log(`\n${summary}`);
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
