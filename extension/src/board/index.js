// simplan Board hub — enhanced live board over real ADO work items.
//
// Columns = states of the configured work item type; optional assignee swimlanes;
// filters; drag-drop (plus a "move" menu for keyboard/touch); quick add; AI-proposed lane
// with approve/reject; presence; live updates over Socket.IO (+ polling fallback).

import {
  initPage, api, h, mount, showFatal, connectLive, openWorkItem, presenceBar,
} from '../common/backend';

const root = document.getElementById('root');
const POLL_MS = 30000;

let ctx;
let board;               // last GET /board payload
const items = new Map(); // id -> item
let filters = { text: '', assignee: '', tag: '' };
let presence = [];
let liveStatus = 'connecting';
let banner = null;       // { kind, text }
let dragId = null;

const UNASSIGNED = '__unassigned__';

function flash(kind, text) {
  banner = { kind, text };
  render();
  if (kind !== 'error') setTimeout(() => { if (banner && banner.text === text) { banner = null; render(); } }, 4000);
}

function columnNames() {
  return board.columns.map((c) => c.name);
}

function belongsOnBoard(item) {
  return item.type === board.workItemType && columnNames().includes(item.state);
}

function upsert(item) {
  if (belongsOnBoard(item)) items.set(item.id, item);
  else items.delete(item.id);
}

function assigneeKey(item) {
  return item.assignedTo ? (item.assignedTo.uniqueName || item.assignedTo.displayName) : UNASSIGNED;
}

function visibleItems() {
  const text = filters.text.toLowerCase();
  return [...items.values()].filter((it) => {
    if (text && !(`#${it.id} ${it.title} ${it.tags.join(' ')}`.toLowerCase().includes(text))) return false;
    if (filters.assignee && assigneeKey(it) !== filters.assignee) return false;
    if (filters.tag && !it.tags.includes(filters.tag)) return false;
    return true;
  });
}

// ---------- mutations ----------

async function move(id, { state, assignedTo }) {
  const it = items.get(id);
  if (!it) return;
  const body = { rev: it.rev };
  if (state && state !== it.state) body.state = state;
  if (assignedTo !== undefined && assignedTo !== assigneeKey(it)) body.assignedTo = assignedTo === UNASSIGNED ? null : assignedTo;
  if (Object.keys(body).length === 1) return;

  const before = { ...it };
  // optimistic
  items.set(id, {
    ...it,
    state: body.state || it.state,
    assignedTo: body.assignedTo === undefined ? it.assignedTo
      : body.assignedTo === null ? null
        : (board.members.find((m) => m.uniqueName === body.assignedTo) || { displayName: body.assignedTo, uniqueName: body.assignedTo }),
  });
  render();
  try {
    upsert(await api(ctx, 'PATCH', `/projects/${ctx.project.id}/workitems/${id}`, body));
  } catch (err) {
    items.set(id, before);
    flash('error', `#${id}: ${err.message}`);
    if (err.status === 409) refreshItem(id);
  }
  render();
}

async function refreshItem(id) {
  try {
    upsert(await api(ctx, 'GET', `/projects/${ctx.project.id}/workitems/${id}`));
  } catch (err) {
    if (err.status === 404) items.delete(id);
  }
  render();
}

async function quickAdd(title) {
  try {
    const it = await api(ctx, 'POST', `/projects/${ctx.project.id}/workitems`, { title });
    upsert(it);
    flash('ok', `Created #${it.id}`);
  } catch (err) {
    flash('error', err.message);
  }
}

async function decide(p, action, createBranch = false) {
  try {
    const r = await api(ctx, 'POST', `/projects/${ctx.project.id}/proposals/${p.id}/${action}`,
      action === 'approve' ? { createBranch } : undefined);
    board.proposals = board.proposals.filter((x) => x.id !== p.id);
    if (action === 'approve') {
      upsert(r.item);
      flash(r.branchError ? 'warn' : 'ok', `Created #${r.item.id}${r.branch ? ` and branch ${r.branch.name}` : ''}${r.branchError ? ` (branch failed: ${r.branchError})` : ''}`);
    } else {
      flash('ok', 'Proposal rejected');
    }
  } catch (err) {
    flash('error', err.message);
  }
}

// ---------- rendering ----------

