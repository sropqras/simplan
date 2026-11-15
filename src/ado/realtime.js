'use strict';

// Socket.IO namespace `/ado` for the Azure DevOps extension.
//
// Handshake: io(url + '/ado', { auth: { appToken, accessToken, org } }) — same checks as
// requireAdoUser. A socket joins a project room only after ADO confirms the user can
// see the project. Rooms: `ado:<org>:<projectId>` (org lower-cased).
// The REST handlers are the source of truth; they call broadcast() after each change.

const { resolveAdoUser, loadAdoProject } = require('./auth');

let nsp = null;

function roomName(org, projectId) {
  return `ado:${String(org).toLowerCase()}:${String(projectId).toLowerCase()}`;
}

// Presence: who is currently viewing each project (userId -> { displayName, sockets }).
const presence = new Map();

function presenceList(room) {
  const users = presence.get(room);
  if (!users) return [];
  return [...users.entries()].map(([userId, u]) => ({ userId, displayName: u.displayName, views: [...u.views] }));
}

function addPresence(room, user, view, socketId) {
  if (!presence.has(room)) presence.set(room, new Map());
  const users = presence.get(room);
  const u = users.get(user.userId) || { displayName: user.displayName, sockets: new Map(), views: new Set() };
  u.sockets.set(socketId, view);
  u.views = new Set(u.sockets.values());
  users.set(user.userId, u);
}

function removePresence(room, userId, socketId) {
  const users = presence.get(room);
  const u = users && users.get(userId);
  if (!u) return;
  u.sockets.delete(socketId);
  if (!u.sockets.size) users.delete(userId);
  else u.views = new Set(u.sockets.values());
  if (!users.size) presence.delete(room);
}

function initAdoRealtime(io) {
  nsp = io.of('/ado');

  nsp.use(async (socket, next) => {
    try {
      const a = socket.handshake.auth || {};
      socket.data.ado = await resolveAdoUser({ appToken: a.appToken, accessToken: a.accessToken, org: a.org });
      return next();
    } catch (err) {
      return next(new Error(err.expose ? err.message : 'unauthorized'));
    }
  });

  nsp.on('connection', (socket) => {
    const ado = socket.data.ado;
    const joined = new Set();

    // join: { projectId, view: 'board'|'chat'|... }  ack: { ok, error?, presence? }
    socket.on('join', async (msg, ack = () => {}) => {
      try {
        const projectId = msg && msg.projectId;
        const project = await loadAdoProject(ado, projectId);
        const room = roomName(ado.org, project.id);
        await socket.join(room);
        joined.add(room);
        addPresence(room, ado, String((msg && msg.view) || 'board').slice(0, 20), socket.id);
        nsp.to(room).emit('presence', presenceList(room));
        ack({ ok: true, presence: presenceList(room) });
      } catch (err) {
        ack({ ok: false, error: err.expose ? err.message : 'join failed' });
      }
    });

    socket.on('disconnect', () => {
      for (const room of joined) {
        removePresence(room, ado.userId, socket.id);
        nsp.to(room).emit('presence', presenceList(room));
      }
    });
  });

  return nsp;
}

function broadcast(org, projectId, event, payload) {
  if (nsp) nsp.to(roomName(org, projectId)).emit(event, payload);
}

module.exports = { initAdoRealtime, broadcast, roomName };
