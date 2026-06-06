# CLAUDE.md — agent handover

You are continuing work on **simplan** (real-time event/task management platform, internally
called "Real-time Tasks"). This file is the canonical pickup brief — read it end-to-end
before doing anything else.

---

## 0. Where things stand

| Phase | Scope | Status |
|------|-------|--------|
| 1 | Foundation, Postgres schema, Google OAuth, sessions, Socket.IO handshake | done |
| 2 | Events, projects, memberships, owner/member roles + dashboard UI | done (unverified live) |
| 3 | Live Kanban board (new → in_progress → handover → complete) | **next** |
| 4 | Project chat rooms (real-time) | planned |
| 5 | AI task triage (chat → proposed task → owner approves) | planned |
| 6 | Notifications + user management | planned |

**Important:** Phase 2 was implemented but never live-tested against Postgres / Google OAuth
in the original session (Termux, no DB or OAuth creds). The first task on Mac is to actually
run the stack end-to-end and fix any wiring bugs before starting Phase 3.

---

## 1. Mac pickup — get it running

```bash
git clone https://github.com/sropqras/simplan.git
cd simplan

# Node 18+ required. With nvm:
nvm install 20 && nvm use 20

# Postgres locally (Homebrew):
brew install postgresql@16
brew services start postgresql@16
createdb realtime_tasks

# deps
npm install

# env
cp .env.example .env
# generate a session secret:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
# paste into SESSION_SECRET in .env
# set DATABASE_URL=postgres://$(whoami)@localhost:5432/realtime_tasks
# set DATABASE_SSL=false

# Google OAuth (only you can do this):
#   https://console.cloud.google.com/apis/credentials
#   - Web application
#   - Authorized redirect URI: http://localhost:3000/auth/google/callback
#   - Copy Client ID/Secret into .env
#   - Add yourself as a test user on the consent screen

npm run db:init      # applies db/schema.sql (8 tables)
npm start            # http://localhost:3000
```

Expected boot log: `Real-time Tasks running on http://localhost:3000 (port 3000)`.

**Smoke tests (Phase 1):**
- `GET /` → 200 login page
- `GET /api/me` unauthenticated → 401
- `GET /dashboard` unauthenticated → 302 to `/`
- `GET /auth/google` → 302 to accounts.google.com
- `/socket.io/socket.io.js` → 200

**Smoke tests (Phase 2 — verify these after sign-in):**
1. POST `/api/events` with `{name, description}` → 201, returns event row
2. GET `/api/events` → array including the one you just created
3. POST `/api/events/:id/projects` → 201; that project's row in `memberships` should have role=`owner` and your user_id
4. GET `/api/projects/:id/members` → 200 with your owner row
5. POST `/api/projects/:id/members` as a non-owner user → 403
6. `GET /api/users?q=<prefix>` → 200, used by the add-member picker

---

## 2. Stack — fixed, do not change

- Node.js **CommonJS** (`require`, not ESM)
- Express 4
- Socket.IO 4 (already auth-gated via shared Express session)
- PostgreSQL via `pg` (pool from `src/config/db.js`)
- Passport + `passport-google-oauth20` (upsert-on-login by `google_id`)
- Sessions in Postgres via `connect-pg-simple`

Deployment target is the user's **IONOS VPS** (Node + Postgres on the box, nginx reverse
proxy with TLS, pm2 process manager). The app already sets `trust proxy` and flips cookies
to `secure` when `NODE_ENV=production`.

---

## 3. Conventions — apply to every new file

These are load-bearing. Violating them will create churn.

- **CommonJS only.** `require` / `module.exports`. No ESM, no TypeScript.
- **One `pg` pool**, exported from `src/config/db.js`. Never instantiate another.
- **Parameterized SQL only** (`$1, $2`). Never string-interpolate user input.
- **Trust the session, not the body.** Use `req.user.id` for the *current* user — never
  accept a `userId` claim from the request body for "who am I". Body `userId` is only valid
  when naming a *third party* (e.g. adding someone to a project).
