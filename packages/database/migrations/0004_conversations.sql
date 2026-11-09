-- 0004: conversations, messages, model runs, context manifests

CREATE TABLE conversations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id                uuid REFERENCES projects(id) ON DELETE SET NULL,
  created_by_user_id        uuid NOT NULL REFERENCES users(id),
  title                     text,
  privacy_class             text NOT NULL DEFAULT 'INTERNAL'
                            CHECK (privacy_class IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  model_mode                text NOT NULL DEFAULT 'AUTO'
                            CHECK (model_mode IN ('AUTO','FRONTIER','RESEARCH','PRIVATE','HIGH_LATITUDE','EXPERIMENTAL')),
  pinned_model_version_id   uuid REFERENCES model_versions(id) ON DELETE SET NULL,
  parent_conversation_id    uuid REFERENCES conversations(id) ON DELETE SET NULL,
  branched_from_message_id  uuid,
  message_count             integer NOT NULL DEFAULT 0,
  last_message_at           timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  deleted_at                timestamptz
);
CREATE INDEX conversations_workspace_recent_idx
  ON conversations (workspace_id, COALESCE(last_message_at, created_at) DESC) WHERE deleted_at IS NULL;
CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id     uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role                text NOT NULL CHECK (role IN ('USER','ASSISTANT','SYSTEM','TOOL')),
  content             text NOT NULL,
  content_format      text NOT NULL DEFAULT 'markdown' CHECK (content_format IN ('markdown','text')),
  acting_identity_id  uuid NOT NULL REFERENCES acting_identities(id),
  parent_message_id   uuid REFERENCES messages(id) ON DELETE SET NULL,
  sequence            integer NOT NULL,
  status              text NOT NULL DEFAULT 'COMPLETE'
                      CHECK (status IN ('COMPLETE','STREAMING','FAILED','CANCELLED')),
  attachments         jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer_record_id    uuid,                     -- FK added in 0006
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, sequence)
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, sequence);
ALTER TABLE conversations
  ADD CONSTRAINT conversations_branch_message_fk
  FOREIGN KEY (branched_from_message_id) REFERENCES messages(id) ON DELETE SET NULL;

CREATE TABLE context_manifests (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id            uuid REFERENCES conversations(id) ON DELETE CASCADE,
  message_id                 uuid REFERENCES messages(id) ON DELETE SET NULL,
  acting_identity_id         uuid NOT NULL REFERENCES acting_identities(id),
  strategy                   text NOT NULL,
  information_privacy_class  text NOT NULL
                             CHECK (information_privacy_class IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  token_budget               integer NOT NULL,
  tokens_used                integer NOT NULL DEFAULT 0,
  items                      jsonb NOT NULL DEFAULT '[]'::jsonb,
  retrieval                  jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX context_manifests_message_idx ON context_manifests (message_id);

CREATE TABLE model_runs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id        uuid REFERENCES conversations(id) ON DELETE SET NULL,
  message_id             uuid REFERENCES messages(id) ON DELETE SET NULL,
  model_version_id       uuid NOT NULL REFERENCES model_versions(id),
  provider_id            uuid NOT NULL REFERENCES providers(id),
  acting_identity_id     uuid NOT NULL REFERENCES acting_identities(id),
  purpose                text NOT NULL,
  status                 text NOT NULL DEFAULT 'RUNNING'
                         CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','REFUSED','FAILED','CANCELLED')),
  request_snapshot       jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage                  jsonb,
  estimated_cost_usd     numeric(12,6),
  latency_ms             integer,
  time_to_first_token_ms integer,
  provider_request_id    text,
  refusal                jsonb,
  error                  jsonb,
  finish_reason          text,
  started_at             timestamptz NOT NULL DEFAULT now(),
  finished_at            timestamptz
);
CREATE INDEX model_runs_workspace_started_idx ON model_runs (workspace_id, started_at DESC);
CREATE INDEX model_runs_message_idx ON model_runs (message_id);

-- Spend ledger: one row per finished run with a cost. Budgets sum this.
CREATE TABLE usage_ledger (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  model_run_id   uuid NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
  model_version_id uuid NOT NULL REFERENCES model_versions(id),
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  cost_usd       numeric(12,6) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_ledger_workspace_month_idx ON usage_ledger (workspace_id, created_at);
