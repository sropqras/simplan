'use strict';

// Authentication for requests coming from the Azure DevOps extension.
//
// Every request carries:
//   Authorization: Bearer <appToken>   from SDK.getAppToken()   -> proves it's our extension + which user
//   X-ADO-Token:   <accessToken>       from SDK.getAccessToken() -> lets us call ADO REST as that user
//   X-ADO-Org:     <organization>      from SDK.getHost().name
//
// We verify the app token, then confirm the access token belongs to the same user
// in that org (connectionData). ADO itself enforces project/repo permissions on
// every downstream call. No cookies are used in ADO mode.

const crypto = require('crypto');
const { verifyAppToken } = require('./appToken');
const { createAdoClient, isValidOrg, GUID_RE } = require('./client');

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 5000;
const identityCache = new Map(); // sha256(org|accessToken) -> { userId, displayName, expires }
const projectCache = new Map();  // `${org}|${userId}|${projectId}` -> { project, expires }

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) { map.delete(key); return null; }
  return hit;
}
function cacheSet(map, key, value) {
  if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
  map.set(key, { ...value, expires: Date.now() + CACHE_TTL_MS });
}
function clearAuthCaches() { identityCache.clear(); projectCache.clear(); }

function fail(res, status, error) {
  return res.status(status).json({ error });
}

// Resolves the caller from headers (shared by HTTP middleware and the socket handshake).
// Returns { userId, displayName, org, client }; throws errors with .status.
async function resolveAdoUser({ appToken, accessToken, org }) {
  const claims = verifyAppToken(appToken, process.env.ADO_EXTENSION_SECRET);
  if (!isValidOrg(org)) throw Object.assign(new Error('Missing or invalid X-ADO-Org'), { status: 400, expose: true });
  if (!accessToken) throw Object.assign(new Error('Missing X-ADO-Token'), { status: 401, expose: true });

  const client = createAdoClient({ org, token: accessToken });
  const key = crypto.createHash('sha256').update(`${org.toLowerCase()}|${accessToken}`).digest('hex');
  let ident = cacheGet(identityCache, key);
  if (!ident) {
    const cd = await client.connectionData();
    const user = cd && cd.authenticatedUser;
    if (!user || !user.id) throw Object.assign(new Error('Could not resolve Azure DevOps user'), { status: 401, expose: true });
    ident = { userId: user.id, displayName: user.providerDisplayName || user.customDisplayName || 'Unknown' };
    cacheSet(identityCache, key, ident);
  }
  if (String(ident.userId).toLowerCase() !== String(claims.nameid).toLowerCase()) {
    throw Object.assign(new Error('Access token and app token belong to different users'), { status: 401, expose: true });
  }
  return { userId: ident.userId, displayName: ident.displayName, org, client };
}

async function requireAdoUser(req, res, next) {
  try {
    const auth = req.get('authorization') || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (!m) return fail(res, 401, 'Missing app token');
    req.ado = await resolveAdoUser({
      appToken: m[1].trim(),
      accessToken: req.get('x-ado-token'),
      org: req.get('x-ado-org'),
    });
    return next();
  } catch (err) {
    return next(err);
  }
}

// Confirms the caller can see req.params.projectId in their org (ADO decides).
async function loadAdoProject(ado, projectId) {
  if (!GUID_RE.test(projectId || '')) throw Object.assign(new Error('Invalid projectId'), { status: 400, expose: true });
  const key = `${ado.org.toLowerCase()}|${ado.userId}|${projectId.toLowerCase()}`;
  const hit = cacheGet(projectCache, key);
  if (hit) return hit.project;
  let project;
  try {
    const p = await ado.client.getProject(projectId);
    project = { id: p.id, name: p.name };
  } catch (err) {
    // Hide existence of projects the user can't see.
    if (err.status === 404 || err.status === 403) {
      throw Object.assign(new Error('Project not found'), { status: 404, expose: true });
    }
    throw err;
  }
  cacheSet(projectCache, key, { project });
  return project;
}

async function requireAdoProject(req, res, next) {
  try {
    req.ado.project = await loadAdoProject(req.ado, req.params.projectId);
    return next();
  } catch (err) {
    return next(err);
  }
}

// "Project" security namespace; bit 2 = GENERIC_WRITE ("Edit project-level information"),
// held by Project Administrators. Gates writes to the tool's own config.
const PROJECT_NAMESPACE = '52d39943-cb85-4d7f-8fa8-c6baac873819';
const PROJECT_GENERIC_WRITE = 2;

async function requireAdoProjectAdmin(req, res, next) {
  try {
    const token = `$PROJECT:vstfs:///Classification/TeamProject/${req.ado.project.id}`;
    const ok = await req.ado.client.hasPermission(PROJECT_NAMESPACE, PROJECT_GENERIC_WRITE, token);
    if (!ok) return fail(res, 403, 'Project administrator permission required');
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  resolveAdoUser,
  requireAdoUser,
  loadAdoProject,
  requireAdoProject,
  requireAdoProjectAdmin,
  clearAuthCaches,
  PROJECT_NAMESPACE,
};
