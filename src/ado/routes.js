'use strict';

// REST surface for the Azure DevOps extension: /ado/api/*
// Every route is behind requireAdoUser (app token + user access token, see auth.js).

const express = require('express');
const { query } = require('../config/db');
const { requireAdoUser, requireAdoProject, requireAdoProjectAdmin, isProjectAdmin } = require('./auth');
const cfg = require('./config');
const { loadOverrides, loadEffectiveConfig } = require('./projectConfig');

const router = express.Router();
router.use(requireAdoUser);

function schemaForClient() {
  const out = {};
  for (const [k, s] of Object.entries(cfg.SCHEMA)) {
    out[k] = { type: s.type, default: s.default, values: s.values, help: s.help || null };
  }
  return out;
}

async function canEditConfig(ado) {
  try {
    return await isProjectAdmin(ado);
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

// Feature routes (milestones 3-6) share the same auth chain.
require('./board').register(router);
require('./chat').register(router);
require('./proposals').register(router);
require('./code').register(router);

module.exports = router;
