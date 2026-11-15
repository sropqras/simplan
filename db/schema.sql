-- ============================================================
--  Real-time Tasks — PostgreSQL schema
--  Models the full product so the foundation is stable:
--  Events -> Projects (each is a chat room) -> Tasks
--  Users join Projects via Memberships (owner | member)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- for gen_random_uuid()

-- ---------- Users ----------
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id   TEXT UNIQUE NOT NULL,
  email       TEXT UNIQUE NOT NULL,
  name        TEXT,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ
);

-- ---------- Events (top-level "mass event" instances) ----------
CREATE TABLE IF NOT EXISTS events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Projects (sub-projects; each has its own chat room + board) ----------
CREATE TABLE IF NOT EXISTS projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_projects_event ON projects(event_id);

-- ---------- Memberships (who is in a project, and their role) ----------
DO $$ BEGIN
  CREATE TYPE membership_role AS ENUM ('owner', 'member');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS memberships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role        membership_role NOT NULL DEFAULT 'member',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_project ON memberships(project_id);

-- ---------- Tasks ----------
DO $$ BEGIN
  CREATE TYPE task_status AS ENUM ('new', 'in_progress', 'handover', 'complete');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE task_approval AS ENUM ('proposed', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  status          task_status   NOT NULL DEFAULT 'new',
  approval_status task_approval NOT NULL DEFAULT 'proposed',
  owner_id        UUID REFERENCES users(id) ON DELETE SET NULL,   -- task owner
  assignee_id     UUID REFERENCES users(id) ON DELETE SET NULL,   -- assigned user
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  source          JSONB,    -- e.g. { "message_ids": [...] } when AI-generated from chat
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);

-- ---------- Chat messages (per project room) ----------
CREATE TABLE IF NOT EXISTS messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_project ON messages(project_id, created_at);

-- ---------- Notifications ----------
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,            -- e.g. 'task_assigned', 'task_proposed', 'mention'
  payload     JSONB,
  read        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);

-- ---------- Session store (connect-pg-simple) ----------
CREATE TABLE IF NOT EXISTS "session" (
  "sid"    VARCHAR NOT NULL COLLATE "default",
  "sess"   JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- ============================================================
--  Azure DevOps extension mode
--  Tickets live in ADO as work items; we only keep per-project tool state.
--  ADO ids: org = organization name (lower-cased), project_id = ADO project GUID,
--  user ids are ADO identity GUIDs stored as TEXT (not our users table).
-- ============================================================

-- Per ADO project: tool-config overrides set in the simplan settings page.
CREATE TABLE IF NOT EXISTS ado_projects (
  org           TEXT NOT NULL,
  project_id    UUID NOT NULL,
  project_name  TEXT,
  settings      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- flat { "board.workItemType": "Bug", ... }
  updated_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org, project_id)
);

-- Live board: ADO service-hook subscription ids we created for this project.
ALTER TABLE ado_projects ADD COLUMN IF NOT EXISTS hook_subscriptions JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Project chat (one room per ADO project). kind: user | ai | system
CREATE TABLE IF NOT EXISTS ado_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org          TEXT NOT NULL,
  project_id   UUID NOT NULL,
  author_id    TEXT,                       -- ADO identity id; NULL for ai/system
  author_name  TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'ai', 'system')),
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ado_messages_project ON ado_messages(org, project_id, created_at);

-- AI-proposed tickets awaiting approval. Approved ones point at the created work item.
CREATE TABLE IF NOT EXISTS ado_proposals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org             TEXT NOT NULL,
  project_id      UUID NOT NULL,
  payload         JSONB NOT NULL,          -- { title, description, type, acceptanceCriteria[], suggestedFiles[], tags[] }
  source_message_ids UUID[] NOT NULL DEFAULT '{}',
  status          task_approval NOT NULL DEFAULT 'proposed',
  work_item_id    INTEGER,
  requested_by    TEXT,
  decided_by      TEXT,
  decided_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ado_proposals_project ON ado_proposals(org, project_id, status);
CREATE INDEX IF NOT EXISTS idx_ado_proposals_work_item ON ado_proposals(org, project_id, work_item_id);
