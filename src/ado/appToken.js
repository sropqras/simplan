'use strict';

// Verifies the JWT an Azure DevOps extension obtains with SDK.getAppToken().
// The token is HS256-signed with the extension's secret ("certificate" in the
// Marketplace publisher portal). The caller's ADO user id is in the `nameid` claim.
// Implemented with node:crypto so we don't need a JWT dependency.

const crypto = require('crypto');

const CLOCK_SKEW_SEC = 60;

class AppTokenError extends Error {
  constructor(message) {
    super(message);
    this.status = 401;
    this.expose = true;
  }
}

function b64urlDecode(part) {
  return Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function hmac(secret, data) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(data).digest();
}

// Returns the decoded claims, or throws AppTokenError.
function verifyAppToken(token, secret, { now = Date.now() } = {}) {
  if (!secret) throw new Error('ADO_EXTENSION_SECRET is not configured');
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    throw new AppTokenError('Malformed app token');
  }
  const [h, p, s] = token.split('.');

  let header;
  let claims;
  try {
    header = JSON.parse(b64urlDecode(h).toString('utf8'));
    claims = JSON.parse(b64urlDecode(p).toString('utf8'));
  } catch {
    throw new AppTokenError('Malformed app token');
  }
  // Pin the algorithm: never let the token choose (blocks alg=none / confusion).
  if (header.alg !== 'HS256') throw new AppTokenError('Unsupported token algorithm');

  const expected = hmac(secret, `${h}.${p}`);
  const given = b64urlDecode(s);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    throw new AppTokenError('Invalid app token signature');
  }

  const nowSec = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number') throw new AppTokenError('App token has no expiry');
  if (nowSec > claims.exp + CLOCK_SKEW_SEC) throw new AppTokenError('App token expired');
  if (typeof claims.nbf === 'number' && nowSec + CLOCK_SKEW_SEC < claims.nbf) {
    throw new AppTokenError('App token not yet valid');
  }
  if (!claims.nameid) throw new AppTokenError('App token has no user id');

  return claims;
}

// Test helper / local dev: mint a token the same shape ADO issues.
function signAppToken(claims, secret) {
  const h = b64urlEncode(JSON.stringify({ typ: 'JWT', alg: 'HS256' }));
  const p = b64urlEncode(JSON.stringify(claims));
  return `${h}.${p}.${b64urlEncode(hmac(secret, `${h}.${p}`))}`;
}

module.exports = { verifyAppToken, signAppToken, AppTokenError };
