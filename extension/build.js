'use strict';

// Bundles each extension page (src/<page>/index.js + <page>.html) into dist/<page>/.
//
//   SIMPLAN_API_URL=https://simplan-xyz.azurewebsites.net npm run build
//
// SIMPLAN_API_URL is the backend origin baked into the bundle. Leave it empty when
// the extension is served by the backend itself (overrides.dev.json baseUri mode):
// the pages then call /ado/api on their own origin.

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const PAGES = ['board', 'chat', 'workitem', 'action', 'settings'];
const SRC = path.join(__dirname, 'src');
const DIST = path.join(__dirname, 'dist');

const apiUrl = (process.env.SIMPLAN_API_URL || '').replace(/\/$/, '');
if (apiUrl && !/^https:\/\//.test(apiUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(apiUrl)) {
  console.error('SIMPLAN_API_URL must be https:// (or http://localhost for local testing)');
  process.exit(1);
}

fs.rmSync(DIST, { recursive: true, force: true });

esbuild.buildSync({
  entryPoints: Object.fromEntries(PAGES.map((p) => [`${p}/index`, path.join(SRC, p, 'index.js')])),
  outdir: DIST,
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: process.env.NODE_ENV === 'production',
  sourcemap: process.env.NODE_ENV !== 'production', // keep the .vsix small
  define: { __SIMPLAN_API__: JSON.stringify(apiUrl) },
  logLevel: 'warning',
});

for (const p of PAGES) {
  fs.copyFileSync(path.join(SRC, p, `${p}.html`), path.join(DIST, p, `${p}.html`));
}
fs.copyFileSync(path.join(SRC, 'common', 'styles.css'), path.join(DIST, 'styles.css'));

console.log(`Built ${PAGES.join(', ')} -> dist/ (API: ${apiUrl || 'same origin'})`);
