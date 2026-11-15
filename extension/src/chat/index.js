// simplan Chat hub — project chat with @ai (Azure AI Foundry) and "Turn into tickets".

import {
  initPage, api, h, mount, showFatal, connectLive, openWorkItem, presenceBar, hostQueryParams, timeAgo,
} from '../common/backend';

const root = document.getElementById('root');

let ctx;
let messages = [];
const selected = new Set();
let proposals = [];
let presence = [];
let liveStatus = 'connecting';
let banner = null;
let busy = false;
let draft = '';
let createBranch = false;
let hasMore = true;

function flash(kind, text) {
  banner = { kind, text };
  render();
}

function addMessage(m) {
  if (messages.some((x) => x.id === m.id)) return;
  messages.push(m);
  messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

// Linkify #123 to open work items; everything else is plain text (no HTML from users/AI).
function bodyNodes(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(/#(\d{1,9})\b/g)) {
    out.push(text.slice(last, m.index));
    const id = Number(m[1]);
    out.push(h('button', { class: 'link', onclick: () => openWorkItem(id) }, m[0]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

async function send() {
  const body = draft.trim();
  if (!body || busy) return;
  busy = true;
  render();
  try {
    const m = await api(ctx, 'POST', `/projects/${ctx.project.id}/messages`, { body });
    addMessage(m);
    draft = '';
    if (m.aiRequested) flash('ok', 'Asked the AI — the answer will appear here.');
  } catch (err) {
    flash('error', err.message);
  }
  busy = false;
  render(true);
}

async function toTickets() {
  busy = true;
  flash('ok', 'Asking the AI to draft tickets…');
  try {
    const body = selected.size ? { messageIds: [...selected] } : { last: 20 };
    const r = await api(ctx, 'POST', `/projects/${ctx.project.id}/proposals`, body);
    selected.clear();
    for (const p of r.proposals) if (p.status === 'proposed' && !proposals.some((x) => x.id === p.id)) proposals.push(p);
    flash('ok', r.proposals.length
      ? (r.autoApproved ? `Created ${r.proposals.length} work item(s).` : `${r.proposals.length} proposal(s) ready for approval.`)
      : 'The AI found no concrete work in those messages.');
  } catch (err) {
    flash('error', err.message);
  }
  busy = false;
  render();
}

async function decide(p, action) {
  try {
    const r = await api(ctx, 'POST', `/projects/${ctx.project.id}/proposals/${p.id}/${action}`,
      action === 'approve' ? { createBranch } : undefined);
    proposals = proposals.filter((x) => x.id !== p.id);
    if (action === 'approve') {
      flash(r.branchError ? 'warn' : 'ok', `Created #${r.item.id} ${r.item.title}${r.branch ? ` · branch ${r.branch.name}` : ''}${r.branchError ? ` · branch failed: ${r.branchError}` : ''}`);
    } else flash('ok', 'Rejected.');
  } catch (err) {
    flash('error', err.message);
  }
}

async function loadOlder() {
  if (!messages.length) return;
  const older = await api(ctx, 'GET', `/projects/${ctx.project.id}/messages?before=${encodeURIComponent(messages[0].createdAt)}&limit=50`);
  hasMore = older.length === 50;
  older.forEach(addMessage);
  render();
}

function render(scrollToEnd = false) {
  const active = document.activeElement;
  const typing = active && active.matches && active.matches('.composer textarea')
    ? { start: active.selectionStart, end: active.selectionEnd } : null;
  const list = root.querySelector('.messages');
  const nearBottom = !list || list.scrollHeight - list.scrollTop - list.clientHeight < 80;

  const composer = h('textarea', {
    rows: 3, maxlength: '4000', placeholder: 'Message the team. Mention @ai to ask the assistant. Use #123 for work items.',
    value: draft, disabled: busy,
    oninput: (e) => { draft = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); draft = e.target.value; send(); } },
  });

  mount(root,
    h('div', { class: 'row between' },
      h('h1', {}, `${ctx.project.name} · chat`),
      h('div', { class: 'row' }, presenceBar(presence),
        h('span', { class: `live-dot ${liveStatus}` }), h('span', { class: 'muted small' }, liveStatus === 'live' ? 'Live' : liveStatus))),
    banner ? h('div', { class: `banner ${banner.kind}` }, banner.text,
      h('button', { class: 'link', onclick: () => { banner = null; render(); } }, '×')) : null,
    h('div', { class: 'chat-layout' },
      h('div', { class: 'chat-main' },
        h('div', { class: 'messages' },
          hasMore && messages.length >= 50 ? h('button', { class: 'link', onclick: loadOlder }, 'Load older messages') : null,
          messages.length ? null : h('div', { class: 'muted' }, 'No messages yet.'),
          messages.map((m) => h('div', { class: `msg ${m.kind}${selected.has(m.id) ? ' selected' : ''}` },
            m.kind === 'system' ? null : h('input', {
              type: 'checkbox', checked: selected.has(m.id), title: 'Select for "Turn into tickets"',
              onchange: (e) => { if (e.target.checked) selected.add(m.id); else selected.delete(m.id); render(); },
            }),
            h('div', {},
              h('div', { class: 'msg-head' }, h('strong', {}, m.authorName), h('span', { class: 'muted small' }, timeAgo(m.createdAt))),
              h('div', { class: 'msg-body' }, bodyNodes(m.body)))))),
        h('div', { class: 'composer' }, composer,
          h('div', { class: 'row' },
            h('button', { class: 'primary', disabled: busy, onclick: () => { draft = composer.value; send(); } }, 'Send'),
            h('button', { disabled: busy, onclick: toTickets,
              title: selected.size ? 'Draft tickets from the selected messages' : 'Draft tickets from the last 20 messages' },
            selected.size ? `Turn ${selected.size} selected into tickets` : 'Turn recent chat into tickets'),
            selected.size ? h('button', { class: 'link', onclick: () => { selected.clear(); render(); } }, 'clear selection') : null))),
      h('aside', { class: 'chat-side' },
        h('h2', {}, `Proposed tickets · ${proposals.length}`),
        h('label', { class: 'small row' }, h('input', { type: 'checkbox', checked: createBranch, style: 'width:auto',
          onchange: (e) => { createBranch = e.target.checked; } }), 'Create a branch when approving'),
        proposals.length ? null : h('div', { class: 'muted small' }, 'Nothing waiting for approval.'),
        proposals.map((p) => h('div', { class: 'card prop' },
          h('div', { class: 'wi-title' }, p.title),
          h('div', { class: 'muted small' }, p.type),
          h('div', { class: 'small clamp' }, p.description),
          p.acceptanceCriteria && p.acceptanceCriteria.length
            ? h('ul', { class: 'small' }, p.acceptanceCriteria.map((a) => h('li', {}, a))) : null,
          p.suggestedFiles && p.suggestedFiles.length
            ? h('div', { class: 'small mono' }, p.suggestedFiles.join(', ')) : null,
          h('div', { class: 'row' },
            h('button', { class: 'primary', onclick: () => decide(p, 'approve') }, 'Approve'),
            h('button', { onclick: () => decide(p, 'reject') }, 'Reject')))))));

  const newList = root.querySelector('.messages');
  if (newList && (scrollToEnd || nearBottom)) newList.scrollTop = newList.scrollHeight;
  const ta = root.querySelector('.composer textarea');
  if (scrollToEnd) ta.focus();
  else if (typing) { ta.focus(); ta.setSelectionRange(typing.start, typing.end); }
}

(async () => {
  try {
    ctx = await initPage();
    if (!ctx.project) throw new Error('Open this hub from a project.');
    const [msgs, props, params] = await Promise.all([
      api(ctx, 'GET', `/projects/${ctx.project.id}/messages?limit=50`),
      api(ctx, 'GET', `/projects/${ctx.project.id}/proposals?status=proposed`),
      hostQueryParams(),
    ]);
    messages = msgs;
    hasMore = msgs.length === 50;
    proposals = props.reverse();
    if (params.ask && /^\d+$/.test(params.ask)) draft = `@ai about #${params.ask}: `;
    render(true);

    const socket = connectLive(ctx, 'chat', {
      onStatus: (s, ack) => { liveStatus = s; if (ack && ack.presence) presence = ack.presence; render(); },
    });
    socket.on('presence', (list) => { presence = list; render(); });
    socket.on('chat:message', (m) => { addMessage(m); render(); });
    socket.on('proposal:created', (p) => { if (!proposals.some((x) => x.id === p.id)) proposals.push(p); render(); });
    socket.on('proposal:updated', (p) => { proposals = proposals.filter((x) => x.id !== p.id || p.status === 'proposed'); render(); });
    await ctx.SDK.notifyLoadSucceeded();
  } catch (err) {
    showFatal(root, err);
    if (ctx) await ctx.SDK.notifyLoadSucceeded();
  }
})();
