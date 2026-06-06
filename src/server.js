'use strict';

require('dotenv').config();

const http = require('http');
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const { pool } = require('./config/db');
const passport = require('./config/passport');
const { initSocket } = require('./realtime/socket');

const authRoutes = require('./routes/auth');
const indexRoutes = require('./routes/index');
const eventsRoutes = require('./routes/events');
const projectsRoutes = require('./routes/projects');

// --- Required environment ---
const required = ['DATABASE_URL', 'SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'BASE_URL'];
const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // needed for secure cookies behind a reverse proxy (nginx on the VPS)

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Session backed by Postgres so logins survive restarts and scale across processes.
const sessionMiddleware = session({
  store: new PgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  },
});

app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

app.use('/auth', authRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/', indexRoutes);

// --- HTTP + Socket.IO ---
const server = http.createServer(app);
initSocket(server, sessionMiddleware, passport);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Real-time Tasks running on ${process.env.BASE_URL} (port ${PORT})`);
});
