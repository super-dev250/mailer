// Copies the browser libraries the web app uses from node_modules into app/public/vendor,
// so the app is served entirely from its own address. Runs before `dev` and `deploy`.

import { copyFile, mkdir } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const target = new URL('app/public/vendor/', root);
const files = {
  'vue/dist/vue.esm-browser.prod.js': 'vue.js',
  'jodit/es2021.en/jodit.min.js': 'jodit.js',
  'jodit/es2021.en/jodit.min.css': 'jodit.css',
  'xlsx/dist/xlsx.full.min.js': 'xlsx.js',
};

await mkdir(target, { recursive: true });
for (const [from, to] of Object.entries(files)) {
  await copyFile(new URL(`node_modules/${from}`, root), new URL(to, target));
}
console.log(`Copied ${Object.keys(files).length} browser libraries to app/public/vendor`);
