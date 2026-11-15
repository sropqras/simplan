# simplan for Azure DevOps — runbook

simplan runs as a **private Azure DevOps extension**. Tickets are real ADO work items; simplan's backend
(Express + Socket.IO on Azure App Service) keeps only tool state — settings, project chat, AI proposals,
service-hook ids — and calls **Azure AI Foundry** for chat answers, ticket proposals and summaries.
Everything AI-related reads the project's **configured Git repo**, limited to an allow-list of paths.

## Status (2026-11-15)

| Milestone | Scope | Status |
|---|---|---|
| 0 | Azure + Marketplace prerequisites | **to do (account owner)** |
| 1 | Extension skeleton + auth bridge (app token ↔ access token) | done |
| 2 | Config: `.simplan.yml` + settings page + commit-to-repo PR | done |
| 3 | Enhanced board: states as columns, drag-drop, swimlanes, filters, quick add, presence, live updates | done |
| 4 | Project chat + `/ado` Socket.IO namespace + `@ai` answers with repo context | done |
| 5 | AI tickets: chat → proposals (structured output) → approve → work item | done |
| 6 | Code links: create branch + artifact link, PR status, chat origin, AI summary on the work item form | done |
| 7 | CI (tests + package), release workflow (App Service deploy + private publish) | done (workflows not yet run on GitHub) |

"Done" = implemented and tested against a fake Azure DevOps + fake Foundry (see Tests). **Nothing has run in a
real organization yet** — see "First run in a real org" at the end.

## What users get

