'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

// For router.param(): reject malformed ids with 400 before they reach Postgres
// (which would otherwise throw 22P02 and surface as a 500).
function uuidParam(req, res, next, value, name) {
  if (!isUuid(value)) return res.status(400).json({ error: `Invalid ${name}` });
  return next();
}

module.exports = { isUuid, uuidParam };
