'use strict';

// ---------- state ----------
let me = null;
let currentEvent = null;
let currentProject = null;

// ---------- helpers ----------
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    window.location.href = '/';
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.json();
}

function el(id) { return document.getElementById(id); }
function show(id) { el(id).hidden = false; }
function hide(id) { el(id).hidden = true; }
function showOnly(...ids) {
  ['view-events', 'view-event', 'view-project'].forEach((v) =>
    ids.includes(v) ? show(v) : hide(v)
  );
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function showError(form, message) {
  const box = form.querySelector('.form-error');
  box.textContent = message;
  box.hidden = false;
}
function clearError(form) {
  const box = form.querySelector('.form-error');
  box.hidden = true;
  box.textContent = '';
}

// ---------- header ----------
async function loadMe() {
  me = await api('GET', '/api/me');
  el('name').textContent = me.name || me.email;
  el('email').textContent = me.email;
  const avatar = el('avatar');
  if (me.avatar_url) avatar.src = me.avatar_url;
  else avatar.style.display = 'none';
}

// ---------- events view ----------
async function loadEvents() {
  showOnly('view-events');
  const events = await api('GET', '/api/events');
  const list = el('events-list');
  list.innerHTML = '';
  el('events-empty').hidden = events.length > 0;
  for (const e of events) {
    const card = document.createElement('div');
    card.className = 'card hover';
    card.innerHTML = `
      <div class="card-title">${escapeHtml(e.name)}</div>
      <div class="card-desc">${escapeHtml(e.description || '')}</div>
      <div class="card-meta mono">created ${new Date(e.created_at).toLocaleDateString()}</div>
    `;
    card.addEventListener('click', () => openEvent(e));
    list.appendChild(card);
  }
}

el('btn-new-event').addEventListener('click', () => {
  clearError(el('form-event'));
  el('form-event').reset();
  show('form-event');
});
el('cancel-event').addEventListener('click', () => hide('form-event'));
el('form-event').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  clearError(form);
  const fd = new FormData(form);
  try {
    await api('POST', '/api/events', {
      name: fd.get('name'),
      description: fd.get('description'),
    });
    hide('form-event');
    await loadEvents();
  } catch (err) {
    showError(form, err.message);
  }
});

// ---------- event drill-down ----------
async function openEvent(event) {
  currentEvent = event;
  showOnly('view-event');
  el('event-name').textContent = event.name;
  el('event-description').textContent = event.description || '';
  await loadProjects();
}

async function loadProjects() {
  const projects = await api('GET', `/api/events/${currentEvent.id}/projects`);
  const list = el('projects-list');
  list.innerHTML = '';
  el('projects-empty').hidden = projects.length > 0;
  for (const p of projects) {
    const card = document.createElement('div');
    card.className = 'card hover';
    card.innerHTML = `
      <div class="card-title">${escapeHtml(p.name)}</div>
      <div class="card-desc">${escapeHtml(p.description || '')}</div>
      <div class="card-meta mono">
        ${p.my_role ? `role: <span class="role-${p.my_role}">${p.my_role}</span>` : 'no role'}
      </div>
    `;
    card.addEventListener('click', () => openProject(p));
    list.appendChild(card);
  }
}

el('back-to-events').addEventListener('click', loadEvents);
el('btn-new-project').addEventListener('click', () => {
  clearError(el('form-project'));
  el('form-project').reset();
  show('form-project');
});
el('cancel-project').addEventListener('click', () => hide('form-project'));
el('form-project').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  clearError(form);
  const fd = new FormData(form);
  try {
    await api('POST', `/api/events/${currentEvent.id}/projects`, {
      name: fd.get('name'),
      description: fd.get('description'),
    });
    hide('form-project');
    await loadProjects();
  } catch (err) {
    showError(form, err.message);
  }
});

// ---------- project drill-down ----------
async function openProject(project) {
  currentProject = project;
  showOnly('view-project');
  el('project-name').textContent = project.name;
  el('project-description').textContent = project.description || '';
  await loadMembers();
}

async function loadMembers() {
  const members = await api('GET', `/api/projects/${currentProject.id}/members`);
  const myMembership = members.find((m) => m.user_id === me.id);
  const myRole = myMembership ? myMembership.role : null;
  el('my-role').textContent = myRole ? `your role: ${myRole}` : '';
  el('my-role').className = `role-badge role-${myRole || 'none'}`;

  const list = el('members-list');
  list.innerHTML = '';
  for (const m of members) {
    const row = document.createElement('div');
    row.className = 'member';
    row.innerHTML = `
      <img class="m-avatar" src="${escapeHtml(m.avatar_url || '')}" alt="" onerror="this.style.visibility='hidden'" />
      <div class="m-meta">
        <div class="m-name">${escapeHtml(m.name || m.email)}</div>
        <div class="m-email mono">${escapeHtml(m.email)}</div>
      </div>
      <div class="m-role role-${m.role}">${m.role}</div>
    `;
    list.appendChild(row);
  }

  if (myRole === 'owner') show('form-member');
  else hide('form-member');
}

el('back-to-event').addEventListener('click', () => openEvent(currentEvent));

let userSearchTimer = null;
el('user-search') && el('user-search').addEventListener('input', (ev) => {
  clearTimeout(userSearchTimer);
  const q = ev.target.value.trim();
  userSearchTimer = setTimeout(() => renderUserPicker(q), 200);
});

async function renderUserPicker(q) {
  const results = el('user-results');
  results.innerHTML = '';
  if (!q) return;
  const users = await api('GET', '/api/users?q=' + encodeURIComponent(q));
  for (const u of users) {
    if (u.id === me.id) continue;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'user-result';
    row.innerHTML = `
      <div class="m-name">${escapeHtml(u.name || u.email)}</div>
      <div class="m-email mono">${escapeHtml(u.email)}</div>
    `;
    row.addEventListener('click', () => addMember(u.id));
    results.appendChild(row);
  }
}

async function addMember(userId) {
  const form = el('form-member');
  clearError(form);
  const role = form.querySelector('select[name="role"]').value;
  try {
    await api('POST', `/api/projects/${currentProject.id}/members`, { userId, role });
    el('user-search').value = '';
    el('user-results').innerHTML = '';
    await loadMembers();
  } catch (err) {
    showError(form, err.message);
  }
}

// ---------- boot ----------
(async () => {
  try {
    await loadMe();
    await loadEvents();
  } catch (err) {
    console.error(err);
  }
})();

// Realtime — Phase 2 doesn't broadcast yet, but the handshake stays so Phase 3+
// can layer on per-project rooms without touching this file.
const socket = io();
socket.on('connect', () => console.log('realtime connected'));
socket.on('connect_error', (err) => console.warn('realtime error:', err.message));
