'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdoClient, isValidOrg } = require('../src/ado/client');

function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const { status = 200, body = {} } = responder(new URL(url), init) || {};
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  fn.calls = calls;
  return fn;
}

const base = { baseUrl: 'https://ado.test', token: 'tok' };

test('org validation blocks host/path injection', () => {
  assert.equal(isValidOrg('contoso'), true);
  assert.equal(isValidOrg('my-org-1'), true);
  for (const bad of ['', '-x', 'a/b', 'evil.com', 'a?b', 'a@b', 'x'.repeat(51), null]) {
    assert.equal(isValidOrg(bad), false, String(bad));
  }
  assert.throws(() => createAdoClient({ ...base, org: 'evil.com/x' }), /Invalid organization/);
});

test('sends bearer token, api-version, and builds org-scoped URLs', async () => {
  const f = fakeFetch(() => ({ body: { value: [{ id: 'r1', name: 'repo' }] } }));
  const c = createAdoClient({ ...base, org: 'contoso', fetchImpl: f });
  const repos = await c.listRepos('11111111-1111-1111-1111-111111111111');
  assert.equal(repos[0].id, 'r1');
  const { url, init } = f.calls[0];
  assert.equal(url.origin + url.pathname,
    'https://ado.test/contoso/11111111-1111-1111-1111-111111111111/_apis/git/repositories');
  assert.equal(url.searchParams.get('api-version'), '7.1');
  assert.equal(init.headers.Authorization, 'Bearer tok');
  assert.equal(init.redirect, 'manual');
});

test('getFileText returns null on 404 and content otherwise', async () => {
  let exists = false;
  const f = fakeFetch((url) => {
    assert.equal(url.searchParams.get('path'), '/.simplan.yml');
    assert.equal(url.searchParams.get('versionDescriptor.version'), 'main');
    return exists ? { body: { content: 'a: 1' } } : { status: 404, body: { message: 'nope' } };
  });
  const c = createAdoClient({ ...base, org: 'contoso', fetchImpl: f });
  assert.equal(await c.getFileText('p', 'r', '/.simplan.yml', 'main'), null);
  exists = true;
  assert.equal(await c.getFileText('p', 'r', '/.simplan.yml', 'main'), 'a: 1');
});

test('maps ADO errors: 403 passes through, 500 becomes 502, redirect becomes 401', async () => {
  let status = 403;
  const f = fakeFetch(() => ({ status, body: { message: 'TF401027: You need Git permission' } }));
  const c = createAdoClient({ ...base, org: 'contoso', fetchImpl: f });
  await assert.rejects(c.listRepos('p'), (e) => e.status === 403 && /TF401027/.test(e.message));
  status = 500;
  await assert.rejects(c.listRepos('p'), (e) => e.status === 502);
  status = 302;
  await assert.rejects(c.listRepos('p'), (e) => e.status === 401);
});

test('getProject rejects non-GUID ids before calling ADO', async () => {
  const f = fakeFetch(() => ({}));
  const c = createAdoClient({ ...base, org: 'contoso', fetchImpl: f });
  await assert.rejects(c.getProject('../_apis/x'), /Invalid projectId/);
  assert.equal(f.calls.length, 0);
});

test('pushFile creates a new branch off the base commit', async () => {
  const f = fakeFetch(() => ({ status: 201, body: { pushId: 1 } }));
  const c = createAdoClient({ ...base, org: 'contoso', fetchImpl: f });
  await c.pushFile('p', 'r', {
    newBranch: 'simplan/config-1', baseObjectId: 'abc', path: '/.simplan.yml',
    content: 'x: 1', exists: true, comment: 'msg',
  });
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.refUpdates[0].name, 'refs/heads/simplan/config-1');
  assert.match(body.refUpdates[0].oldObjectId, /^0{40}$/);
  assert.deepEqual(body.commits[0].parents, ['abc']);
  assert.equal(body.commits[0].changes[0].changeType, 'edit');
});

test('hasPermission reads the first boolean', async () => {
  const f = fakeFetch((url) => {
    assert.match(url.pathname, /\/_apis\/permissions\/ns\/2$/);
    assert.equal(url.searchParams.get('tokens'), '$PROJECT:x');
    return { body: { value: [true] } };
  });
  const c = createAdoClient({ ...base, org: 'contoso', fetchImpl: f });
  assert.equal(await c.hasPermission('ns', 2, '$PROJECT:x'), true);
});
