'use strict';

// Starts the real server against Postgres + fake ADO + fake Foundry for integration tests.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Pool } = require('pg');
const { startFakeAdo, ORG, USERS } = require('./fakeAdo');
const { startFakeFoundry } = require('./fakeFoundry');
const { signAppToken } = require('../../src/ado/appToken');

const SECRET = 'integration-secret';
const REPO_ROOT = path.join(__dirname, '..', '..');

function assertTestDb(db) {
  if (!/test/i.test(new URL(db).pathname)) {
    throw new Error('TEST_DATABASE_URL must name a database containing "test" (tests drop tables)');
  }
}

function appTokenFor(tok, { secret = SECRET } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signAppToken({ nameid: USERS[tok].id, exp: now + 300, nbf: now - 5 }, secret);
}

async function startStack(db, { env = {} } = {}) {
  assertTestDb(db);
  const ado = await startFakeAdo();
  const ai = await startFakeFoundry();
  const pool = new Pool({ connectionString: db });
  await pool.query('DROP TABLE IF EXISTS ado_projects, ado_messages, ado_proposals');
  await pool.query(fs.readFileSync(path.join(REPO_ROOT, 'db', 'schema.sql'), 'utf8'));

  const port = 3200 + Math.floor(Math.random() * 700);
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(REPO_ROOT, 'src', 'server.js')], {
    env: {
      ...process.env,
      DATABASE_URL: db, DATABASE_SSL: 'false', SESSION_SECRET: 's'.repeat(32),
      BASE_URL: base, PORT: String(port), NODE_ENV: 'test',
      GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '',
      ADO_EXTENSION_SECRET: SECRET, ADO_BASE_URL: ado.url,
      FOUNDRY_ENDPOINT: ai.url, FOUNDRY_API_KEY: ai.apiKey, FOUNDRY_DEPLOYMENT: 'fake-gpt',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${log}`)), 15000);
    server.stdout.on('data', () => { if (/running on/.test(log)) { clearTimeout(timer); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited ${code}:\n${log}`)));
  });

  async function call(method, url, { as, body, headers = {}, appToken } = {}) {
    const h = {};
    if (as) {
      h.authorization = `Bearer ${appToken || appTokenFor(as)}`;
      h['x-ado-token'] = as;
      h['x-ado-org'] = ORG;
    }
    Object.assign(h, headers);
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  async function stop() {
    server.kill();
    ado.close();
    ai.close();
    await pool.end();
  }

  return { ado, ai, pool, base, call, stop, log: () => log };
}

module.exports = { startStack, appTokenFor, assertTestDb, SECRET };
