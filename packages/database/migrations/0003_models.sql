-- 0003: providers and the model registry (platform-global tables)

CREATE TABLE providers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  kind            text NOT NULL CHECK (kind IN (
                    'ANTHROPIC','OPENAI','OPENAI_COMPATIBLE','GOOGLE','XAI','DEEPSEEK',
                    'PERPLEXITY','AZURE_AI_FOUNDRY','VLLM','OLLAMA','DEDICATED_INFERENCE','LOCAL_DEV')),
  adapter         text NOT NULL CHECK (adapter IN ('anthropic','openai-compatible')),
  display_name    text NOT NULL,
  base_url        text,
  credential_ref  text,                         -- name of the secret, never the secret
  data_handling   jsonb NOT NULL DEFAULT '{"trainsOnData":false,"retentionDays":null,"region":null}'::jsonb,
  enabled         boolean NOT NULL DEFAULT true,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER providers_updated_at BEFORE UPDATE ON providers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE model_versions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id              uuid NOT NULL REFERENCES providers(id),
  provider_model_name      text NOT NULL,
  display_name             text NOT NULL,
  base_model               text,
  version                  text,
  deployment_type          text NOT NULL CHECK (deployment_type IN
                             ('COMMERCIAL_API','DEDICATED_ENDPOINT','OPEN_WEIGHT','LOCAL')),
  behavioral_profile       text NOT NULL CHECK (behavioral_profile IN
                             ('STANDARD','PROFESSIONAL','RESEARCH','HIGH_LATITUDE','EXPERIMENTAL')),
  capabilities             text[] NOT NULL DEFAULT '{}',
  privacy_classes_allowed  text[] NOT NULL DEFAULT '{PUBLIC}',
  evaluation_status        text NOT NULL DEFAULT 'UNTESTED'
                           CHECK (evaluation_status IN ('UNTESTED','TESTING','APPROVED','REJECTED')),
  weights_hash             text,
  adapter_ids              text[] NOT NULL DEFAULT '{}',
  context_window           integer NOT NULL CHECK (context_window > 0),
  max_output_tokens        integer,
  input_cost_per_million   numeric(12,6),
  output_cost_per_million  numeric(12,6),
  quantization             text,
  license                  text,
  intended_uses            text[] NOT NULL DEFAULT '{}',
  prohibited_uses          text[] NOT NULL DEFAULT '{}',
  modification_history     jsonb NOT NULL DEFAULT '[]'::jsonb,
  embedding_dimensions     integer,
  enabled                  boolean NOT NULL DEFAULT true,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, provider_model_name, version)
);
CREATE TRIGGER model_versions_updated_at BEFORE UPDATE ON model_versions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Immutable history of evaluation-status transitions (who approved what, when).
CREATE TABLE model_status_changes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_version_id   uuid NOT NULL REFERENCES model_versions(id) ON DELETE CASCADE,
  from_status        text,
  to_status          text NOT NULL,
  changed_by_identity uuid REFERENCES acting_identities(id),
  reason             text,
  evaluation_run_id  uuid,                        -- FK added once evaluation_runs exists
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER model_status_changes_append_only
  BEFORE UPDATE OR DELETE ON model_status_changes FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE acting_identities
  ADD CONSTRAINT acting_identities_model_fk
  FOREIGN KEY (model_version_id) REFERENCES model_versions(id) ON DELETE SET NULL;
