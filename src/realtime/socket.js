'use strict';

const { Server } = require('socket.io');
const { allowedOrigin } = require('../ado/cors');
const { initAdoRealtime } = require('../ado/realtime');

// Wraps Express middleware so Socket.IO can reuse the same session + passport,
// which means a socket already knows *who* is connected. Phase 2+ will use this
// to broadcast live Kanban moves and chat into per-project rooms.
// io.use() below only guards the default namespace (Google/session mode). The Azure
// DevOps extension uses the separate `/ado` namespace with token auth (src/ado/realtime.js).
function initSocket(server, sessionMiddleware, passport, { ado = false } = {}) {
  const io = new Server(server, {
    // Extension pages connect cross-origin from the Marketplace CDN, so their origin is
    // allowed (see ado/cors.js). Requests without an Origin header (same-origin) pass;
    // any other origin gets no CORS headers.
    cors: { origin: (origin, cb) => cb(null, !origin || allowedOrigin(origin)), credentials: false },
  });
  if (ado) initAdoRealtime(io);

  const wrap = (middleware) => (socket, next) =>
    middleware(socket.request, {}, next);

  io.use(wrap(sessionMiddleware));
  io.use(wrap(passport.initialize()));
  io.use(wrap(passport.session()));

  // Only allow authenticated sockets.
  io.use((socket, next) => {
    if (socket.request.user) return next();
    next(new Error('unauthorized'));
  });

  io.on('connection', (socket) => {
    const user = socket.request.user;
    console.log(`socket connected: ${user.email}`);

    socket.on('disconnect', () => {
      console.log(`socket disconnected: ${user.email}`);
    });
  });

  return io;
}

module.exports = { initSocket };
