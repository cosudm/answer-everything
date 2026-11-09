-- 0006: answer records, claims, citations, authorization decisions, provenance, audit

CREATE TABLE answer_records (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id      uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id           uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  acting_identity_id   uuid NOT NULL REFERENCES acting_identities(id),
  model_run_ids        uuid[] NOT NULL DEFAULT '{}',
  context_manifest_id  uuid REFERENCES context_manifests(id) ON DELETE SET NULL,
  disposition          text NOT NULL CHECK (disposition IN (
                         'ANSWERED','PARTIALLY_ANSWERED','NEEDS_CLARIFICATION','INSUFFICIENT_EVIDENCE',
                         'AUTHORIZATION_DENIED','PROVIDER_RESTRICTED','UNSUPPORTED','FAILED')),
  content              text NOT NULL,
  confidence           real CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  confidence_basis     text,
  limitations          jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer_path          jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX answer_records_message_idx ON answer_records (message_id);
ALTER TABLE messages
  ADD CONSTRAINT messages_answer_record_fk
  FOREIGN KEY (answer_record_id) REFERENCES answer_records(id) ON DELETE SET NULL;

CREATE TABLE citations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  answer_record_id     uuid NOT NULL REFERENCES answer_records(id) ON DELETE CASCADE,
  label                text NOT NULL,
  source_kind          text NOT NULL CHECK (source_kind IN
                         ('KNOWLEDGE_CHUNK','KNOWLEDGE_OBJECT','WEB','CONVERSATION_MESSAGE','PROVIDER_NATIVE')),
  source_id            uuid,
  knowledge_object_id  uuid REFERENCES knowledge_objects(id) ON DELETE SET NULL,
  uri                  text,
  title                text,
  excerpt              text,
  locator              jsonb,
  relevance_score      real,
  referenced           boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (answer_record_id, label)
);
CREATE INDEX citations_answer_idx ON citations (answer_record_id);

CREATE TABLE answer_claims (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  answer_record_id  uuid NOT NULL REFERENCES answer_records(id) ON DELETE CASCADE,
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  text              text NOT NULL,
  claim_type        text NOT NULL CHECK (claim_type IN
                      ('SOURCED_FACT','USER_PROVIDED_FACT','INFERENCE','RECOMMENDATION','UNCERTAIN')),
  citation_ids      uuid[] NOT NULL DEFAULT '{}',
  span_start        integer,
  span_end          integer,
  confidence        real,
  verification      jsonb,
  ordinal           integer NOT NULL DEFAULT 0
);
CREATE INDEX answer_claims_answer_idx ON answer_claims (answer_record_id, ordinal);

CREATE TABLE authorization_decisions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  acting_identity_id  uuid NOT NULL REFERENCES acting_identities(id),
  action              text NOT NULL,
  resource_kind       text NOT NULL,
  resource_id         uuid,
  outcome             text NOT NULL CHECK (outcome IN ('ALLOW','DENY','REQUIRES_APPROVAL')),
  policy_ids          text[] NOT NULL DEFAULT '{}',
  reason_codes        text[] NOT NULL DEFAULT '{}',
  obligations         jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX authorization_decisions_ws_idx ON authorization_decisions (workspace_id, created_at DESC);
CREATE TRIGGER authorization_decisions_append_only
  BEFORE UPDATE OR DELETE ON authorization_decisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE provenance_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subject_kind        text NOT NULL,
  subject_id          uuid NOT NULL,
  event               text NOT NULL,
  actor_identity_id   uuid REFERENCES acting_identities(id),
  source_kind         text,
  source_id           uuid,
  model_version_id    uuid REFERENCES model_versions(id) ON DELETE SET NULL,
  details             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provenance_subject_idx ON provenance_records (subject_kind, subject_id, created_at);
CREATE TRIGGER provenance_records_append_only
  BEFORE UPDATE OR DELETE ON provenance_records FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE audit_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid,                      -- intentionally no FK: audit survives workspace deletion
  actor_identity_id  uuid,
  actor_user_id      uuid,
  event_type         text NOT NULL,
  resource_kind      text,
  resource_id        uuid,
  outcome            text NOT NULL CHECK (outcome IN ('SUCCESS','FAILURE','DENIED')),
  ip_address         inet,
  user_agent         text,
  details            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_workspace_idx ON audit_events (workspace_id, created_at DESC);
CREATE INDEX audit_events_user_idx ON audit_events (actor_user_id, created_at DESC);
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
