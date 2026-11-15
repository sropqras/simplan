'use strict';

// Milestone 4 — project chat inside Azure DevOps.
//
//   GET  /projects/:projectId/messages?before=<iso>&limit=50
//   POST /projects/:projectId/messages   { body }   -> broadcast 'chat:message'
//        A message mentioning @ai gets an asynchronous Foundry reply (also broadcast).

const { query } = require('../config/db');
const { requireAdoProject } = require('./auth');
const { loadEffectiveConfig } = require('./projectConfig');
const { broadcast } = require('./realtime');
const foundry = require('./foundry');
const { createRepoContext } = require('./repoContext');

const MAX_BODY = 4000;
const AI_HISTORY = 30;
const AI_PER_HOUR = Number(process.env.AI_REPLIES_PER_HOUR || 30);

// Per-project AI throttle (in-memory; one App Service instance).
const aiState = new Map(); // room -> { busy, times: [] }

function aiAllowed(key) {
  const st = aiState.get(key) || { busy: false, times: [] };
  aiState.set(key, st);
  const hourAgo = Date.now() - 3600e3;
  st.times = st.times.filter((t) => t > hourAgo);
  if (st.busy) return { ok: false, reason: 'The AI is still answering the previous question.' };
  if (st.times.length >= AI_PER_HOUR) return { ok: false, reason: 'AI reply limit for this project reached; try again later.' };
  st.busy = true;
  st.times.push(Date.now());
  return { ok: true, done: () => { st.busy = false; } };
}

function mentionsAi(body) {
  return /(^|[\s(])@ai\b/i.test(body);
}

function toClient(row) {
  return {
    id: row.id,
    authorId: row.author_id,
    authorName: row.author_name,
    kind: row.kind,
    body: row.body,
    createdAt: row.created_at,
  };
}

async function insertMessage(org, projectId, { authorId = null, authorName, kind = 'user', body }) {
  const { rows } = await query(
    `INSERT INTO ado_messages (org, project_id, author_id, author_name, kind, body)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [org.toLowerCase(), projectId, authorId, authorName, kind, body]
  );
  return toClient(rows[0]);
}

async function postAndBroadcast(ado, msg) {
  const m = await insertMessage(ado.org, ado.project.id, msg);
  broadcast(ado.org, ado.project.id, 'chat:message', m);
  return m;
}

async function recentMessages(org, projectId, limit) {
  const { rows } = await query(
    `SELECT * FROM (
       SELECT * FROM ado_messages WHERE org = $1 AND project_id = $2
       ORDER BY created_at DESC LIMIT $3
     ) t ORDER BY created_at ASC`,
    [org.toLowerCase(), projectId, limit]
  );
  return rows.map(toClient);
}

// Work items referenced as #123 in the conversation, as short text for the model.
async function referencedItems(ado, history) {
  const ids = new Set();
  for (const m of history.slice(-10)) for (const x of m.body.matchAll(/#(\d{1,9})\b/g)) ids.add(Number(x[1]));
  if (!ids.size) return '';
  const items = await ado.client.getWorkItems(ado.project.id, [...ids].slice(0, 10),
    ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.AssignedTo']).catch(() => []);
  return items.map((w) => {
    const f = w.fields || {};
    const who = f['System.AssignedTo'] ? (f['System.AssignedTo'].displayName || f['System.AssignedTo']) : 'unassigned';
    return `#${w.id} [${f['System.WorkItemType']}] ${f['System.Title']} — ${f['System.State']}, ${who}`;
  }).join('\n');
}

async function aiReply(ado) {
  const key = `${ado.org.toLowerCase()}|${ado.project.id}`;
  const gate = aiAllowed(key);
  if (!gate.ok) {
    await postAndBroadcast(ado, { authorName: 'simplan', kind: 'system', body: gate.reason });
    return;
  }
  try {
    if (!foundry.isConfigured()) throw new Error('AI is not configured on the server.');
    const conf = await loadEffectiveConfig(ado);
    const v = conf.values;
    const history = await recentMessages(ado.org, ado.project.id, AI_HISTORY);
    const repoCtx = await createRepoContext(ado, conf.repo, v['ai.contextPaths']).catch(() => null);
    const items = await referencedItems(ado, history);

    const system = [
      `You are simplan, an assistant in the Azure DevOps project "${ado.project.name}". Be concise and practical.`,
      'You are answering the latest message that mentions @ai in the project chat.',
      repoCtx && repoCtx.listing.length
        ? `You may read these repository files with read_file when useful:\n${repoCtx.listing.join('\n')}${repoCtx.listingTruncated ? '\n…' : ''}`
        : 'No repository files are available to you.',
      items ? `Work items mentioned in the chat:\n${items}` : '',
      'If the discussion contains work to do, suggest using "Turn into tickets" in the chat to create work items.',
      v['ai.systemPrompt'] ? `Project instructions: ${v['ai.systemPrompt']}` : '',
    ].filter(Boolean).join('\n\n');

    const messages = history
      .filter((m) => m.kind !== 'system')
      .map((m) => (m.kind === 'ai'
        ? { role: 'assistant', content: m.body }
        : { role: 'user', content: `${m.authorName}: ${m.body}` }));

    const text = await foundry.chatWithTools({
      deployment: v['ai.deployment'],
      system,
      messages,
      tools: repoCtx && repoCtx.listing.length ? [repoCtx.tool] : [],
    });
    await postAndBroadcast(ado, { authorName: 'simplan AI', kind: 'ai', body: (text || '(no answer)').slice(0, 8000) });
  } catch (err) {
    console.error('AI reply failed:', err.message);
    await postAndBroadcast(ado, {
      authorName: 'simplan', kind: 'system', body: `AI reply failed: ${err.expose || /configured/.test(err.message) ? err.message : 'internal error'}`,
    }).catch(() => {});
  } finally {
    gate.done();
  }
}

function register(router) {
  const P = '/projects/:projectId';

  router.get(`${P}/messages`, requireAdoProject, async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const params = [req.ado.org.toLowerCase(), req.ado.project.id, limit];
      let before = '';
      if (req.query.before) {
        const d = new Date(String(req.query.before));
        if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid before' });
        params.push(d.toISOString());
        before = 'AND created_at < $4';
      }
      const { rows } = await query(
        `SELECT * FROM (
           SELECT * FROM ado_messages WHERE org = $1 AND project_id = $2 ${before}
           ORDER BY created_at DESC LIMIT $3
         ) t ORDER BY created_at ASC`,
        params
      );
      res.json(rows.map(toClient));
    } catch (err) {
      next(err);
    }
  });

  router.post(`${P}/messages`, requireAdoProject, async (req, res, next) => {
    try {
      const body = String((req.body && req.body.body) || '').trim();
      if (!body) return res.status(400).json({ error: 'body is required' });
      if (body.length > MAX_BODY) return res.status(400).json({ error: `Message is longer than ${MAX_BODY} characters` });
      const ado = req.ado;
      const msg = await postAndBroadcast(ado, { authorId: ado.userId, authorName: ado.displayName, body });
      const ai = mentionsAi(body);
      res.status(201).json({ ...msg, aiRequested: ai });
      if (ai) aiReply(ado); // async; result arrives over the socket
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { register, insertMessage, postAndBroadcast, mentionsAi, toClient };
