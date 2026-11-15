'use strict';

// Receives Azure DevOps service-hook calls (work item created/updated/deleted/restored)
// and pings the project's Socket.IO room. The payload is NOT trusted for content:
// clients re-fetch the item with their own token, so ADO permissions still apply.
//
//   POST /ado/hooks/workitems?org=<org>&project=<projectId>
//   Authorization: Basic simplan:<hookPassword(org, project)>

const crypto = require('crypto');
const express = require('express');
const { isValidOrg, GUID_RE } = require('./client');
const { hookPassword } = require('./board');
const { broadcast } = require('./realtime');

const router = express.Router();

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

router.post('/workitems', (req, res) => {
  const org = String(req.query.org || '');
  const projectId = String(req.query.project || '');
  if (!isValidOrg(org) || !GUID_RE.test(projectId)) return res.status(400).json({ error: 'Invalid org/project' });

  const m = /^Basic\s+(.+)$/i.exec(req.get('authorization') || '');
  const creds = m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
  const sep = creds.indexOf(':');
  const user = sep >= 0 ? creds.slice(0, sep) : '';
  const pass = sep >= 0 ? creds.slice(sep + 1) : '';
  if (user !== 'simplan' || !safeEqual(pass, hookPassword(org, projectId))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};
  const eventType = String(body.eventType || '');
  const r = body.resource || {};
  // workitem.updated: resource.workItemId; created/deleted/restored: resource.id
  const id = Number(eventType === 'workitem.updated' ? r.workItemId || (r.revision && r.revision.id) : r.id);
  if (!/^workitem\.(created|updated|deleted|restored)$/.test(eventType) || !Number.isInteger(id) || id <= 0) {
    return res.status(202).json({ ignored: true });
  }
  broadcast(org, projectId, 'workitem:changed', { id, eventType });
  return res.json({ ok: true });
});

module.exports = router;
