# Real-time Tasks

A real-time event/task management platform. Each **event** contains **projects** (sub-teams), each with its own live **Kanban board** and **chat room**. Discussions can be summarized by AI into proposed tasks that board owners approve. Access is via Google sign-in.

**Stack:** Node + Express + Socket.IO + PostgreSQL + Passport (Google OAuth) + Postgres-backed sessions.

> **This is Phase 1** — the foundation: server, full database schema, Google login, sessions, and an authenticated realtime handshake. Events, Kanban, chat, AI triage, and notifications come in later phases.

---

## Phase roadmap

1. **Foundation + Google auth** ← you are here
2. Events, projects, memberships, board-owner role
3. Live Kanban board (new → in progress → handover → complete)
4. Project chat rooms
5. AI task triage (chat → proposed task → owner approval)
6. Notifications + user management

---

## Prerequisites

- Node.js 18+ (you have 22)
- A PostgreSQL database
- Google OAuth credentials (steps below)

---

## 1. Install

```bash
npm install
```

## 2. Configure

```bash
cp .env.example .env
```

Then edit `.env`. Generate a session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## 3. Set up Google OAuth

1. Go to <https://console.cloud.google.com/apis/credentials>
2. Create an **OAuth client ID** → application type **Web application**
3. Add an **Authorized redirect URI**:
   - Local: `http://localhost:3000/auth/google/callback`
   - Production: `https://tasks.yourdomain.com/auth/google/callback`
4. Copy the **Client ID** and **Client secret** into `.env`
5. On the OAuth consent screen, add the test users (or publish) so your team can sign in

`BASE_URL` in `.env` **must** match the host in your redirect URI.

## 4. Create the database tables

```bash
createdb realtime_tasks        # if it doesn't exist yet
npm run db:init                # applies db/schema.sql
```

## 5. Run

```bash
npm start        # or: npm run dev   (auto-restart on file changes)
```

Open <http://localhost:3000>, click **Continue with Google**, and you'll land on the dashboard.

---

## Deploying to your IONOS VPS

A typical setup:

1. **Install Postgres and Node** on the VPS.
2. Clone the repo, `npm install --omit=dev`, create `.env` with production values
   (`NODE_ENV=production`, `BASE_URL=https://tasks.yourdomain.com`, `DATABASE_SSL` as needed).
3. Run `npm run db:init` once.
4. Keep the process alive with a manager such as **pm2**:
   ```bash
   npm install -g pm2
   pm2 start src/server.js --name realtime-tasks
   pm2 save && pm2 startup
   ```
5. Put **nginx** in front as a reverse proxy with TLS (Let's Encrypt). The app already
   sets `trust proxy`, and cookies become `secure` automatically when `NODE_ENV=production`.

Example nginx location block (needed for WebSockets):

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

---

## Project layout

```
realtime-tasks/
├── db/schema.sql            full data model (events, projects, tasks, messages, …)
├── scripts/init-db.js       applies the schema
├── src/
│   ├── server.js            entry point (express + session + passport + socket.io)
│   ├── config/db.js         postgres pool
│   ├── config/passport.js   google oauth + user upsert
│   ├── middleware/auth.js    route guards
│   ├── routes/auth.js        /auth/google, callback, logout
│   ├── routes/index.js       pages + /api/me
│   └── realtime/socket.js    socket.io wired to the session
├── public/                  css + client js
└── views/                   login.html, dashboard.html
```
