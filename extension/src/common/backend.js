// Shared bootstrap for every simplan extension page:
// initialises the Azure DevOps SDK and wraps calls to the simplan backend with
// the three headers it expects (app token, user access token, organization).

import * as SDK from 'azure-devops-extension-sdk';
import { io } from 'socket.io-client';

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

// ---------- realtime ----------

// Connects to the backend's /ado namespace and joins the project room.
// auth is a function so reconnects always send fresh tokens. Returns the socket.
export function connectLive(ctx, view, { onStatus = () => {} } = {}) {
  const socket = io(`${API}/ado`, {
    transports: ['websocket', 'polling'],
    auth: (cb) => {
      Promise.all([SDK.getAppToken(), SDK.getAccessToken()])
        .then(([appToken, accessToken]) => cb({ appToken, accessToken, org: ctx.org }))
        .catch(() => cb({}));
    },
  });
  socket.on('connect', () => {
    socket.emit('join', { projectId: ctx.project.id, view }, (ack) => onStatus(ack && ack.ok ? 'live' : 'error', ack));
  });
  socket.on('disconnect', () => onStatus('offline'));
  socket.on('connect_error', (err) => onStatus('error', { error: err.message }));
  return socket;
}

// ---------- host navigation ----------
export async function openWorkItem(id) {
  const svc = await SDK.getService('ms.vss-work-web.work-item-form-navigation-service');
  return svc.openWorkItem(id);
}

export async function hostQueryParams() {
  try {
    const nav = await SDK.getService('ms.vss-features.host-navigation-service');
    return (await nav.getQueryParams()) || {};
  } catch {
    return {};
  }
}

// URL of one of this extension's hubs in the current project.
export async function hubUrl(ctx, hubId, params = {}) {
  let base = `https://dev.azure.com/${encodeURIComponent(ctx.org)}/`;
  try {
    const loc = await SDK.getService('ms.vss-features.location-service');
    base = (await loc.getServiceLocation()) || base;
  } catch { /* fall back to dev.azure.com */ }
  const ext = SDK.getExtensionContext();
  const qs = new URLSearchParams(params).toString();
  return `${base.replace(/\/?$/, '/')}${encodeURIComponent(ctx.project.name)}/_apps/hub/${ext.publisherId}.${ext.extensionId}.${hubId}${qs ? `?${qs}` : ''}`;
}

export async function navigateTo(url) {
  const nav = await SDK.getService('ms.vss-features.host-navigation-service');
  nav.navigate(url);
}

// ---------- small UI helpers ----------
export function initials(name) {
  return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
}

export function presenceBar(list) {
  return h('span', { class: 'presence', title: list.map((u) => u.displayName).join(', ') },
    list.slice(0, 8).map((u) => h('span', { class: 'avatar', title: `${u.displayName} (${u.views.join(', ')})` }, initials(u.displayName))),
    list.length > 8 ? h('span', { class: 'muted' }, `+${list.length - 8}`) : null);
}

export function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