function card(it) {
  const moveSel = h('select', {
    class: 'move', title: 'Move to column', 'aria-label': `Move #${it.id}`,
    onchange: (e) => move(it.id, { state: e.target.value }),
  }, board.columns.map((c) => h('option', { value: c.name, selected: c.name === it.state }, c.name)));
  return h('div', {
    class: 'wi-card', draggable: 'true', 'data-id': String(it.id),
    ondragstart: (e) => { dragId = it.id; e.dataTransfer.setData('text/plain', String(it.id)); e.currentTarget.classList.add('dragging'); },
    ondragend: (e) => { dragId = null; e.currentTarget.classList.remove('dragging'); },
  },
  h('div', { class: 'wi-head' },
    h('button', { class: 'link wi-id', title: 'Open work item', onclick: () => openWorkItem(it.id) }, `#${it.id}`),
    moveSel),
  h('div', { class: 'wi-title' }, it.title),
  h('div', { class: 'wi-meta' },
    h('span', { class: 'muted' }, it.assignedTo ? it.assignedTo.displayName : 'Unassigned'),
    it.tags.map((t) => h('span', { class: 'chip' }, t))));
}

function columnEl(col, laneKey, laneItems) {
  const list = laneItems.filter((it) => it.state === col.name);
  return h('div', {
    class: 'col',
    ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
    ondragleave: (e) => e.currentTarget.classList.remove('over'),
    ondrop: (e) => {
      e.preventDefault();
      e.currentTarget.classList.remove('over');
      const id = Number(e.dataTransfer.getData('text/plain') || dragId);
      if (id) move(id, { state: col.name, assignedTo: laneKey === null ? undefined : laneKey });
    },
  },
  h('div', { class: 'col-head', style: col.color ? `border-top-color:${col.color}` : null },
    h('span', {}, col.name), h('span', { class: 'count' }, String(list.length))),
  list.map(card));
}

function lanes(vis) {
  if (board.swimlanes !== 'assignee') {
    return [h('div', { class: 'cols' }, board.columns.map((c) => columnEl(c, null, vis)))];
  }
  const keys = new Map([[UNASSIGNED, 'Unassigned']]);
  for (const m of board.members) keys.set(m.uniqueName || m.displayName, m.displayName);
  for (const it of vis) if (it.assignedTo) keys.set(assigneeKey(it), it.assignedTo.displayName);
  return [...keys.entries()]
    .filter(([k]) => !filters.assignee || k === filters.assignee)
    .map(([k, name]) => {
      const laneItems = vis.filter((it) => assigneeKey(it) === k);
      return h('details', { class: 'lane', open: true },
        h('summary', {}, `${name} · ${laneItems.length}`),
        h('div', { class: 'cols' }, board.columns.map((c) => columnEl(c, k, laneItems))));
    });
}

function proposalsLane() {
  if (!board.proposals.length) return null;
  return h('section', { class: 'proposals' },
    h('h2', {}, `AI proposed · ${board.proposals.length}`),
    h('div', { class: 'prop-list' }, board.proposals.map((p) => h('div', { class: 'card prop' },
      h('div', { class: 'wi-title' }, p.title),
      h('div', { class: 'muted small' }, `${p.type}${p.tags && p.tags.length ? ` · ${p.tags.join(', ')}` : ''}`),
      p.description ? h('div', { class: 'small clamp' }, p.description) : null,
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => decide(p, 'approve') }, 'Approve'),
        h('button', { onclick: () => decide(p, 'approve', true), title: 'Approve and create a branch in the repo' }, 'Approve + branch'),
        h('button', { onclick: () => decide(p, 'reject') }, 'Reject'))))));
}

