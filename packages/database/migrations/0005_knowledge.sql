-- 0005: governed knowledge objects, chunks with hybrid (lexical + vector) indexes

CREATE TABLE knowledge_objects (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id         uuid REFERENCES projects(id) ON DELETE SET NULL,
  kind               text NOT NULL CHECK (kind IN
                       ('DOCUMENT','NOTE','SAVED_ANSWER','CONVERSATION','SOURCE','MEMORY','RESEARCH')),
  title              text NOT NULL,
  mime_type          text,
  byte_size          bigint,
  content_hash       text,
  storage_key        text,
  source_uri         text,
  -- Extracted text of the original, kept for re-chunking and export.
  text_content       text,
  privacy_class      text NOT NULL DEFAULT 'INTERNAL'
                     CHECK (privacy_class IN ('PUBLIC','INTERNAL','CONFIDENTIAL','RESTRICTED')),
  ai_use_permission  text NOT NULL DEFAULT 'ALLOW' CHECK (ai_use_permission IN ('ALLOW','DENY')),
  status             text NOT NULL DEFAULT 'PENDING' CHECK (status IN
                       ('PENDING','SCANNING','EXTRACTING','INDEXING','READY','FAILED','ARCHIVED')),
  status_detail      text,
  owner_user_id      uuid NOT NULL REFERENCES users(id),
  tags               text[] NOT NULL DEFAULT '{}',
  chunk_count        integer NOT NULL DEFAULT 0,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz,
  deleted_at         timestamptz
);
CREATE INDEX knowledge_objects_workspace_idx
  ON knowledge_objects (workspace_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX knowledge_objects_project_idx ON knowledge_objects (project_id) WHERE deleted_at IS NULL;
CREATE INDEX knowledge_objects_tags_idx ON knowledge_objects USING gin (tags);
CREATE TRIGGER knowledge_objects_updated_at BEFORE UPDATE ON knowledge_objects FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Embedding dimension is fixed per deployment (ADR-0007). 1536 matches
-- text-embedding-3-small and the local development embedder.
CREATE TABLE knowledge_chunks (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_object_id         uuid NOT NULL REFERENCES knowledge_objects(id) ON DELETE CASCADE,
  workspace_id                uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ordinal                     integer NOT NULL,
  content                     text NOT NULL,
  token_count                 integer NOT NULL DEFAULT 0,
  locator                     jsonb,
  embedding                   vector(1536),
  embedding_model_version_id  uuid REFERENCES model_versions(id) ON DELETE SET NULL,
  tsv                         tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (knowledge_object_id, ordinal)
);
CREATE INDEX knowledge_chunks_workspace_idx ON knowledge_chunks (workspace_id);
CREATE INDEX knowledge_chunks_tsv_idx ON knowledge_chunks USING gin (tsv);
-- HNSW keeps recall high at small scale without tuning lists; revisit at >1M chunks.
CREATE INDEX knowledge_chunks_embedding_idx
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
