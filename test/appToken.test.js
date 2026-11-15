'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyAppToken, signAppToken } = require('../src/ado/appToken');

const SECRET = 'test-extension-secret';
const now = Date.now();
const nowSec = Math.floor(now / 1000);
const good = { nameid: 'user-1', exp: nowSec + 300, nbf: nowSec - 10 };

test('accepts a valid token and returns claims', () => {
  const claims = verifyAppToken(signAppToken(good, SECRET), SECRET, { now });
  assert.equal(claims.nameid, 'user-1');
});

test('rejects wrong secret', () => {
  assert.throws(() => verifyAppToken(signAppToken(good, 'other'), SECRET, { now }), /signature/);
});

test('rejects tampered payload', () => {
  const [h, , s] = signAppToken(good, SECRET).split('.');
  const p = Buffer.from(JSON.stringify({ ...good, nameid: 'admin' })).toString('base64url');
  assert.throws(() => verifyAppToken(`${h}.${p}.${s}`, SECRET, { now }), /signature/);
});

test('rejects expired token (beyond 60s skew)', () => {
  const t = signAppToken({ ...good, exp: nowSec - 120 }, SECRET);
  assert.throws(() => verifyAppToken(t, SECRET, { now }), /expired/);
});

test('allows small clock skew on expiry', () => {
  const t = signAppToken({ ...good, exp: nowSec - 30 }, SECRET);
  assert.equal(verifyAppToken(t, SECRET, { now }).nameid, 'user-1');
});

test('rejects not-yet-valid token', () => {
  const t = signAppToken({ ...good, nbf: nowSec + 600 }, SECRET);
  assert.throws(() => verifyAppToken(t, SECRET, { now }), /not yet valid/);
});

test('rejects token without exp or nameid', () => {
  assert.throws(() => verifyAppToken(signAppToken({ nameid: 'x' }, SECRET), SECRET, { now }), /expiry/);
  assert.throws(() => verifyAppToken(signAppToken({ exp: nowSec + 60 }, SECRET), SECRET, { now }), /user id/);
});

test('rejects alg=none and malformed tokens', () => {
  const h = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const p = Buffer.from(JSON.stringify(good)).toString('base64url');
  assert.throws(() => verifyAppToken(`${h}.${p}.`, SECRET, { now }), /algorithm/);
  assert.throws(() => verifyAppToken('abc', SECRET, { now }), /Malformed/);
  assert.throws(() => verifyAppToken(undefined, SECRET, { now }), /Malformed/);
});

test('errors are 401 and exposable', () => {
  try {
    verifyAppToken('a.b.c', SECRET, { now });
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.status, 401);
    assert.equal(err.expose, true);
  }
});

test('throws a server error when the secret is not configured', () => {
  assert.throws(() => verifyAppToken(signAppToken(good, SECRET), undefined), /ADO_EXTENSION_SECRET/);
});
