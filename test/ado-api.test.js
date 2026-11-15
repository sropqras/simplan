'use strict';

// Integration test: real server process + real Postgres + fake Azure DevOps.
// Runs only when TEST_DATABASE_URL points at a disposable database, e.g.
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/simplan_test npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { startFakeAdo, ORG, PROJECT_ID, USERS } = require('./helpers/fakeAdo');
const { signAppToken } = require('../src/ado/appToken');

const DB = process.env.TEST_DATABASE_URL;
// This test drops ado_projects: refuse anything that isn't obviously a throwaway database.
if (DB && !/test/i.test(new URL(DB).pathname)) {
  throw new Error('TEST_DATABASE_URL must name a database containing "test" (this test drops tables)');
}
const SECRET = 'integration-secret';
const PORT = 3200 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;

function appTokenFor(tok, { secret = SECRET } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signAppToken({ nameid: USERS[tok].id, exp: now + 300, nbf: now - 5 }, secret);
}

async function call(method, url, { as, body, headers = {}, appToken } = {}) {
  const h = {};
  if (as) {
    h.authorization = `Bearer ${appToken || appTokenFor(as)}`;
    h['x-ado-token'] = as;
    h['x-ado-org'] = ORG;
  }
  Object.assign(h, headers); // explicit headers win over the defaults above
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}

