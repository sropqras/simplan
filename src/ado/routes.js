'use strict';

// REST surface for the Azure DevOps extension: /ado/api/*
// Every route is behind requireAdoUser (app token + user access token, see auth.js).

const express = require('express');
const { query } = require('../config/db');
const { requireAdoUser, requireAdoProject, requireAdoProjectAdmin, PROJECT_NAMESPACE } = require('./auth');
const cfg = require('./config');

const router = express.Router();
router.use(requireAdoUser);

// ---------- helpers ----------

async function loadOverrides(org, projectId) {
  const { rows } = await query(
    'SELECT settings FROM ado_projects WHERE org = $1 AND project_id = $2',
    [org.toLowerCase(), projectId]
  );
  return (rows[0] && rows[0].settings) || {};
}

// Builds the full config view for a project: which repo, what the repo file says,
// the tool overrides, and the merged result with per-key sources.
async function loadEffectiveConfig(ado) {
  const project = ado.project;
  const overrides = await loadOverrides(ado.org, project.id);

  const repos = await ado.client.listRepos(project.id);
  const repo = cfg.pickRepo(repos, project.name, overrides.repo);
  const repoFile = { path: cfg.CONFIG_PATH, exists: false, errors: [] };
  let repoValues = {};

  if (!repo && overrides.repo) repoFile.errors.push(`Repository "${overrides.repo}" not found in this project`);
  const branch = repo && cfg.branchName(repo.defaultBranch);
  if (repo && branch) {
    const text = await ado.client.getFileText(project.id, repo.id, cfg.CONFIG_PATH, branch);
    if (text != null) {
      repoFile.exists = true;
      const parsed = cfg.parseRepoConfig(text);
      repoValues = parsed.values;
      repoFile.errors.push(...parsed.errors);
    }
  } else if (repo) {
    repoFile.errors.push('Repository has no default branch yet (empty repo)');
  }

  const { values, sources } = cfg.mergeConfig(repoValues, overrides);
  return {
    project,
    repo: repo ? { id: repo.id, name: repo.name, defaultBranch: branch, webUrl: repo.webUrl || null } : null,
    repos: repos.map((r) => r.name).sort(),
    repoFile,
    repoValues,
    overrides,
    values,
    sources,
  };
}

function schemaForClient() {
  const out = {};
  for (const [k, s] of Object.entries(cfg.SCHEMA)) {
    out[k] = { type: s.type, default: s.default, values: s.values, help: s.help || null };
  }
  return out;
}

async function canEditConfig(ado) {
  try {
    return await ado.client.hasPermission(
      PROJECT_NAMESPACE, 2, `$PROJECT:vstfs:///Classification/TeamProject/${ado.project.id}`
    );
  } catch {
    return false; // UI hint only; the PUT route enforces it for real
  }
}

// ---------- routes ----------

router.get('/whoami', (req, res) => {
  const { userId, displayName, org } = req.ado;
  res.json({ userId, displayName, org });
});

router.get('/projects/:projectId/config', requireAdoProject, async (req, res, next) => {
  try {
    const [view, canEdit] = await Promise.all([loadEffectiveConfig(req.ado), canEditConfig(req.ado)]);
    res.json({ ...view, canEdit, schema: schemaForClient() });
  } catch (err) {
    next(err);
  }
});

// Body: { overrides: { 'board.workItemType': 'Bug', 'ai.requireApproval': null, ... } }
// A key set to null removes that override (falls back to repo/default). Keys not sent are kept.
router.put('/projects/:projectId/config', requireAdoProject, requireAdoProjectAdmin, async (req, res, next) => {
  try {
    const changes = cfg.validateOverrides(req.body && req.body.overrides);
    const current = await loadOverrides(req.ado.org, req.ado.project.id);
    const merged = { ...current };
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }

    await query(
      `INSERT INTO ado_projects (org, project_id, project_name, settings, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (org, project_id)
         DO UPDATE SET settings = EXCLUDED.settings,
                       project_name = EXCLUDED.project_name,
                       updated_by = EXCLUDED.updated_by,
                       updated_at = now()`,
      [req.ado.org.toLowerCase(), req.ado.project.id, req.ado.project.name, merged, req.ado.userId]
    );
    const view = await loadEffectiveConfig(req.ado);
    res.json({ ...view, canEdit: true, schema: schemaForClient() });
  } catch (err) {
    next(err);
  }
});

// Writes the current effective config to .simplan.yml on a new branch and opens a PR
// into the default branch. ADO enforces the caller's repo permissions on the push.
router.post('/projects/:projectId/config/commit', requireAdoProject, requireAdoProjectAdmin, async (req, res, next) => {
  try {
    const view = await loadEffectiveConfig(req.ado);
    if (!view.repo) return res.status(409).json({ error: 'No repository found for this project' });
    if (!view.repo.defaultBranch) return res.status(409).json({ error: 'Repository has no default branch yet' });

    const { client, project } = req.ado;
    const base = await client.getBranchHead(project.id, view.repo.id, view.repo.defaultBranch);
    if (!base) return res.status(409).json({ error: 'Default branch not found' });

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const newBranch = `simplan/config-${stamp}`;
    const content = cfg.toYaml(view.values, view.sources);

    await client.pushFile(project.id, view.repo.id, {
      newBranch,
      baseObjectId: base,
      path: cfg.CONFIG_PATH,
      content,
      exists: view.repoFile.exists,
      comment: 'Update simplan configuration',
    });
    const pr = await client.createPullRequest(project.id, view.repo.id, {
      sourceBranch: newBranch,
      targetBranch: view.repo.defaultBranch,
      title: 'Update simplan configuration',
      description: 'Generated from the simplan settings page. Merging this makes the repo file match the current settings.',
    });
    res.status(201).json({
      pullRequestId: pr.pullRequestId,
      branch: newBranch,
      url: view.repo.webUrl ? `${view.repo.webUrl}/pullrequest/${pr.pullRequestId}` : null,
      content,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.loadEffectiveConfig = loadEffectiveConfig;
