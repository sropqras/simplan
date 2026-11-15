'use strict';

// Thin Azure DevOps REST client that acts *as the signed-in user*, using the
// access token the extension gets from SDK.getAccessToken(). ADO enforces the
// user's own permissions on every call; we never hold a service credential.

const API_VERSION = '7.1';
const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class AdoError extends Error {
  constructor(status, message, body) {
    super(message);
    // Pass through ADO's auth/permission/not-found statuses; anything else is a 502.
    // 412 = failed "test /rev" patch op (someone else changed the item) -> 409 conflict.
    // 400 from ADO is usually a validation error on our input (e.g. invalid state) -> 400.
    this.status = status === 412 ? 409 : [400, 401, 403, 404, 409].includes(status) ? status : 502;
    this.adoStatus = status;
    this.expose = true;
    this.body = body;
  }
}

function isValidOrg(org) {
  return typeof org === 'string' && ORG_RE.test(org);
}

function createAdoClient({ org, token, fetchImpl = fetch, baseUrl = process.env.ADO_BASE_URL || 'https://dev.azure.com' }) {
  // org becomes part of the URL host path: validate strictly to rule out SSRF.
  if (!isValidOrg(org)) throw Object.assign(new Error('Invalid organization'), { status: 400, expose: true });
  if (!token) throw Object.assign(new Error('Missing ADO access token'), { status: 401, expose: true });
  const root = `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(org)}`;

  async function call(method, path, { query = {}, body, contentType = 'application/json', allow404 = false } = {}) {
    const url = new URL(root + path);
    for (const [k, v] of Object.entries({ ...query, 'api-version': query['api-version'] || API_VERSION })) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': contentType } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual', // ADO redirects to a sign-in page on bad tokens; treat as 401
    });
    if (allow404 && res.status === 404) return null;
    if (res.status >= 300 && res.status < 400) throw new AdoError(401, 'Azure DevOps rejected the access token');
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && data.message) || `Azure DevOps request failed (${res.status})`;
      throw new AdoError(res.status, msg, data);
    }
    return data;
  }

  const enc = encodeURIComponent;

  return {
    org,
    call,

    // Who the access token belongs to.
    async connectionData() {
      return call('GET', '/_apis/connectionData', { query: { 'api-version': '7.1-preview' } });
    },

    async getProject(projectId) {
      if (!GUID_RE.test(projectId)) throw Object.assign(new Error('Invalid projectId'), { status: 400, expose: true });
      return call('GET', `/_apis/projects/${enc(projectId)}`);
    },

    // Evaluates the *caller's* permission bits on a security namespace token.
    async hasPermission(namespaceId, bits, securityToken) {
      const data = await call('GET', `/_apis/permissions/${enc(namespaceId)}/${bits}`, {
        query: { tokens: securityToken },
      });
      return Boolean(data && Array.isArray(data.value) && data.value[0] === true);
    },

    async listRepos(projectId) {
      const data = await call('GET', `/${enc(projectId)}/_apis/git/repositories`);
      return (data && data.value) || [];
    },

    // Raw text of a file on a branch, or null if it doesn't exist.
    async getFileText(projectId, repoId, path, branch) {
      const data = await call('GET', `/${enc(projectId)}/_apis/git/repositories/${enc(repoId)}/items`, {
        query: {
          path,
          includeContent: true,
          'versionDescriptor.version': branch,
          'versionDescriptor.versionType': 'branch',
        },
        allow404: true,
      });
      return data ? data.content : null;
    },

    async getBranchHead(projectId, repoId, branch) {
      const data = await call('GET', `/${enc(projectId)}/_apis/git/repositories/${enc(repoId)}/refs`, {
        query: { filter: `heads/${branch}` },
      });
      const ref = ((data && data.value) || []).find((r) => r.name === `refs/heads/${branch}`);
      return ref ? ref.objectId : null;
    },

    // Creates a new branch from `baseObjectId` with one file added/edited.
    async pushFile(projectId, repoId, { newBranch, baseObjectId, path, content, exists, comment }) {
      return call('POST', `/${enc(projectId)}/_apis/git/repositories/${enc(repoId)}/pushes`, {
        body: {
          refUpdates: [{ name: `refs/heads/${newBranch}`, oldObjectId: '0000000000000000000000000000000000000000' }],
          commits: [{
            comment,
            parents: [baseObjectId],
            changes: [{
              changeType: exists ? 'edit' : 'add',
              item: { path },
              newContent: { content, contentType: 'rawtext' },
            }],
          }],
        },
      });
    },

    // ---------- Work items ----------

    // Runs a WIQL query; returns work item ids (ADO caps WIQL results; we cap again).
    async wiqlIds(projectId, wiql, top = 500) {
      const data = await call('POST', `/${enc(projectId)}/_apis/wit/wiql`, {
        query: { $top: top },
        body: { query: wiql },
      });
      return ((data && data.workItems) || []).map((w) => w.id);
    },

    // Batch-fetch work items (200 per request is the ADO limit).
    async getWorkItems(projectId, ids, fields) {
      const out = [];
      for (let i = 0; i < ids.length; i += 200) {
        const data = await call('POST', `/${enc(projectId)}/_apis/wit/workitemsbatch`, {
          body: { ids: ids.slice(i, i + 200), fields, errorPolicy: 'omit' },
        });
        out.push(...((data && data.value) || []).filter(Boolean));
      }
      return out;
    },

    async getWorkItem(projectId, id, { relations = false } = {}) {
      return call('GET', `/${enc(projectId)}/_apis/wit/workitems/${Number(id)}`, {
        query: relations ? { $expand: 'relations' } : {},
        allow404: true,
      });
    },

    // ops = JSON-patch array, e.g. [{ op: 'add', path: '/fields/System.Title', value: 'x' }]
    async createWorkItem(projectId, type, ops) {
      return call('POST', `/${enc(projectId)}/_apis/wit/workitems/$${enc(type)}`, {
        body: ops, contentType: 'application/json-patch+json',
      });
    },

    async updateWorkItem(projectId, id, ops) {
      return call('PATCH', `/${enc(projectId)}/_apis/wit/workitems/${Number(id)}`, {
        body: ops, contentType: 'application/json-patch+json',
      });
    },

    async listWorkItemTypes(projectId) {
      const data = await call('GET', `/${enc(projectId)}/_apis/wit/workitemtypes`);
      return ((data && data.value) || []).filter((t) => !t.isDisabled).map((t) => t.name);
    },

    async getWorkItemTypeStates(projectId, type) {
      const data = await call('GET', `/${enc(projectId)}/_apis/wit/workitemtypes/${enc(type)}/states`);
      return (data && data.value) || [];
    },

    async getTeamMembers(projectId, teamId) {
      const data = await call('GET', `/_apis/projects/${enc(projectId)}/teams/${enc(teamId)}/members`, {
        query: { $top: 500 },
      });
      return ((data && data.value) || []).map((m) => m.identity || m).filter(Boolean);
    },

    // ---------- Git ----------

    // Full file list of a branch (paths only).
    async listTree(projectId, repoId, branch) {
      const data = await call('GET', `/${enc(projectId)}/_apis/git/repositories/${enc(repoId)}/items`, {
        query: {
          scopePath: '/',
          recursionLevel: 'Full',
          'versionDescriptor.version': branch,
          'versionDescriptor.versionType': 'branch',
        },
      });
      return ((data && data.value) || []).filter((i) => !i.isFolder).map((i) => i.path);
    },

    async createBranch(projectId, repoId, name, objectId) {
      const data = await call('POST', `/${enc(projectId)}/_apis/git/repositories/${enc(repoId)}/refs`, {
        body: [{ name: `refs/heads/${name}`, oldObjectId: '0000000000000000000000000000000000000000', newObjectId: objectId }],
      });
      const r = data && data.value && data.value[0];
      if (r && r.success === false) {
        throw new AdoError(r.updateStatus === 'failedToCreateRefAlreadyExists' ? 409 : 400,
          `Could not create branch (${r.updateStatus || 'failed'})`);
      }
      return r;
    },

    async getPullRequest(projectId, prId) {
      return call('GET', `/${enc(projectId)}/_apis/git/pullrequests/${Number(prId)}`, { allow404: true });
    },

    // ---------- Service hooks ----------

    async listSubscriptions() {
      const data = await call('GET', '/_apis/hooks/subscriptions');
      return (data && data.value) || [];
    },

    async createSubscription(body) {
      return call('POST', '/_apis/hooks/subscriptions', { body });
    },

    async deleteSubscription(id) {
      return call('DELETE', `/_apis/hooks/subscriptions/${enc(id)}`, { allow404: true });
    },

    async createPullRequest(projectId, repoId, { sourceBranch, targetBranch, title, description }) {
      return call('POST', `/${enc(projectId)}/_apis/git/repositories/${enc(repoId)}/pullrequests`, {
        body: {
          sourceRefName: `refs/heads/${sourceBranch}`,
          targetRefName: `refs/heads/${targetBranch}`,
          title,
          description,
        },
      });
    },
  };
}

module.exports = { createAdoClient, isValidOrg, AdoError, GUID_RE, API_VERSION };
