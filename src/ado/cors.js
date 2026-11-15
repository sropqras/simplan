'use strict';

// CORS for /ado/* only. Extension pages run in an iframe served from the
// Marketplace CDN (https://<publisher>.gallerycdn.vsassets.io), so their fetches
// to this backend are cross-origin. Auth is bearer tokens, never cookies, so
// credentials are not allowed.

const DEFAULT_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.gallerycdn\.vsassets\.io$/i,
  /^https:\/\/[a-z0-9-]+\.gallery\.vsassets\.io$/i,
];

function allowedOrigin(origin) {
  if (!origin) return false;
  const extra = (process.env.ADO_ALLOWED_ORIGINS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return extra.includes(origin) || DEFAULT_PATTERNS.some((re) => re.test(origin));
}

function adoCors(req, res, next) {
  const origin = req.get('origin');
  if (allowedOrigin(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-ADO-Token, X-ADO-Org');
    res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.set('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(allowedOrigin(origin) ? 204 : 403);
  return next();
}

module.exports = { adoCors, allowedOrigin };
