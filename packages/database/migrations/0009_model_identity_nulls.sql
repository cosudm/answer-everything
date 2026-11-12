-- 0009: a model identity is unique even without a version label
--
-- (provider, provider model name, version) identifies a model version. The
-- original UNIQUE constraint treated NULL versions as distinct, so the
-- registry seed's upsert never matched a model without a version label and
-- every re-seed inserted a second copy of it.
--
-- Copies made that way are retired rather than deleted: runs, ledger rows and
-- status history that reference them stay intact (several of those tables are
-- append-only). The oldest row per identity keeps the identity; each copy gets
-- a distinguishing version label, is disabled, and records which row it
-- duplicates. Then NULLs are made to count as equal.

WITH ranked AS (
  SELECT id,
         first_value(id) OVER w AS keeper,
         row_number() OVER w AS position
  FROM model_versions
  WHERE version IS NULL
  WINDOW w AS (PARTITION BY provider_id, provider_model_name ORDER BY created_at, id)
)
UPDATE model_versions mv
SET version = 'duplicate-' || left(mv.id::text, 8),
    enabled = false,
    metadata = mv.metadata || jsonb_build_object(
      'retired', 'duplicate created by re-running the registry seed',
      'duplicateOf', ranked.keeper
    )
FROM ranked
WHERE mv.id = ranked.id AND ranked.position > 1;

ALTER TABLE model_versions
  DROP CONSTRAINT model_versions_provider_id_provider_model_name_version_key;

ALTER TABLE model_versions
  ADD CONSTRAINT model_versions_identity_key
  UNIQUE NULLS NOT DISTINCT (provider_id, provider_model_name, version);
