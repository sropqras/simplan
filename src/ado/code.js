'use strict';

// Milestone 6 — link work items to code in the project's configured repo.
//
//   POST /projects/:projectId/workitems/:id/branch    { name? }  create branch + ArtifactLink
//   GET  /projects/:projectId/workitems/:id/code      branches, PRs (+status), originating chat
//   POST /projects/:projectId/workitems/:id/summary   AI summary of the item (Foundry)

const { query } = require('../config/db');
const { requireAdoProject } = require('./auth');
const { loadEffectiveConfig } = require('./projectConfig');
const { loadProjectItem, parseWorkItemId, normalizeItem } = require('./board');
const { broadcast } = require('./realtime');
const foundry = require('./foundry');

function slugify(s, max = 40) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'work';
}

// Git ref-name rules (subset of git check-ref-format) + our own length cap.
function isValidBranchName(name) {
  return typeof name === 'string'
    && name.length > 0 && name.length <= 200
    && /^[A-Za-z0-9._/-]+$/.test(name)
    && !name.includes('..') && !name.includes('//')
    && !/^[/.-]|[/.]$/.test(name)
    && !/\.lock(\/|$)/.test(name)
    && !name.split('/').some((seg) => seg.startsWith('.'));
}

function branchFromPattern(pattern, item) {
  return String(pattern || 'feature/{id}-{slug}')
    .replace(/\{id\}/g, String(item.id))
    .replace(/\{slug\}/g, slugify(item.title))
    .replace(/\{type\}/g, slugify(item.type, 20));
}

function branchArtifactUrl(projectId, repoId, branch) {
  return `vstfs:///Git/Ref/${projectId}%2F${repoId}%2FGB${encodeURIComponent(branch)}`;
}

// Parses ArtifactLink urls on a work item into branches / PRs / commits.
function parseArtifactLinks(relations) {
  const out = { branches: [], pullRequests: [], commits: [] };
  for (const r of relations || []) {
    if (r.rel !== 'ArtifactLink' || typeof r.url !== 'string') continue;
    const m = /^vstfs:\/\/\/Git\/(Ref|PullRequestId|Commit)\/(.+)$/i.exec(r.url);
    if (!m) continue;
    const parts = decodeURIComponent(m[2]).split('/');
    const [projectId, repoId] = parts;
    const rest = parts.slice(2).join('/');
    const kind = m[1].toLowerCase();
    if (kind === 'ref' && rest.startsWith('GB')) out.branches.push({ projectId, repoId, name: rest.slice(2) });
    else if (kind === 'pullrequestid' && /^\d+$/.test(rest)) out.pullRequests.push({ projectId, repoId, id: Number(rest) });
    else if (kind === 'commit') out.commits.push({ projectId, repoId, id: rest });
  }
  return out;
}

