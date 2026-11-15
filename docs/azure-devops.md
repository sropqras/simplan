# simplan for Azure DevOps — runbook

simplan runs as a private Azure DevOps extension. Tickets are real ADO work items; simplan's
backend (Express, on Azure App Service) holds only tool state (settings now; chat and AI proposals later)
and calls Azure AI Foundry. Full plan: milestones 0–7 below.

## Status (2026-11-15)

| Milestone | Scope | Status |
|---|---|---|
| 0 | Azure + Marketplace prerequisites | **to do (needs the account owner)** |
| 1 | Extension skeleton + auth bridge (app token ↔ access token) | **done**, tested against a fake ADO; not yet run in a real org |
| 2 | Config: `.simplan.yml` in repo + tool settings page + commit-to-repo PR | **done**, same caveat |
| 3 | Enhanced board (WIQL, drag-drop, swimlanes, service-hook live updates) | next |
| 4 | Project chat + `/ado` Socket.IO namespace + `@ai` replies (Foundry) | planned |
| 5 | AI tickets: repo context → proposals → approve → work item | planned |
| 6 | Code linking: branch + artifact link, PR status on work item form | planned |
| 7 | CI publish (tfx), App Service deploy | planned |

## How auth works (no cookies in ADO mode)

Every extension request to `/ado/api/*` carries:

| Header | From | Used for |
|---|---|---|
| `Authorization: Bearer <appToken>` | `SDK.getAppToken()` | proves the call comes from our extension; HS256 JWT signed with the extension secret; `nameid` = ADO user id |
| `X-ADO-Token` | `SDK.getAccessToken()` | backend calls ADO REST **as that user** — ADO enforces their permissions |
| `X-ADO-Org` | `SDK.getHost().name` | organization (validated `[A-Za-z0-9-]`, it becomes part of the URL) |

`src/ado/auth.js` verifies the app token, then calls `_apis/connectionData` with the access token and
requires the same user id (cached 5 min). Project routes call `_apis/projects/{id}` as the user
(404 if they can't see it). Config writes need the project "Edit project-level information" permission
(Project Administrators), checked via the Permissions API.

## Configuration model

Effective value per key = built-in default ← `.simplan.yml` on the repo's default branch ← overrides saved
in **Project settings → simplan** (stored in `ado_projects.settings`). The settings page shows each key's
source and can reset an override. "Commit to repo…" opens a PR that writes the merged config to
`.simplan.yml` (branch `simplan/config-<timestamp>`).

Repo used: the `repo` setting if set, else the repo named like the project, else the only/first repo.

```yaml
# .simplan.yml
board:
  workItemType: User Story
  columns: [New, Active, Resolved, Closed]
  swimlanes: assignee        # none | assignee
  areaPath: Shop\Web
ai:
  deployment: gpt-4.1        # Foundry deployment; default FOUNDRY_DEPLOYMENT
  systemPrompt: Write acceptance criteria as a checklist.
  defaultType: Task
  contextPaths: [README.md, docs/**, src/**]   # only these paths are ever sent to the model
  requireApproval: true
tickets:
  branchPattern: feature/{id}-{slug}
  defaultTags: [simplan]
```

Invalid or unknown keys in the repo file are ignored and listed on the settings page; they never break the tool.

## Milestone 0 — prerequisites (account owner)

1. **Marketplace publisher**: https://marketplace.visualstudio.com/manage → create publisher. Put its id in
   `extension/vss-extension.json` (`publisher`).
2. **Dev ADO org** + a test project with a Git repo.
3. **Azure resources** (one resource group):
   - Azure AI Foundry resource + a chat model deployment.
   - Azure Database for PostgreSQL Flexible Server (database `realtime_tasks`).
   - App Service (Linux, Node 22). Settings: **WebSockets On**, **ARR affinity On**, **one instance**
     (Socket.IO; scale-out needs a Redis adapter / Web PubSub later).
     Enable the **system-assigned managed identity** and grant it **Cognitive Services OpenAI User** on the Foundry resource.
4. App settings on the App Service: `DATABASE_URL`, `DATABASE_SSL=true`, `SESSION_SECRET`, `BASE_URL`,
   `ADO_EXTENSION_SECRET` (after first publish, see below), `FOUNDRY_ENDPOINT`, `FOUNDRY_DEPLOYMENT`, `NODE_ENV=production`.
5. `npm run db:init` once against the Azure database.

## Build, package, publish

```bash
cd extension
npm install
# Production package: pages served from the Marketplace CDN, calling the backend cross-origin.
SIMPLAN_API_URL=https://<app>.azurewebsites.net NODE_ENV=production npm run package   # -> out/*.vsix
```

Upload the `.vsix` at the publisher portal (or `npx tfx extension publish --token <PAT>`), keep it
**private**, and **share** it with your org(s); then install it in the org. Copy the extension's
**Certificate** (secret) from the portal into `ADO_EXTENSION_SECRET`. Changing `scopes` in the manifest
rotates the secret.

**Dev mode** (no re-publish per change): set `baseUri` in `extension/overrides.dev.json` to
`https://<app>.azurewebsites.net/ado/ext`, run `npm run package:dev` once and install that "simplan (dev)"
extension. Pages are then served by the backend itself (`/ado/ext` → `extension/dist`), same origin as the API;
redeploy the backend to update them.

## Tests

```bash
npm test                                   # unit tests (token, config, ADO client)
TEST_DATABASE_URL=postgres://…/simplan_test npm test   # + integration: real server + Postgres + fake ADO
```

`test/helpers/fakeAdo.js` imitates the ADO endpoints used (connectionData, projects, permissions,
repos, items, refs, pushes, pull requests) with three users: admin, member, outsider.
The integration test **drops `ado_projects`** in the target database — use a throwaway DB.

## Not verified yet (needs a real org)

- App token claim shape (`nameid`) and HS256 signing — taken from Microsoft's docs; confirm with a real token.
- Iframe origin of packaged pages (`*.gallerycdn.vsassets.io` allowed by default in `src/ado/cors.js`).
- Permissions API call used for the admin check (`_apis/permissions/{ns}/2`) with an extension access token.
- UI inside the real ADO frame (theme variables, sizing). Pages were exercised in jsdom with a stubbed SDK only.