- **API routes** return JSON and use `ensureApiAuth` (returns 401). **HTML routes** use
  `ensureAuthenticated` (redirects to `/`).
- **Project-scoped access** goes through `src/middleware/projectAccess.js`:
  - `requireProjectMember` — any membership row
  - `requireProjectOwner` — role must be `owner`
  Both read `req.params.projectId` and attach `req.membership = { projectId, role }`.
- **Multi-step writes** (e.g. insert project + insert membership) must be wrapped in a
  transaction via `pool.connect()` + `BEGIN/COMMIT/ROLLBACK`. See
  `src/routes/events.js` `POST /:eventId/projects` for the pattern.
- **Realtime broadcasts** go through per-project Socket.IO rooms named
  `project:<projectId>`. The socket already knows the user via the shared session
  (`socket.request.user`). When you wire Phase 3/4, on join verify membership against the
  DB, then `socket.join('project:' + projectId)` and emit to that room only.

---

## 4. File map

```
db/schema.sql                     full data model for ALL phases (already applied)
scripts/init-db.js                npm run db:init -> applies schema.sql

src/server.js                     express + session + passport + socket.io entry
src/config/db.js                  the one pg Pool
src/config/passport.js            Google OAuth strategy + user upsert

src/middleware/auth.js            ensureAuthenticated / ensureApiAuth
src/middleware/projectAccess.js   requireProjectMember / requireProjectOwner  [Phase 2]

src/routes/auth.js                /auth/google, callback, POST /auth/logout
src/routes/index.js               /, /dashboard, /api/me, /api/users?q=
src/routes/events.js              /api/events*, /api/events/:id/projects     [Phase 2]
src/routes/projects.js            /api/projects/:id/members                  [Phase 2]

src/realtime/socket.js            io server sharing the express session

public/css/styles.css             dark "ops command center" theme + Phase 2 styles
public/js/dashboard.js            SPA-ish dashboard: events <-> event <-> project views
views/login.html                  Google sign-in page
views/dashboard.html              authed shell with 3 sections (events/event/project)
```

---

## 5. Data model (already in db/schema.sql — do not duplicate)

| Table | Purpose |
|---|---|
| `users` | google_id, email, name, avatar_url, last_seen |
| `events` | top-level instances; `created_by` |
| `projects` | belong to an event; each is a chat room + Kanban board |
| `memberships` | user ↔ project, role enum `owner \| member`, UNIQUE(user, project) |
| `tasks` | project, title, description, `status` (`new\|in_progress\|handover\|complete`), `approval_status` (`proposed\|approved\|rejected`), owner_id, assignee_id, source jsonb |
| `messages` | project chat |
| `notifications` | user, type, payload jsonb, read |
| `session` | connect-pg-simple |

UUID PKs via `gen_random_uuid()` (pgcrypto extension already enabled).

---

## 6. Phase 2 implementation notes (what's in this commit)