test('Azure DevOps API (integration)', { skip: !DB && 'set TEST_DATABASE_URL to run' }, async (t) => {
  const ado = await startFakeAdo();
  const repoRoot = path.join(__dirname, '..');

  // Fresh schema.
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DB });
  await pool.query('DROP TABLE IF EXISTS ado_projects');
  await pool.query(require('fs').readFileSync(path.join(repoRoot, 'db', 'schema.sql'), 'utf8'));

  const server = spawn(process.execPath, [path.join(repoRoot, 'src', 'server.js')], {
    env: {
      ...process.env,
      DATABASE_URL: DB, DATABASE_SSL: 'false', SESSION_SECRET: 's'.repeat(32),
      BASE_URL: BASE, PORT: String(PORT), NODE_ENV: 'test',
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
      ADO_EXTENSION_SECRET: SECRET, ADO_BASE_URL: ado.url,
      ADO_ALLOWED_ORIGINS: 'https://allowed.example',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start:\n' + log)), 10000);
    server.stdout.on('data', () => { if (/running on/.test(log)) { clearTimeout(timer); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited ${code}:\n${log}`)));
  });

  t.after(async () => {
    server.kill();
    ado.close();
    await pool.end();
  });

  const cfgUrl = `/ado/api/projects/${PROJECT_ID}/config`;

  await t.test('boots in azure-devops-only mode; Google routes disabled', async () => {
    assert.match(log, /\[azure-devops\]/);
    const r = await call('GET', '/auth/google');
    assert.equal(r.status, 503);
  });

  await t.test('auth: missing/invalid/mismatched tokens are rejected', async () => {
    assert.equal((await call('GET', '/ado/api/whoami')).status, 401);
    assert.equal((await call('GET', '/ado/api/whoami', { as: 'tok-alice', appToken: appTokenFor('tok-alice', { secret: 'wrong' }) })).status, 401);
    // Alice's app token with Bob's access token -> different users.
    const r = await call('GET', '/ado/api/whoami', { as: 'tok-bob', appToken: appTokenFor('tok-alice') });
    assert.equal(r.status, 401);
    assert.match(r.json.error, /different users/);
    // Bad org header.
    const bad = await call('GET', '/ado/api/whoami', { as: 'tok-alice', headers: { 'x-ado-org': 'evil.com/x' } });
    assert.equal(bad.status, 400);
    // Unknown access token -> fake ADO redirects to sign-in -> 401.
    const h = { authorization: `Bearer ${appTokenFor('tok-alice')}`, 'x-ado-token': 'garbage', 'x-ado-org': ORG };
    assert.equal((await call('GET', '/ado/api/whoami', { headers: h })).status, 401);
  });

  await t.test('whoami returns the ADO identity', async () => {
    const r = await call('GET', '/ado/api/whoami', { as: 'tok-alice' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { userId: USERS['tok-alice'].id, displayName: 'Alice Admin', org: ORG });
  });

  await t.test('config: defaults, repo picked by project name, no repo file yet', async () => {
    const r = await call('GET', cfgUrl, { as: 'tok-bob' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.repo.name, 'Shop');
    assert.equal(r.json.repoFile.exists, false);
    assert.equal(r.json.values['board.workItemType'], 'Task');
    assert.equal(r.json.sources['board.workItemType'], 'default');
    assert.equal(r.json.canEdit, false);
    assert.ok(r.json.schema['board.swimlanes'].values.includes('assignee'));
  });

  await t.test('config: repo .simplan.yml is read and errors are reported', async () => {
    ado.state.file = 'board:\n  workItemType: Bug\n  swimlanes: sideways\n';
    const r = await call('GET', cfgUrl, { as: 'tok-alice' });
    assert.equal(r.json.repoFile.exists, true);
    assert.equal(r.json.values['board.workItemType'], 'Bug');
    assert.equal(r.json.sources['board.workItemType'], 'repo');
    assert.equal(r.json.sources['board.swimlanes'], 'default');
    assert.ok(r.json.repoFile.errors.some((e) => /swimlanes/.test(e)));
    assert.equal(r.json.canEdit, true);
  });

  await t.test('config: non-admin cannot save; non-member cannot read', async () => {
    const put = await call('PUT', cfgUrl, { as: 'tok-bob', body: { overrides: { 'board.swimlanes': 'assignee' } } });
    assert.equal(put.status, 403);
    const get = await call('GET', cfgUrl, { as: 'tok-eve' });
    assert.equal(get.status, 404);
    const bad = await call('GET', '/ado/api/projects/not-a-guid/config', { as: 'tok-alice' });
    assert.equal(bad.status, 400);
  });

  await t.test('config: admin saves tool overrides; they beat the repo file', async () => {
    const put = await call('PUT', cfgUrl, { as: 'tok-alice', body: { overrides: {
      'board.workItemType': 'User Story', 'board.swimlanes': 'assignee', 'ai.contextPaths': ['src/**'],
    } } });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.values['board.workItemType'], 'User Story');
    assert.equal(put.json.sources['board.workItemType'], 'tool');
    const { rows } = await pool.query('SELECT settings, updated_by FROM ado_projects WHERE org=$1 AND project_id=$2', [ORG, PROJECT_ID]);
    assert.equal(rows[0].settings['board.swimlanes'], 'assignee');
    assert.equal(rows[0].updated_by, USERS['tok-alice'].id);
  });

  await t.test('config: null removes an override (falls back to repo); bad values are 400 with details', async () => {
    const put = await call('PUT', cfgUrl, { as: 'tok-alice', body: { overrides: { 'board.workItemType': null } } });
    assert.equal(put.json.values['board.workItemType'], 'Bug');
    assert.equal(put.json.sources['board.workItemType'], 'repo');
    assert.equal(put.json.values['board.swimlanes'], 'assignee'); // untouched key kept
    const bad = await call('PUT', cfgUrl, { as: 'tok-alice', body: { overrides: { 'ai.requireApproval': 'maybe', zzz: 1 } } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.details.length, 2);
  });

  await t.test('config: commit to repo pushes a branch and opens a PR', async () => {
    const r = await call('POST', `${cfgUrl}/commit`, { as: 'tok-alice' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.pullRequestId, 100);
    assert.match(r.json.url, /\/pullrequest\/100$/);
    const push = ado.state.pushes[0];
    assert.match(push.refUpdates[0].name, /^refs\/heads\/simplan\/config-\d{14}$/);
    assert.equal(push.commits[0].changes[0].changeType, 'edit');
    const content = push.commits[0].changes[0].newContent.content;
    assert.match(content, /swimlanes: assignee/);
    assert.match(content, /workItemType: Bug/);
    assert.equal(ado.state.prs[0].targetRefName, 'refs/heads/main');
  });

  await t.test('config: non-admin commit is 403 before touching the repo', async () => {
    const before = ado.state.pushes.length;
    const r = await call('POST', `${cfgUrl}/commit`, { as: 'tok-bob' });
    assert.equal(r.status, 403);
    assert.equal(ado.state.pushes.length, before);
  });

  await t.test('CORS: allowed origin gets headers, others do not', async () => {
    const ok = await call('OPTIONS', '/ado/api/whoami', { headers: { origin: 'https://allowed.example' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://allowed.example');
    assert.match(ok.headers.get('access-control-allow-headers'), /X-ADO-Token/);
    const cdn = await call('OPTIONS', '/ado/api/whoami', { headers: { origin: 'https://sropqras.gallerycdn.vsassets.io' } });
    assert.equal(cdn.status, 204);
    const bad = await call('OPTIONS', '/ado/api/whoami', { headers: { origin: 'https://evil.example' } });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });

  await t.test('unknown /ado route is JSON 404', async () => {
    const r = await call('GET', '/ado/nope');
    assert.equal(r.status, 404);
    assert.equal(r.json.error, 'Not found');
  });

  await t.test('identity is cached (no connectionData call per request)', async () => {
    const before = ado.state.calls;
    await call('GET', '/ado/api/whoami', { as: 'tok-alice' });
    await call('GET', '/ado/api/whoami', { as: 'tok-alice' });
    assert.equal(ado.state.calls, before);
  });
});
