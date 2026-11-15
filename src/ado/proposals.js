'use strict';

// Milestone 5 — AI tickets: chat messages (+ repo context) -> proposed work items -> approval.
//
//   POST /projects/:projectId/proposals                { messageIds?: uuid[], last?: n }
//   GET  /projects/:projectId/proposals?status=proposed|approved|rejected|all
//   POST /projects/:projectId/proposals/:proposalId/approve   { edits?: {title, description, type}, createBranch? }
//   POST /projects/:projectId/proposals/:proposalId/reject
//
// Approval (who: config ai.approvers) creates the ADO work item inside a DB transaction
// that locks the proposal row, so a proposal can only ever become one work item.

const { query, pool } = require('../config/db');
const { requireAdoProject, isProjectAdmin } = require('./auth');
const { isUuid } = require('../middleware/validate');
const { loadEffectiveConfig } = require('./projectConfig');
const { broadcast } = require('./realtime');
const { normalizeItem } = require('./board');
const { createBranchForItem } = require('./code');
const { postAndBroadcast } = require('./chat');
const { createRepoContext } = require('./repoContext');
const foundry = require('./foundry');

const MAX_MESSAGES = 50;
const MAX_PROPOSALS = 10;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['proposals'],
  properties: {
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'description', 'type', 'acceptanceCriteria', 'suggestedFiles', 'tags'],
        properties: {
          title: { type: 'string', description: 'Short imperative title, max 120 characters' },
          description: { type: 'string', description: 'What and why, plain text, a few sentences' },
          type: { type: 'string', description: 'Work item type, one of the allowed types' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          suggestedFiles: { type: 'array', items: { type: 'string' }, description: 'Repo paths likely affected (from the list only)' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Cleans the model output: types restricted to the project's types, files to known repo paths.
function sanitizeProposals(raw, { types, defaultType, repoPaths }) {
  const list = Array.isArray(raw && raw.proposals) ? raw.proposals : [];
  const typeByLower = new Map(types.map((t) => [t.toLowerCase(), t]));
  const known = new Set(repoPaths);
  const strList = (a, maxItems, maxLen) => (Array.isArray(a) ? a : [])
    .filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().slice(0, maxLen)).slice(0, maxItems);
  return list.slice(0, MAX_PROPOSALS).map((p) => ({
    title: String((p && p.title) || '').trim().slice(0, 255),
    description: String((p && p.description) || '').trim().slice(0, 8000),
    type: typeByLower.get(String((p && p.type) || '').toLowerCase()) || defaultType,
    acceptanceCriteria: strList(p && p.acceptanceCriteria, 20, 500),
    suggestedFiles: strList(p && p.suggestedFiles, 15, 300).map((f) => f.replace(/^\/+/, '')).filter((f) => known.has(f)),
    tags: strList(p && p.tags, 10, 40).map((t) => t.replace(/;/g, '')),
  })).filter((p) => p.title);
}

function descriptionHtml(p, repo, messageCount) {
  const parts = [];
  for (const para of p.description.split(/\n{2,}/)) parts.push(`<p>${esc(para).replace(/\n/g, '<br>')}</p>`);
  if (p.acceptanceCriteria.length) {
    parts.push('<p><b>Acceptance criteria</b></p>', `<ul>${p.acceptanceCriteria.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>`);
  }
  if (p.suggestedFiles.length) {
    const link = (f) => (repo && repo.webUrl
      ? `<a href="${esc(`${repo.webUrl}?path=/${encodeURI(f)}`)}">${esc(f)}</a>`
      : esc(f));
    parts.push('<p><b>Likely affected files</b></p>', `<ul>${p.suggestedFiles.map((f) => `<li>${link(f)}</li>`).join('')}</ul>`);
  }
  parts.push(`<p><i>Created by simplan from project chat (${messageCount} message${messageCount === 1 ? '' : 's'}).</i></p>`);
  return parts.join('');
}

function toClient(row) {
  return {
    id: row.id,
    status: row.status,
    workItemId: row.work_item_id,
    requestedBy: row.requested_by,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    sourceMessageIds: row.source_message_ids,
    ...row.payload,
  };
}

async function canApprove(ado, conf) {
  if (conf.values['ai.approvers'] === 'members') return true; // membership already checked by requireAdoProject
  return isProjectAdmin(ado).catch(() => false);
}

// Creates the work item and marks the proposal approved, atomically from simplan's side.
async function approveProposal(ado, conf, proposalId, { edits = {}, createBranch = false } = {}) {
  const client = await pool.connect();
  let row;
  let created;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM ado_proposals WHERE id = $1 AND org = $2 AND project_id = $3 FOR UPDATE`,
      [proposalId, ado.org.toLowerCase(), ado.project.id]
    );
    if (!rows.length) throw httpError(404, 'Proposal not found');
    if (rows[0].status !== 'proposed') throw httpError(409, `Proposal is already ${rows[0].status}`);
    const p = { ...rows[0].payload };
    if (edits.title !== undefined) p.title = String(edits.title).trim().slice(0, 255);
    if (edits.description !== undefined) p.description = String(edits.description).trim().slice(0, 8000);
    if (edits.type !== undefined) p.type = String(edits.type).trim().slice(0, 128);
    if (!p.title) throw httpError(400, 'title is required');

    const v = conf.values;
    const tags = [...new Set([...v['tickets.defaultTags'], ...(p.tags || [])])];
    const ops = [
      { op: 'add', path: '/fields/System.Title', value: p.title },
      { op: 'add', path: '/fields/System.Description', value: descriptionHtml(p, conf.repo, rows[0].source_message_ids.length) },
      { op: 'add', path: '/fields/System.History', value: 'Created from an AI proposal in simplan chat.' },
    ];
    if (tags.length) ops.push({ op: 'add', path: '/fields/System.Tags', value: tags.join('; ') });
    if (v['board.areaPath']) ops.push({ op: 'add', path: '/fields/System.AreaPath', value: v['board.areaPath'] });

    created = await ado.client.createWorkItem(ado.project.id, p.type || v['ai.defaultType'], ops);
    const upd = await client.query(
      `UPDATE ado_proposals SET status = 'approved', payload = $2, work_item_id = $3, decided_by = $4, decided_at = now()
        WHERE id = $1 RETURNING *`,
      [proposalId, p, created.id, ado.userId]
    );
    row = upd.rows[0];
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const item = normalizeItem(created);
  broadcast(ado.org, ado.project.id, 'proposal:updated', toClient(row));
  broadcast(ado.org, ado.project.id, 'workitem:created', { item, by: ado.displayName });

  let branch = null;
  let branchError = null;
  if (createBranch) {
    try {
      branch = await createBranchForItem(ado, conf, created, null);
    } catch (err) {
      branchError = err.expose ? err.message : 'Branch creation failed';
    }
  }
  return { proposal: toClient(row), item, branch, branchError };
}

function register(router) {
  const P = '/projects/:projectId/proposals';

  router.post(P, requireAdoProject, async (req, res, next) => {
    try {
      const ado = req.ado;
      const b = req.body || {};
      const org = ado.org.toLowerCase();
      let rows;
      if (Array.isArray(b.messageIds) && b.messageIds.length) {
        const ids = b.messageIds.slice(0, MAX_MESSAGES);
        if (!ids.every(isUuid)) throw httpError(400, 'messageIds must be UUIDs');
        ({ rows } = await query(
          `SELECT * FROM ado_messages WHERE org = $1 AND project_id = $2 AND id = ANY($3::uuid[]) ORDER BY created_at ASC`,
          [org, ado.project.id, ids]
        ));
      } else {
        const last = Math.min(Math.max(parseInt(b.last, 10) || 20, 1), MAX_MESSAGES);
        ({ rows } = await query(
          `SELECT * FROM (SELECT * FROM ado_messages WHERE org = $1 AND project_id = $2 AND kind <> 'system'
             ORDER BY created_at DESC LIMIT $3) t ORDER BY created_at ASC`,
          [org, ado.project.id, last]
        ));
      }
      if (!rows.length) throw httpError(400, 'No chat messages selected');

      const conf = await loadEffectiveConfig(ado);
      const v = conf.values;
      const [types, repoCtx] = await Promise.all([
        ado.client.listWorkItemTypes(ado.project.id).catch(() => [v['ai.defaultType']]),
        createRepoContext(ado, conf.repo, v['ai.contextPaths']).catch(() => null),
      ]);

      const system = [
        `You turn a team chat from the Azure DevOps project "${ado.project.name}" into well-formed work items.`,
        'Only create items for concrete work that was actually discussed; merge duplicates; return an empty list if there is none.',
        `Allowed work item types: ${types.join(', ')}. Default: ${v['ai.defaultType']}.`,
        repoCtx && repoCtx.listing.length
          ? `Repository files you may read with read_file (only these):\n${repoCtx.listing.join('\n')}${repoCtx.listingTruncated ? '\n…' : ''}\nUse them to name likely affected files.`
          : 'No repository files are available.',
        v['ai.systemPrompt'] ? `Project instructions: ${v['ai.systemPrompt']}` : '',
      ].filter(Boolean).join('\n\n');
      const user = rows.map((m) => `[${m.kind === 'ai' ? 'AI' : m.author_name}] ${m.body}`).join('\n');

      const raw = await foundry.structured({
        deployment: v['ai.deployment'],
        system,
        user: `Chat:\n${user}`,
        schemaName: 'ticket_proposals',
        schema: SCHEMA,
        tools: repoCtx && repoCtx.listing.length ? [repoCtx.tool] : [],
      });
      const proposals = sanitizeProposals(raw, {
        types, defaultType: v['ai.defaultType'], repoPaths: repoCtx ? repoCtx.paths : [],
      });

      const sourceIds = rows.map((m) => m.id);
      const saved = [];
      for (const p of proposals) {
        const { rows: ins } = await query(
          `INSERT INTO ado_proposals (org, project_id, payload, source_message_ids, requested_by)
           VALUES ($1, $2, $3, $4::uuid[], $5) RETURNING *`,
          [org, ado.project.id, p, sourceIds, ado.userId]
        );
        saved.push(toClient(ins[0]));
      }
      for (const p of saved) broadcast(ado.org, ado.project.id, 'proposal:created', p);

      const note = saved.length
        ? `${ado.displayName} turned ${rows.length} message(s) into ${saved.length} proposed ticket(s).`
        : `${ado.displayName} asked for tickets, but the AI found no concrete work in the selected messages.`;
      await postAndBroadcast(ado, { authorName: 'simplan', kind: 'system', body: note }).catch(() => {});

      // Auto-approve when the project doesn't require approval.
      const results = [];
      if (!v['ai.requireApproval']) {
        for (const p of saved) {
          try {
            results.push(await approveProposal(ado, conf, p.id));
          } catch (err) {
            results.push({ proposal: p, error: err.expose ? err.message : 'approval failed' });
          }
        }
      }
      res.status(201).json({
        proposals: results.length ? results.map((r) => r.proposal) : saved,
        autoApproved: !v['ai.requireApproval'],
        errors: results.filter((r) => r.error).map((r) => r.error),
        filesRead: repoCtx ? repoCtx.stats.filesRead : [],
      });
    } catch (err) {
      next(err);
    }
  });

  router.get(P, requireAdoProject, async (req, res, next) => {
    try {
      const status = String(req.query.status || 'proposed');
      if (!['proposed', 'approved', 'rejected', 'all'].includes(status)) throw httpError(400, 'Invalid status');
      const params = [req.ado.org.toLowerCase(), req.ado.project.id];
      const where = status === 'all' ? '' : 'AND status = $3';
      if (status !== 'all') params.push(status);
      const { rows } = await query(
        `SELECT * FROM ado_proposals WHERE org = $1 AND project_id = $2 ${where} ORDER BY created_at DESC LIMIT 200`,
        params
      );
      res.json(rows.map(toClient));
    } catch (err) {
      next(err);
    }
  });

  router.post(`${P}/:proposalId/approve`, requireAdoProject, async (req, res, next) => {
    try {
      if (!isUuid(req.params.proposalId)) throw httpError(400, 'Invalid proposalId');
      const ado = req.ado;
      const conf = await loadEffectiveConfig(ado);
      if (!(await canApprove(ado, conf))) throw httpError(403, 'Only project administrators can approve AI tickets here (ai.approvers)');
      const b = req.body || {};
      const result = await approveProposal(ado, conf, req.params.proposalId, {
        edits: (b.edits && typeof b.edits === 'object') ? b.edits : {},
        createBranch: Boolean(b.createBranch),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post(`${P}/:proposalId/reject`, requireAdoProject, async (req, res, next) => {
    try {
      if (!isUuid(req.params.proposalId)) throw httpError(400, 'Invalid proposalId');
      const ado = req.ado;
      const conf = await loadEffectiveConfig(ado);
      if (!(await canApprove(ado, conf))) throw httpError(403, 'Only project administrators can reject AI tickets here (ai.approvers)');
      const { rows } = await query(
        `UPDATE ado_proposals SET status = 'rejected', decided_by = $4, decided_at = now()
          WHERE id = $1 AND org = $2 AND project_id = $3 AND status = 'proposed' RETURNING *`,
        [req.params.proposalId, ado.org.toLowerCase(), ado.project.id, ado.userId]
      );
      if (!rows.length) {
        const { rows: exists } = await query(
          'SELECT status FROM ado_proposals WHERE id = $1 AND org = $2 AND project_id = $3',
          [req.params.proposalId, ado.org.toLowerCase(), ado.project.id]
        );
        throw exists.length ? httpError(409, `Proposal is already ${exists[0].status}`) : httpError(404, 'Proposal not found');
      }
      const p = toClient(rows[0]);
      broadcast(ado.org, ado.project.id, 'proposal:updated', p);
      res.json(p);
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { register, sanitizeProposals, descriptionHtml, approveProposal, SCHEMA };
