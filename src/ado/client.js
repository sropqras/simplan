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
    this.status = [401, 403, 404, 409].includes(status) ? status : 502;
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
