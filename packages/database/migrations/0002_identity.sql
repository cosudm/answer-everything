-- 0002: users, acting identities, sessions, workspaces, memberships, projects

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email             text NOT NULL,              -- as entered
  email_normalized  text NOT NULL,              -- lower(trim(email)); uniqueness key
  email_verified_at timestamptz,
  password_hash     text,                      -- NULL for OIDC-only accounts
  display_name      text NOT NULL,
  status            text NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','SUSPENDED','PENDING_DELETION','DELETED')),
  platform_role     text NOT NULL DEFAULT 'USER'
                    CHECK (platform_role IN ('USER','PLATFORM_ADMIN')),
  mfa_enabled       boolean NOT NULL DEFAULT false,
  mfa_secret_enc    bytea,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz
);
CREATE UNIQUE INDEX users_email_normalized_key ON users (email_normalized) WHERE deleted_at IS NULL;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE acting_identities (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                  text NOT NULL CHECK (kind IN ('USER','SERVICE','AGENT')),
  user_id               uuid REFERENCES users(id) ON DELETE CASCADE,
  delegated_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  display_name          text NOT NULL,
  model_version_id      uuid,                    -- FK added after model_versions exists
  created_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  CONSTRAINT acting_identities_user_requires_user
    CHECK (kind <> 'USER' OR user_id IS NOT NULL),
  CONSTRAINT acting_identities_agent_requires_delegator
    CHECK (kind <> 'AGENT' OR delegated_by_user_id IS NOT NULL)
);
CREATE UNIQUE INDEX acting_identities_primary_user ON acting_identities (user_id) WHERE kind = 'USER';

-- Platform service identity used by background workers and seeds.
INSERT INTO acting_identities (id, kind, display_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'SERVICE', 'Answer Everything Platform');

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  acting_identity_id  uuid NOT NULL REFERENCES acting_identities(id) ON DELETE CASCADE,
  token_hash          text NOT NULL UNIQUE,      -- HMAC-SHA256 of the access token
  refresh_token_hash  text NOT NULL UNIQUE,      -- HMAC-SHA256 of the refresh token
  expires_at          timestamptz NOT NULL,
  refresh_expires_at  timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at          timestamptz,
  rotated_from_id     uuid REFERENCES sessions(id) ON DELETE SET NULL,
  ip_address          inet,
  user_agent          text
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE login_attempts (
  id            bigserial PRIMARY KEY,
  email_normalized text NOT NULL,
  ip_address    inet,
  succeeded     boolean NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_recent_idx ON login_attempts (email_normalized, created_at DESC);

CREATE TABLE workspaces (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL,
  name           text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('PERSONAL','ORGANIZATION')),
  owner_user_id  uuid NOT NULL REFERENCES users(id),
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE UNIQUE INDEX workspaces_slug_key ON workspaces (slug) WHERE deleted_at IS NULL;
CREATE TRIGGER workspaces_updated_at BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('OWNER','ADMIN','MEMBER','VIEWER')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_memberships_user_idx ON workspace_memberships (user_id);

-- Membership check usable inside RLS policies. STABLE so it is evaluated once
-- per statement per argument. It reads memberships directly; the memberships
-- policy lets a user see only their own rows, which is exactly what this needs.
CREATE OR REPLACE FUNCTION app_is_member(ws uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM workspace_memberships m
    WHERE m.workspace_id = ws AND m.user_id = app_current_user_id()
  )
$$;

CREATE OR REPLACE FUNCTION app_member_role(ws uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.role FROM workspace_memberships m
  WHERE m.workspace_id = ws AND m.user_id = app_current_user_id()
$$;

CREATE TABLE projects (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               text NOT NULL,
  description        text,
  instructions       text,
  privacy_class      text NOT NULL DEFAULT 'INTERNAL'
                     CHECK (privacy_class IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz
);
CREATE INDEX projects_workspace_idx ON projects (workspace_id) WHERE archived_at IS NULL;
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();
