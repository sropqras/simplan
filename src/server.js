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
const adoRoutes = require('./ado/routes');
const { adoCors } = require('./ado/cors');
const adoHooks = require('./ado/hooks');

// --- Required environment ---
// Two entry points, at least one must be configured:
//   Google mode (standalone web app): GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
//   Azure DevOps extension mode:      ADO_EXTENSION_SECRET
const required = ['DATABASE_URL', 'SESSION_SECRET', 'BASE_URL'];
const missing = required.filter((k) => !process.env[k]);
const googleMode = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const adoMode = Boolean(process.env.ADO_EXTENSION_SECRET);
if (missing.length || (!googleMode && !adoMode)) {
  if (missing.length) console.error(`Missing required environment variables: ${missing.join(', ')}`);
  if (!googleMode && !adoMode) {
    console.error('Configure GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET and/or ADO_EXTENSION_SECRET.');
  }
  console.error('Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // needed for secure cookies behind a reverse proxy (nginx on the VPS)

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Azure DevOps extension mode (bearer tokens, no cookies/session) ---
if (adoMode) {
  // Optional: serve the built extension pages from here (manifest baseUri dev mode).
  app.use('/ado/ext', express.static(path.join(__dirname, '..', 'extension', 'dist')));
  app.use('/ado/hooks', adoHooks); // server-to-server (ADO service hooks), basic auth
  app.use('/ado', adoCors);
  app.use('/ado/api', adoRoutes);
  app.use('/ado', (req, res) => res.status(404).json({ error: 'Not found' }));
}

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

// Unknown API routes -> JSON 404 (instead of Express's HTML page).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler: always JSON for the API, never leak stack traces.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // Postgres: invalid_text_representation (e.g. malformed uuid) -> 400.
  if (err && err.code === '22P02') {
    return res.status(400).json({ error: 'Invalid input' });
  }
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  // err.expose marks messages that are safe to show (http-errors convention).
  const message = err.expose ? err.message : status < 500 ? 'Request error' : 'Internal server error';
  const isApi = /^\/(api|ado)(\/|$)/.test(req.originalUrl);
  if (isApi || req.accepts(['html', 'json']) === 'json') {
    const body = { error: message };
    if (err.expose && Array.isArray(err.errors)) body.details = err.errors;
    return res.status(status).json(body);
  }
  return res.status(status).type('text').send(message);
});

// --- HTTP + Socket.IO ---
const server = http.createServer(app);
initSocket(server, sessionMiddleware, passport, { ado: adoMode });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const modes = [googleMode && 'google', adoMode && 'azure-devops'].filter(Boolean).join(' + ');
  console.log(`Real-time Tasks running on ${process.env.BASE_URL} (port ${PORT}) [${modes}]`);
});
