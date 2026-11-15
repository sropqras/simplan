'use strict';

// Milestone 3 — enhanced board over real ADO work items.
//
//   GET    /projects/:projectId/board              columns (states) + items + members + pending AI proposals
//   GET    /projects/:projectId/workitems/:id      one normalized item (used after live-update pings)
//   PATCH  /projects/:projectId/workitems/:id      { state?, title?, assignedTo?, rev? }  -> broadcast
//   POST   /projects/:projectId/workitems          { title, description?, state? }      -> broadcast
//   GET    /projects/:projectId/live               service-hook live updates status
//   POST   /projects/:projectId/live               (admin) create service-hook subscriptions
//   DELETE /projects/:projectId/live               (admin) remove them
//
// ADO is the source of truth; Socket.IO events are only notifications.

const crypto = require('crypto');
const { query } = require('../config/db');
const { requireAdoProject, requireAdoProjectAdmin } = require('./auth');
const { loadEffectiveConfig } = require('./projectConfig');
const { broadcast } = require('./realtime');

const MAX_ITEMS = 500;
const FIELDS = [
  'System.Id', 'System.Rev', 'System.Title', 'System.State', 'System.WorkItemType',
  'System.AssignedTo', 'System.Tags', 'System.ChangedDate', 'System.AreaPath', 'System.TeamProject',
];
const HOOK_EVENTS = ['workitem.created', 'workitem.updated', 'workitem.deleted', 'workitem.restored'];

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400, expose: true });
}

// WIQL string literal.
function wiqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function normalizeIdentity(v) {
  if (!v) return null;
  if (typeof v === 'string') return { id: null, displayName: v, uniqueName: v, imageUrl: null };
  return {
    id: v.id || null,
    displayName: v.displayName || v.uniqueName || '',
    uniqueName: v.uniqueName || null,
    imageUrl: (v._links && v._links.avatar && v._links.avatar.href) || v.imageUrl || null,
  };
}

function normalizeItem(wi) {
  const f = wi.fields || {};
  return {
    id: wi.id,
    rev: wi.rev != null ? wi.rev : f['System.Rev'],
    title: f['System.Title'] || '',
    state: f['System.State'] || '',
    type: f['System.WorkItemType'] || '',
    assignedTo: normalizeIdentity(f['System.AssignedTo']),
    tags: f['System.Tags'] ? String(f['System.Tags']).split(';').map((t) => t.trim()).filter(Boolean) : [],
    changedDate: f['System.ChangedDate'] || null,
    areaPath: f['System.AreaPath'] || null,
  };
}

function parseWorkItemId(raw) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0 || id > 2 ** 31) throw badRequest('Invalid work item id');
  return id;
}

// Loads a work item and makes sure it belongs to the URL's project (no cross-project edits).
async function loadProjectItem(ado, id, opts) {
  const wi = await ado.client.getWorkItem(ado.project.id, id, opts);
  const proj = wi && wi.fields && wi.fields['System.TeamProject'];
  if (!wi || String(proj).toLowerCase() !== String(ado.project.name).toLowerCase()) {
    throw Object.assign(new Error('Work item not found'), { status: 404, expose: true });
  }
  return wi;
}

// Columns = configured state list (validated against the type's states) or all non-removed states.
function resolveColumns(states, configured) {
  const warnings = [];
  let columns;
  if (configured && configured.length) {
    columns = [];
    for (const name of configured) {
      const st = states.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (st) columns.push(st);
      else warnings.push(`board.columns: "${name}" is not a state of this work item type`);
    }
  } else {
    columns = states.filter((s) => s.category !== 'Removed');
  }
  return {
    columns: columns.map((s) => ({ name: s.name, color: s.color ? `#${String(s.color).replace(/^#/, '')}` : null, category: s.category || null })),
    warnings,
  };
}