function render() {
  if (!board) return;
  const vis = visibleItems();
  const tags = [...new Set([...items.values()].flatMap((it) => it.tags))].sort();
  const liveLabel = {
    live: board.live.enabled ? 'Live' : 'Live (team moves only — ADO edits refresh every 30 s)',
    connecting: 'Connecting…', offline: 'Offline — retrying', error: 'Live updates unavailable',
  }[liveStatus] || liveStatus;

  const addInput = h('input', { type: 'text', placeholder: `New ${board.workItemType}…`, maxlength: '255' });
  mount(root,
    h('div', { class: 'row between' },
      h('h1', {}, `${ctx.project.name} · ${board.workItemType} board`),
      h('div', { class: 'row' },
        presenceBar(presence),
        h('span', { class: `live-dot ${liveStatus}`, title: liveLabel }), h('span', { class: 'muted small' }, liveLabel),
        h('button', { onclick: load, title: 'Reload from Azure DevOps' }, 'Refresh'))),
    banner ? h('div', { class: `banner ${banner.kind}` }, banner.text,
      h('button', { class: 'link', onclick: () => { banner = null; render(); } }, '×')) : null,
    board.warnings.length ? h('div', { class: 'banner warn' }, h('ul', {}, board.warnings.map((w) => h('li', {}, w)))) : null,
    board.truncated ? h('div', { class: 'banner warn' }, 'Showing the 500 most recently changed items. Narrow the board with board.areaPath.') : null,
    h('div', { class: 'row toolbar' },
      h('input', { type: 'search', placeholder: 'Filter by text, #id or tag', value: filters.text,
        oninput: (e) => { filters.text = e.target.value; renderSoon(); } }),
      h('select', { onchange: (e) => { filters.assignee = e.target.value; render(); } },
        h('option', { value: '' }, 'All people'),
        h('option', { value: UNASSIGNED, selected: filters.assignee === UNASSIGNED }, 'Unassigned'),
        board.members.map((m) => h('option', { value: m.uniqueName, selected: filters.assignee === m.uniqueName }, m.displayName))),
      h('select', { onchange: (e) => { filters.tag = e.target.value; render(); } },
        h('option', { value: '' }, 'All tags'),
        tags.map((t) => h('option', { value: t, selected: filters.tag === t }, t))),
      h('form', { class: 'row grow', onsubmit: (e) => { e.preventDefault(); const t = addInput.value.trim(); if (t) { addInput.value = ''; quickAdd(t); } } },
        addInput, h('button', { type: 'submit', class: 'primary' }, 'Add'))),
    proposalsLane(),
    lanes(vis),
    h('div', { class: 'muted small' }, `${vis.length} of ${items.size} items shown`));
  // keep focus in the filter box while typing
  if (renderSoon.focus) {
    const el = root.querySelector('input[type=search]');
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    renderSoon.focus = false;
  }
}

let renderTimer;
function renderSoon() {
  clearTimeout(renderTimer);
  renderSoon.focus = true;
  renderTimer = setTimeout(render, 120);
}

async function load() {
  board = await api(ctx, 'GET', `/projects/${ctx.project.id}/board`);
  items.clear();
  for (const it of board.items) items.set(it.id, it);
  render();
}

function wireLive() {
  const socket = connectLive(ctx, 'board', {
    onStatus: (s, ack) => {
      liveStatus = s;
      if (ack && ack.presence) presence = ack.presence;
      render();
      if (s === 'live') load().catch(() => {}); // catch up after (re)connect
    },
  });
  socket.on('presence', (list) => { presence = list; render(); });
  socket.on('workitem:updated', ({ item }) => { upsert(item); render(); });
  socket.on('workitem:created', ({ item }) => { upsert(item); render(); });
  socket.on('workitem:changed', ({ id, eventType }) => {
    if (eventType === 'workitem.deleted') { items.delete(id); render(); } else refreshItem(id);
  });
  socket.on('proposal:created', (p) => {
    if (p.status === 'proposed' && !board.proposals.some((x) => x.id === p.id)) { board.proposals.push(p); render(); }
  });
  socket.on('proposal:updated', (p) => {
    board.proposals = board.proposals.filter((x) => x.id !== p.id || p.status === 'proposed');
    render();
  });
  // Without service hooks, edits made in native ADO only show up by polling.
  setInterval(() => {
    if (board && !board.live.enabled && document.visibilityState === 'visible') load().catch(() => {});
  }, POLL_MS);
}

(async () => {
  try {
    ctx = await initPage();
    if (!ctx.project) throw new Error('Open this hub from a project.');
    await load();
    wireLive();
    await ctx.SDK.notifyLoadSucceeded();
  } catch (err) {
    showFatal(root, err);
    if (ctx) await ctx.SDK.notifyLoadSucceeded();
  }
})();