| Where | Contribution | What it does |
|---|---|---|
| Boards → **simplan Board** | hub | Columns = states of `board.workItemType`; drag-drop or the per-card "move" menu; optional assignee swimlanes (dropping into a lane reassigns); filters (text/#id, person, tag); quick add; **AI proposed** lane with Approve / Approve + branch / Reject; presence avatars; live updates |
| Boards → **simplan Chat** | hub | Project chat; `@ai` asks Foundry (reads allowed repo files, knows `#123` work items mentioned); select messages → **Turn into tickets**; proposals sidebar with approve/reject |
| Work item form → **simplan** group | form group | Linked branches and PRs (with status), originating chat messages, **Create branch**, **AI summary** |
| Work item menu → **Ask simplan AI** | action | Opens simplan Chat prefilled with `@ai about #<id>: ` |
| Project settings → **simplan** | admin hub | All settings with their source (default/repo/tool), reset, **Commit to repo…** (PR), **Live board updates** on/off |

## How auth works (no cookies in ADO mode)

Every extension request to `/ado/api/*` and the `/ado` Socket.IO handshake carries:

| Value | From | Used for |
|---|---|---|
| app token (`Authorization: Bearer`) | `SDK.getAppToken()` | proves the call comes from our extension; HS256 JWT signed with the extension secret; `nameid` = ADO user id |
| access token (`X-ADO-Token`) | `SDK.getAccessToken()` | backend calls ADO REST **as that user** — ADO enforces their permissions; never stored |
| organization (`X-ADO-Org`) | `SDK.getHost().name` | validated `[A-Za-z0-9-]`, it becomes part of the URL |

`src/ado/auth.js` verifies the app token and requires `_apis/connectionData` (called with the access token)
to return the same user (cached 5 min). Project routes and socket `join` call `_apis/projects/{id}` as the user
(404 if they can't see it). Admin-only actions (settings writes, live updates, and approvals when
`ai.approvers: admins`) need "Edit project-level information" (Project Administrators), checked with the
Permissions API. Work item edits are additionally checked to belong to the URL's project.

## Configuration

Effective value per key = built-in default ← `.simplan.yml` on the repo's default branch ← overrides saved in
**Project settings → simplan** (`ado_projects.settings`). Invalid keys in the repo file are ignored and listed
on the settings page.

```yaml
# .simplan.yml
repo: Shop                     # which repo, if the project has several (default: repo named like the project)
board:
  workItemType: User Story
  columns: [New, Active, Resolved, Closed]   # default: all states except "Removed"
  swimlanes: assignee          # none | assignee
  areaPath: Shop\Web
ai:
  deployment: gpt-4.1          # Foundry deployment; default FOUNDRY_DEPLOYMENT
  systemPrompt: Write acceptance criteria as a checklist.
  defaultType: Task
  contextPaths: [README.md, docs/**, src/**]  # the ONLY repo paths the AI may read
  requireApproval: true        # false = proposals become work items immediately
  approvers: admins            # admins | members
tickets:
  branchPattern: feature/{id}-{slug}   # {id} {slug} {type}
  defaultTags: [simplan]
```

Never sent to the model even if allowed by a glob: `.env*`, `*.pem`, `*.key`, `id_rsa*`, anything with
"secret" in the path, `node_modules/`, `.git/`, binaries. Per AI call: ≤ 300 listed paths, ≤ 8 file reads,
≤ 12k chars per file, ≤ 60k chars total.

## Backend API (`/ado/api`, all behind the auth above)

| Method | Path | Notes |
|---|---|---|
| GET | `/whoami` | |
| GET / PUT | `/projects/:projectId/config` | PUT admin-only; body `{ overrides: { key: value \| null } }` |
| POST | `/projects/:projectId/config/commit` | admin; PR writing `.simplan.yml` |
| GET | `/projects/:projectId/board` | columns, items (≤ 500), members, pending proposals, live status, warnings |
| GET / PATCH | `/projects/:projectId/workitems/:id` | PATCH `{ state?, title?, assignedTo?, rev? }`; stale `rev` → 409 |
| POST | `/projects/:projectId/workitems` | quick add `{ title, description?, state? }` |
| GET / POST / DELETE | `/projects/:projectId/live` | service-hook live updates; POST/DELETE admin |
| GET / POST | `/projects/:projectId/messages` | chat; message with `@ai` triggers an async AI answer |
| GET / POST | `/projects/:projectId/proposals` | POST `{ messageIds? \| last? }` → AI proposals |
| POST | `/projects/:projectId/proposals/:id/approve` | `{ edits?, createBranch? }`; row-locked, one work item per proposal |
| POST | `/projects/:projectId/proposals/:id/reject` | |
| POST | `/projects/:projectId/workitems/:id/branch` | `{ name? }` default from `tickets.branchPattern` |
| GET | `/projects/:projectId/workitems/:id/code` | branches, PRs + status, commit count, chat origin |
| POST | `/projects/:projectId/workitems/:id/summary` | AI summary |
| POST | `/ado/hooks/workitems?org=&project=` | service-hook receiver, Basic auth `simplan:<per-project HMAC>` |

Socket.IO namespace `/ado` (room per project): `presence`, `workitem:updated|created|changed`,
`chat:message`, `proposal:created|updated`. Events are notifications; the REST API is the source of truth.
Service-hook pings only carry the item id — clients re-fetch it with their own token.

## Milestone 0 — prerequisites (account owner)

1. **Marketplace publisher** at https://marketplace.visualstudio.com/manage. Put its id in
   `extension/vss-extension.json` (`publisher`) or the `ADO_PUBLISHER` repo variable.
2. **Dev ADO org** + a test project with a Git repo.
3. **Azure** (one resource group):
   - **Foundry** resource + a chat model deployment that supports tool calling (structured outputs preferred;
     simplan falls back to JSON mode if the deployment rejects `json_schema`).
   - **Azure Database for PostgreSQL Flexible Server**, database `realtime_tasks`.
   - **App Service** (Linux, **Node 22**): WebSockets **On**, ARR affinity **On**, **one instance**
     (Socket.IO rooms and the AI throttle are in-process; scale-out needs a Redis adapter / Web PubSub).
     Startup command `npm run start:azure` (applies the idempotent schema, then starts).
     System-assigned **managed identity** with **Cognitive Services OpenAI User** on the Foundry resource.
4. App settings: `DATABASE_URL`, `DATABASE_SSL=true`, `SESSION_SECRET`, `BASE_URL=https://<app>.azurewebsites.net`,
   `ADO_EXTENSION_SECRET` (after the first publish), `ADO_HOOK_SECRET` (random), `FOUNDRY_ENDPOINT`,
   `FOUNDRY_DEPLOYMENT`, `NODE_ENV=production`. Leave Google settings empty for an ADO-only deployment.

## Build, package, publish

Automated: `.github/workflows/release.yml` (tag `vX.Y.Z` or manual run) runs the tests, deploys the backend to
App Service, builds the extension with `SIMPLAN_API_URL`, publishes it **private** and shares it with
`ADO_SHARE_WITH`. Variables/secrets it needs are listed at the top of the file. `ci.yml` runs tests (with a
Postgres service) and packages a `.vsix` on every push/PR.

Manual:

```bash
cd extension && npm ci
SIMPLAN_API_URL=https://<app>.azurewebsites.net NODE_ENV=production npm run package   # -> out/*.vsix (~100 KB)
```

Upload at the publisher portal (or `npx tfx extension publish --token <PAT>`), keep it private, share it with
your org(s), install it. Copy the extension's **Certificate** into `ADO_EXTENSION_SECRET`. Changing `scopes`
rotates that secret; users are asked to re-authorize the extension.

**Dev mode** (no re-publish per change): set `baseUri` in `extension/overrides.dev.json` to
`https://<app>.azurewebsites.net/ado/ext`, `npm run package:dev`, install "simplan (dev)". Pages are then served
by the backend (`/ado/ext` → `extension/dist`) on the API's own origin.

## Tests

```bash
npm test                                                         # unit tests only
TEST_DATABASE_URL=postgres://…/simplan_test npm test             # + integration (throwaway DB, name must contain "test")
```

- `test/ado-api.test.js` — auth bridge, config, commit PR, CORS (milestones 1–2).
- `test/ado-features.test.js` — sockets/presence, board, live hooks, chat + AI with repo tool calls,
  proposals (incl. concurrent approvals), branches, PR status, summary (milestones 3–6).
- `test/helpers/fakeAdo.js` / `fakeFoundry.js` — fake Azure DevOps and Foundry servers.
- Test files run one at a time (`--test-concurrency=1`): integration files reset the same database.

The extension pages were also driven end-to-end in jsdom (stubbed SDK, real backend, real sockets):
board moves/drag-drop/lanes/live, chat + AI + proposals, work item group, action, settings — 29/29 checks.
That harness is not in the repo (it needs jsdom); real-browser checks still need an ADO org.

## First run in a real org — checklist

These were taken from Microsoft's docs but could not be verified without an org:

1. Board hub loads and shows your name in presence → app-token claims (`nameid`, HS256) and CORS origin
   (`*.gallerycdn.vsassets.io`) are right. If not, check the browser console and `ADO_ALLOWED_ORIGINS`.
2. Project settings → simplan is editable for a Project Administrator → Permissions API check works with
   an extension access token.
3. Settings → Live board updates → Turn on, then edit a work item in native Boards → simplan Board updates
   within seconds (service hooks reach `BASE_URL`).
4. Chat `@ai hello` → answer appears (managed identity → Foundry). `Turn into tickets` → proposals → Approve
   → work item exists with description, tags, and (with "+ branch") a linked branch under Development.
5. Work item form shows the simplan group; **Ask simplan AI** in the work item "…" menu opens the chat.
6. Theme: switch ADO to dark theme and check contrast (pages use ADO's CSS variables with light fallbacks).

## Known limits

- One App Service instance (in-memory presence, AI throttle, auth caches).
- Board shows the 500 most recently changed items of one work item type; use `board.areaPath` to narrow.
- Approval creates the ADO work item while holding the proposal row lock; if the DB commit failed *after* ADO
  created the item, the item would exist without the proposal being marked approved (logged as a 500).
- Chat history and proposals live in simplan's Postgres, not in ADO.