function buildBoardWiql(type, stateNames, areaPath) {
  const clauses = [
    '[System.TeamProject] = @project',
    `[System.WorkItemType] = ${wiqlString(type)}`,
    `[System.State] IN (${stateNames.map(wiqlString).join(', ')})`,
  ];
  if (areaPath) clauses.push(`[System.AreaPath] UNDER ${wiqlString(areaPath)}`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;
}

// ---- service hooks ----

function hookSecret() {
  return process.env.ADO_HOOK_SECRET || process.env.ADO_EXTENSION_SECRET;
}

// Per-project basic-auth password for webhook calls; a leaked one only affects that project.
function hookPassword(org, projectId) {
  return crypto.createHmac('sha256', hookSecret()).update(`${org.toLowerCase()}|${projectId.toLowerCase()}`).digest('hex');
}

function hookUrl(org, projectId) {
  const base = (process.env.PUBLIC_URL || process.env.BASE_URL || '').replace(/\/$/, '');
  return `${base}/ado/hooks/workitems?org=${encodeURIComponent(org.toLowerCase())}&project=${encodeURIComponent(projectId)}`;
}

async function loadHookIds(org, projectId) {
  const { rows } = await query(
    'SELECT hook_subscriptions FROM ado_projects WHERE org = $1 AND project_id = $2',
    [org.toLowerCase(), projectId]
  );
  return (rows[0] && rows[0].hook_subscriptions) || [];
}

async function saveHookIds(ado, ids) {
  await query(
    `INSERT INTO ado_projects (org, project_id, project_name, hook_subscriptions, updated_by, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, now())
     ON CONFLICT (org, project_id)
       DO UPDATE SET hook_subscriptions = EXCLUDED.hook_subscriptions, updated_at = now()`,
    [ado.org.toLowerCase(), ado.project.id, ado.project.name, JSON.stringify(ids), ado.userId]
  );
}

async function pendingProposals(ado) {
  const { rows } = await query(
    `SELECT * FROM ado_proposals
      WHERE org = $1 AND project_id = $2 AND status = 'proposed'
      ORDER BY created_at ASC LIMIT 100`,
    [ado.org.toLowerCase(), ado.project.id]
  );
  // Same shape as proposals.js toClient (not imported: proposals.js depends on this module).
  return rows.map((r) => ({
    id: r.id, status: r.status, workItemId: r.work_item_id, requestedBy: r.requested_by,
    decidedBy: r.decided_by, createdAt: r.created_at, sourceMessageIds: r.source_message_ids, ...r.payload,
  }));
}

function register(router) {
  const P = '/projects/:projectId';

  router.get(`${P}/board`, requireAdoProject, async (req, res, next) => {
    try {
      const ado = req.ado;
      const conf = await loadEffectiveConfig(ado);
      const v = conf.values;
      const type = v['board.workItemType'];

      let states;
      try {
        states = await ado.client.getWorkItemTypeStates(ado.project.id, type);
      } catch (err) {
        if (err.status === 404) throw badRequest(`Work item type "${type}" does not exist in this project (board.workItemType)`);
        throw err;
      }
      const { columns, warnings } = resolveColumns(states, v['board.columns']);
      if (!columns.length) throw badRequest('The board has no columns: check board.columns');

      const ids = await ado.client.wiqlIds(ado.project.id, buildBoardWiql(type, columns.map((c) => c.name), v['board.areaPath']), MAX_ITEMS);
      const [items, members, proposals, hookIds] = await Promise.all([
        ids.length ? ado.client.getWorkItems(ado.project.id, ids, FIELDS) : [],
        ado.project.defaultTeamId
          ? ado.client.getTeamMembers(ado.project.id, ado.project.defaultTeamId).catch(() => [])
          : [],
        pendingProposals(ado),
        loadHookIds(ado.org, ado.project.id),
      ]);
      warnings.push(...conf.repoFile.errors);

      res.json({
        project: ado.project,
        workItemType: type,
        swimlanes: v['board.swimlanes'],
        columns,
        items: items.map(normalizeItem),
        truncated: ids.length >= MAX_ITEMS,
        members: members.map(normalizeIdentity).filter(Boolean)
          .sort((a, b) => a.displayName.localeCompare(b.displayName)),
        proposals,
        live: { enabled: hookIds.length > 0 },
        warnings,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get(`${P}/workitems/:id`, requireAdoProject, async (req, res, next) => {
    try {
      const wi = await loadProjectItem(req.ado, parseWorkItemId(req.params.id));
      res.json(normalizeItem(wi));
    } catch (err) {
      next(err);
    }
  });

  router.patch(`${P}/workitems/:id`, requireAdoProject, async (req, res, next) => {
    try {
      const ado = req.ado;
      const id = parseWorkItemId(req.params.id);
      const b = req.body || {};
      const ops = [];
      if (b.rev !== undefined) {
        if (!Number.isInteger(b.rev)) throw badRequest('rev must be an integer');
        ops.push({ op: 'test', path: '/rev', value: b.rev }); // optimistic concurrency
      }
      if (b.title !== undefined) {
        const t = String(b.title).trim();
        if (!t || t.length > 255) throw badRequest('title must be 1-255 characters');
        ops.push({ op: 'add', path: '/fields/System.Title', value: t });
      }
      if (b.state !== undefined) {
        if (typeof b.state !== 'string' || !b.state || b.state.length > 128) throw badRequest('invalid state');
        ops.push({ op: 'add', path: '/fields/System.State', value: b.state });
      }
      if (b.assignedTo !== undefined) {
        if (b.assignedTo !== null && (typeof b.assignedTo !== 'string' || b.assignedTo.length > 256)) {
          throw badRequest('assignedTo must be a user unique name or null');
        }
        ops.push({ op: 'add', path: '/fields/System.AssignedTo', value: b.assignedTo || '' });
      }
      if (!ops.some((o) => o.op !== 'test')) throw badRequest('Nothing to update');

      await loadProjectItem(ado, id);
      let updated;
      try {
        updated = await ado.client.updateWorkItem(ado.project.id, id, ops);
      } catch (err) {
        if (err.status === 409) err.message = 'This work item was changed by someone else. Reload and try again.';
        throw err;
      }
      const item = normalizeItem(updated);
      broadcast(ado.org, ado.project.id, 'workitem:updated', { item, by: ado.displayName });
      res.json(item);
    } catch (err) {
      next(err);
    }
  });

  router.post(`${P}/workitems`, requireAdoProject, async (req, res, next) => {
    try {
      const ado = req.ado;
      const b = req.body || {};
      const title = String(b.title || '').trim();
      if (!title || title.length > 255) throw badRequest('title must be 1-255 characters');
      const conf = await loadEffectiveConfig(ado);
      const v = conf.values;
      const ops = [{ op: 'add', path: '/fields/System.Title', value: title }];
      if (b.description) ops.push({ op: 'add', path: '/fields/System.Description', value: String(b.description).slice(0, 32000) });
      if (b.state) ops.push({ op: 'add', path: '/fields/System.State', value: String(b.state).slice(0, 128) });
      if (v['board.areaPath']) ops.push({ op: 'add', path: '/fields/System.AreaPath', value: v['board.areaPath'] });
      if (v['tickets.defaultTags'].length) ops.push({ op: 'add', path: '/fields/System.Tags', value: v['tickets.defaultTags'].join('; ') });
      const created = await ado.client.createWorkItem(ado.project.id, v['board.workItemType'], ops);
      const item = normalizeItem(created);
      broadcast(ado.org, ado.project.id, 'workitem:created', { item, by: ado.displayName });
      res.status(201).json(item);
    } catch (err) {
      next(err);
    }
  });

  // ---- live updates via service hooks ----

  router.get(`${P}/live`, requireAdoProject, async (req, res, next) => {
    try {
      const ids = await loadHookIds(req.ado.org, req.ado.project.id);
      res.json({ enabled: ids.length > 0, subscriptions: ids.length });
    } catch (err) {
      next(err);
    }
  });

  router.post(`${P}/live`, requireAdoProject, requireAdoProjectAdmin, async (req, res, next) => {
    try {
      const ado = req.ado;
      const url = hookUrl(ado.org, ado.project.id);
      if (!/^https:\/\//.test(url) && process.env.NODE_ENV === 'production') {
        throw badRequest('PUBLIC_URL/BASE_URL must be https for service hooks');
      }
      // Replace whatever we created before.
      for (const old of await loadHookIds(ado.org, ado.project.id)) {
        await ado.client.deleteSubscription(old).catch(() => {});
      }
      const created = [];
      try {
        for (const eventType of HOOK_EVENTS) {
          const sub = await ado.client.createSubscription({
            publisherId: 'tfs',
            eventType,
            resourceVersion: '1.0',
            consumerId: 'webHooks',
            consumerActionId: 'httpRequest',
            publisherInputs: { projectId: ado.project.id },
            consumerInputs: {
              url,
              basicAuthUsername: 'simplan',
              basicAuthPassword: hookPassword(ado.org, ado.project.id),
              resourceDetailsToSend: 'minimal',
              messagesToSend: 'none',
              detailedMessagesToSend: 'none',
            },
          });
          created.push(sub.id);
        }
      } catch (err) {
        for (const id of created) await ado.client.deleteSubscription(id).catch(() => {});
        throw err;
      }
      await saveHookIds(ado, created);
      res.status(201).json({ enabled: true, subscriptions: created.length });
    } catch (err) {
      next(err);
    }
  });

  router.delete(`${P}/live`, requireAdoProject, requireAdoProjectAdmin, async (req, res, next) => {
    try {
      const ado = req.ado;
      for (const id of await loadHookIds(ado.org, ado.project.id)) {
        await ado.client.deleteSubscription(id).catch(() => {});
      }
      await saveHookIds(ado, []);
      res.json({ enabled: false, subscriptions: 0 });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = {
  register, normalizeItem, normalizeIdentity, loadProjectItem, parseWorkItemId,
  buildBoardWiql, resolveColumns, wiqlString, hookPassword, FIELDS,
};
