'use strict';

const { Server } = require('socket.io');

// Wraps Express middleware so Socket.IO can reuse the same session + passport,
// which means a socket already knows *who* is connected. Phase 2+ will use this
// to broadcast live Kanban moves and chat into per-project rooms.
function initSocket(server, sessionMiddleware, passport) {
  const io = new Server(server);

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