function stripHtml(html) {
  return String(html || '').replace(/<(br|\/p|\/div|\/li)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
}

// Creates `name` (or the configured pattern) from the repo's default branch and links it.
async function createBranchForItem(ado, conf, wi, requestedName) {
  if (!conf.repo || !conf.repo.defaultBranch) {
    throw Object.assign(new Error('No repository with a default branch is configured for this project'), { status: 409, expose: true });
  }
  const item = normalizeItem(wi);
  const name = requestedName ? String(requestedName).trim() : branchFromPattern(conf.values['tickets.branchPattern'], item);
  if (!isValidBranchName(name)) {
    throw Object.assign(new Error(`Invalid branch name "${name}"`), { status: 400, expose: true });
  }
  const head = await ado.client.getBranchHead(ado.project.id, conf.repo.id, conf.repo.defaultBranch);
  if (!head) throw Object.assign(new Error('Default branch not found'), { status: 409, expose: true });
  await ado.client.createBranch(ado.project.id, conf.repo.id, name, head);
  await ado.client.updateWorkItem(ado.project.id, item.id, [{
    op: 'add',
    path: '/relations/-',
    value: { rel: 'ArtifactLink', url: branchArtifactUrl(ado.project.id, conf.repo.id, name), attributes: { name: 'Branch' } },
  }]);
  return {
    name,
    repo: conf.repo.name,
    url: conf.repo.webUrl ? `${conf.repo.webUrl}?version=GB${encodeURIComponent(name)}` : null,
  };
}

async function originOf(ado, workItemId) {
  const { rows } = await query(
    `SELECT id, payload, source_message_ids, requested_by, decided_by, decided_at, created_at
       FROM ado_proposals WHERE org = $1 AND project_id = $2 AND work_item_id = $3
      ORDER BY created_at DESC LIMIT 1`,
    [ado.org.toLowerCase(), ado.project.id, workItemId]
  );
  if (!rows.length) return null;
  const p = rows[0];
  const { rows: msgs } = await query(
    `SELECT author_name, kind, body, created_at FROM ado_messages
      WHERE org = $1 AND project_id = $2 AND id = ANY($3::uuid[]) ORDER BY created_at ASC`,
    [ado.org.toLowerCase(), ado.project.id, p.source_message_ids]
  );
  return {
    proposalId: p.id,
    approvedAt: p.decided_at,
    messages: msgs.map((m) => ({ authorName: m.author_name, kind: m.kind, body: m.body, createdAt: m.created_at })),
  };
}

function register(router) {
  const P = '/projects/:projectId/workitems/:id';

  router.post(`${P}/branch`, requireAdoProject, async (req, res, next) => {
    try {
      const ado = req.ado;
      const wi = await loadProjectItem(ado, parseWorkItemId(req.params.id));
      const conf = await loadEffectiveConfig(ado);
      const branch = await createBranchForItem(ado, conf, wi, req.body && req.body.name);
      broadcast(ado.org, ado.project.id, 'workitem:changed', { id: wi.id, eventType: 'simplan.branch' });
      res.status(201).json(branch);
    } catch (err) {
      next(err);
    }
  });

  router.get(`${P}/code`, requireAdoProject, async (req, res, next) => {
    try {
      const ado = req.ado;
      const wi = await loadProjectItem(ado, parseWorkItemId(req.params.id), { relations: true });
      const links = parseArtifactLinks(wi.relations);
      const repos = await ado.client.listRepos(ado.project.id).catch(() => []);
      const repoById = new Map(repos.map((r) => [String(r.id).toLowerCase(), r]));
      const repoOf = (id) => repoById.get(String(id).toLowerCase());

      const prs = await Promise.all(links.pullRequests.slice(0, 10).map(async (l) => {
        const pr = await ado.client.getPullRequest(ado.project.id, l.id).catch(() => null);
        const repo = repoOf(l.repoId);
        return {
          id: l.id,
          title: pr ? pr.title : null,
          status: pr ? pr.status : 'unknown',
          isDraft: pr ? Boolean(pr.isDraft) : false,
          sourceBranch: pr && pr.sourceRefName ? pr.sourceRefName.replace(/^refs\/heads\//, '') : null,
          repo: repo ? repo.name : null,
          url: repo && repo.webUrl ? `${repo.webUrl}/pullrequest/${l.id}` : null,
        };
      }));
      const branches = links.branches.map((b) => {
        const repo = repoOf(b.repoId);
        return { name: b.name, repo: repo ? repo.name : null, url: repo && repo.webUrl ? `${repo.webUrl}?version=GB${encodeURIComponent(b.name)}` : null };
      });

      res.json({
        item: normalizeItem(wi),
        branches,
        pullRequests: prs,
        commits: links.commits.length,
        origin: await originOf(ado, wi.id),
        aiAvailable: foundry.isConfigured(),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post(`${P}/summary`, requireAdoProject, async (req, res, next) => {
    try {
      const ado = req.ado;
      const wi = await loadProjectItem(ado, parseWorkItemId(req.params.id), { relations: true });
      const f = wi.fields || {};
      const conf = await loadEffectiveConfig(ado);
      const origin = await originOf(ado, wi.id);
      const links = parseArtifactLinks(wi.relations);
      const prs = await Promise.all(links.pullRequests.slice(0, 5).map((l) => ado.client.getPullRequest(ado.project.id, l.id).catch(() => null)));
      const text = [
        `Work item #${wi.id} [${f['System.WorkItemType']}] "${f['System.Title']}" — state ${f['System.State']}`,
        `Description:\n${stripHtml(f['System.Description']).slice(0, 6000) || '(none)'}`,
        f['Microsoft.VSTS.Common.AcceptanceCriteria'] ? `Acceptance criteria:\n${stripHtml(f['Microsoft.VSTS.Common.AcceptanceCriteria']).slice(0, 3000)}` : '',
        prs.filter(Boolean).length ? `Pull requests:\n${prs.filter(Boolean).map((p) => `!${p.pullRequestId} ${p.title} (${p.status})`).join('\n')}` : '',
        links.branches.length ? `Branches: ${links.branches.map((b) => b.name).join(', ')}` : '',
        origin && origin.messages.length ? `Originating chat:\n${origin.messages.map((m) => `${m.authorName}: ${m.body}`).join('\n').slice(0, 4000)}` : '',
      ].filter(Boolean).join('\n\n');
      const summary = await foundry.chatReply({
        deployment: conf.values['ai.deployment'],
        system: 'Summarise this Azure DevOps work item for a teammate in at most 5 short bullet points: goal, current status, open questions, next step. No preamble.'
          + (conf.values['ai.systemPrompt'] ? `\nProject instructions: ${conf.values['ai.systemPrompt']}` : ''),
        messages: [{ role: 'user', content: text }],
      });
      res.json({ summary });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = {
  register, createBranchForItem, branchFromPattern, isValidBranchName, slugify,
  parseArtifactLinks, branchArtifactUrl, stripHtml,
};