### REST surface added

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/events` | signed in | body `{name, description}` |
| GET | `/api/events` | signed in | events the user created OR is a project-member of |
| POST | `/api/events/:eventId/projects` | accessible event | body `{name, description}`; **transaction** also inserts `memberships` row with role=owner for the creator |
| GET | `/api/events/:eventId/projects` | accessible event | only projects the caller is a member of (or created themselves) |
| GET | `/api/projects/:projectId/members` | project member | joined with `users` for name/email/avatar |
| POST | `/api/projects/:projectId/members` | project **owner** | body `{userId, role}`; upserts on `(user_id, project_id)` |
| GET | `/api/users?q=` | signed in | minimal user directory for the add-member picker — id/email/name/avatar, max 50 rows |

"Accessible event" = caller is `events.created_by` OR has any project membership in that event.
Helper: `loadAccessibleEvent(eventId, userId)` in `src/routes/events.js`.

### Design choices worth knowing

- **`GET /api/users` was not in the original spec.** Added because the add-member picker
  needs to resolve names → UUIDs. Returns only the four fields the picker shows. Reconsider
  if this app ever opens to untrusted users — current model is "any signed-in account can see
  the user directory".
- **Project list under an event includes projects the caller created but never joined**, so
  an event creator who only sets up the structure isn't orphaned out of their own event.
- **Owner-role grant via membership upsert.** POST `/members` uses
  `ON CONFLICT (user_id, project_id) DO UPDATE SET role = EXCLUDED.role`, so adding an
  existing member with a new role acts as a role change. That doubles as the
  "promote/demote" flow until Phase 6 adds explicit user management.
- **Atomic project creation.** Phase 2 uses `pool.connect()` + explicit
  `BEGIN/COMMIT/ROLLBACK` so we never end up with a project row whose creator isn't an
  owner. Reuse this pattern in Phase 3 if task creation ever needs side effects (e.g.
  notification rows).

### Dashboard UI

`views/dashboard.html` is now three sections, swapped by `public/js/dashboard.js`:

1. **events list** with a "New event" form
2. **event drill-down** (projects in the event + "New project" form)
3. **project drill-down** (members list + owner-only "Add member" picker)

The realtime socket connection still opens on boot but doesn't broadcast yet — Phase 3+ will
hook into the existing socket.

---

## 7. Phase 3 — your job next

Goal: a per-project Kanban board that updates in real time across connected sockets.

### Backend

- `GET /api/projects/:projectId/tasks` — list tasks in the project (any member).
- `POST /api/projects/:projectId/tasks` — create task (any member). Body
  `{title, description, assignee_id?}`. Defaults: `status='new'`, `approval_status='approved'`
  (only AI-proposed tasks need approval).
- `PATCH /api/projects/:projectId/tasks/:taskId` — update title/description/status/assignee.
  Any member can move tasks across columns; only owner or task owner can delete.
- `DELETE /api/projects/:projectId/tasks/:taskId` — owner-only.
- Add `requireProjectMember` / `requireProjectOwner` to every route.

### Realtime

In `src/realtime/socket.js`, on connection:
- Accept a `join` event with a `projectId`. Verify membership against `memberships` table.
  On success: `socket.join('project:' + projectId)`.
- After a successful task mutation in the REST handler, `io.to('project:'+projectId).emit('task:created'|'task:updated'|'task:deleted', task)`.
- The REST handler is the source of truth; the socket emit is just the broadcast.

### Frontend

Add a fourth view (`view-board`) opened by clicking a project card. Four columns mapping
to the `task_status` enum. Drag-and-drop OR simple "move" buttons — pick the lighter option
first; drag-and-drop can come in a polish pass.

### Acceptance

- Two browsers signed in as members of the same project see each other's task moves within
  ~250 ms (the socket roundtrip).
- A non-member's socket cannot join `project:<id>` (server rejects the join).
- Tasks created without going through AI default to `approval_status='approved'` and show
  on the board immediately. (Phase 5 will add a `proposed` lane.)

---

## 8. Known caveats / unverified

- `node_modules` is gitignored. First step on Mac is `npm install`.
- Phase 2 was not live-tested in the original session (no DB / no OAuth in Termux). Run the
  smoke tests in section 1 before extending.
- The user's primary domain for production is `https://tasks.yourdomain.com` (placeholder
  in README) — swap when actually deploying.
- The existing `~/repos/sropqras/` Termux folder is a parent dir with many unrelated repos;
  only `simplan/` (this repo) is relevant to this project.

---

## 9. First prompt to give Claude on Mac

> "Read CLAUDE.md. Run the Phase 1 + Phase 2 smoke tests in section 1 and report which pass.
> Fix anything broken in Phase 2 before starting Phase 3. Then implement Phase 3 per
> section 7. Follow the conventions in section 3 and keep Phase 1/2 intact."
