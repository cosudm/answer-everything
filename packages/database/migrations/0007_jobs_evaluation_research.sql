-- 0007: asynchronous jobs, evaluation harness, research tasks

CREATE TABLE jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type                text NOT NULL,
  workspace_id        uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  acting_identity_id  uuid REFERENCES acting_identities(id) ON DELETE SET NULL,
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'QUEUED'
                      CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','DEAD')),
  attempts            integer NOT NULL DEFAULT 0,
  max_attempts        integer NOT NULL DEFAULT 5,
  run_at              timestamptz NOT NULL DEFAULT now(),
  locked_at           timestamptz,
  locked_by           text,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE status = 'QUEUED';
CREATE INDEX jobs_workspace_idx ON jobs (workspace_id, created_at DESC);

CREATE TABLE evaluation_suites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL UNIQUE,
  name         text NOT NULL,
  category     text NOT NULL CHECK (category IN
                 ('CAPABILITY','RELIABILITY','BEHAVIORAL_LATITUDE','SECURITY','GOVERNANCE')),
  description  text NOT NULL DEFAULT '',
  version      text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evaluation_cases (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id  uuid NOT NULL REFERENCES evaluation_suites(id) ON DELETE CASCADE,
  name      text NOT NULL,
  input     jsonb NOT NULL,
  grader    text NOT NULL,
  expected  jsonb NOT NULL DEFAULT '{}'::jsonb,
  tags      text[] NOT NULL DEFAULT '{}',
  weight    real NOT NULL DEFAULT 1,
  UNIQUE (suite_id, name)
);

CREATE TABLE evaluation_runs (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id                   uuid NOT NULL REFERENCES evaluation_suites(id),
  suite_version              text NOT NULL,
  model_version_id           uuid NOT NULL REFERENCES model_versions(id),
  baseline_model_version_id  uuid REFERENCES model_versions(id),
  status                     text NOT NULL DEFAULT 'QUEUED'
                             CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
  started_at                 timestamptz NOT NULL DEFAULT now(),
  finished_at                timestamptz,
  summary                    jsonb,
  triggered_by_identity_id   uuid REFERENCES acting_identities(id),
  error                      text
);
CREATE INDEX evaluation_runs_model_idx ON evaluation_runs (model_version_id, started_at DESC);
ALTER TABLE model_status_changes
  ADD CONSTRAINT model_status_changes_eval_run_fk
  FOREIGN KEY (evaluation_run_id) REFERENCES evaluation_runs(id) ON DELETE SET NULL;

CREATE TABLE evaluation_results (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        uuid NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  case_id       uuid NOT NULL REFERENCES evaluation_cases(id) ON DELETE CASCADE,
  model_run_id  uuid REFERENCES model_runs(id) ON DELETE SET NULL,
  passed        boolean NOT NULL,
  score         real NOT NULL,
  output        text,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX evaluation_results_run_idx ON evaluation_results (run_id);

-- Evaluation model runs are platform-level; they need a workspace for RLS and
-- budget accounting. A dedicated platform workspace is created by the seed.

CREATE TABLE research_tasks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id     uuid REFERENCES conversations(id) ON DELETE SET NULL,
  project_id          uuid REFERENCES projects(id) ON DELETE SET NULL,
  acting_identity_id  uuid NOT NULL REFERENCES acting_identities(id),
  question            text NOT NULL,
  status              text NOT NULL DEFAULT 'QUEUED',
  steps               jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer_record_id    uuid REFERENCES answer_records(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);
CREATE TRIGGER research_tasks_updated_at BEFORE UPDATE ON research_tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
