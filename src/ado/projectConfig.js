'use strict';

// Loads a project's effective simplan config: repo .simplan.yml merged with tool overrides.
// Shared by every /ado/api feature route.

const { query } = require('../config/db');
const cfg = require('./config');

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

module.exports = { loadOverrides, loadEffectiveConfig };
