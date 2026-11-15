// Shared bootstrap for every simplan extension page:
// initialises the Azure DevOps SDK and wraps calls to the simplan backend with
// the three headers it expects (app token, user access token, organization).

import * as SDK from 'azure-devops-extension-sdk';

/* global __SIMPLAN_API__ */
const API = __SIMPLAN_API__;

export async function initPage() {
  await SDK.init({ loaded: false, applyTheme: true });
  await SDK.ready();
  const host = SDK.getHost();
  const web = SDK.getWebContext();
  return {
    SDK,
    org: host.name,
    project: web && web.project ? { id: web.project.id, name: web.project.name } : null,
    user: SDK.getUser(),
  };
}

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details || [];
  }
}

export async function api(ctx, method, path, body) {
  const [appToken, accessToken] = await Promise.all([SDK.getAppToken(), SDK.getAccessToken()]);
  const res = await fetch(`${API}/ado/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${appToken}`,
      'X-ADO-Token': accessToken,
      'X-ADO-Org': ctx.org,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Request failed (${res.status})`, data.details);
  return data;
}

// Tiny DOM helper: h('div', { class: 'x', onclick }, 'text', childNode)
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    // Properties (value/selected/disabled/...) must be set as properties, not attributes:
    // a textarea ignores a `value` attribute.
    else if (k in el && (typeof v !== 'string' || k === 'value')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Like root.replaceChildren(), but flattens arrays and skips null/false the way h() does
// (replaceChildren would render them as "null" / "[object HTMLDivElement]").
export function mount(root, ...children) {
  root.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    .map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))));
}

export function showFatal(root, err) {
  mount(root,
    h('div', { class: 'banner error' },
      h('strong', {}, 'simplan could not load. '),
      err && err.message ? err.message : String(err))
  );
}
