import type { Queryable } from "@ae/database";
import { isoRequired } from "@ae/database";
import type { EvaluationStatus, ModelVersion, Provider, RegisterModelInput } from "@ae/domain";

export function toProvider(r: Record<string, unknown>): Provider {
  return {
    id: r.id as string,
    slug: r.slug as string,
    kind: r.kind as Provider["kind"],
    adapter: r.adapter as Provider["adapter"],
    displayName: r.display_name as string,
    baseUrl: (r.base_url as string | null) ?? null,
    credentialRef: (r.credential_ref as string | null) ?? null,
    dataHandling: (r.data_handling as Provider["dataHandling"]) ?? { trainsOnData: false, retentionDays: null, region: null },
    enabled: Boolean(r.enabled),
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: isoRequired(r.created_at as string),
    updatedAt: isoRequired(r.updated_at as string),
  };
}

export function toModelVersion(r: Record<string, unknown>): ModelVersion {
  return {
    id: r.id as string,
    providerId: r.provider_id as string,
    providerModelName: r.provider_model_name as string,
    displayName: r.display_name as string,
    baseModel: (r.base_model as string | null) ?? null,
    version: (r.version as string | null) ?? null,
    deploymentType: r.deployment_type as ModelVersion["deploymentType"],
    behavioralProfile: r.behavioral_profile as ModelVersion["behavioralProfile"],
    capabilities: (r.capabilities as ModelVersion["capabilities"]) ?? [],
    privacyClassesAllowed: (r.privacy_classes_allowed as ModelVersion["privacyClassesAllowed"]) ?? [],
    evaluationStatus: r.evaluation_status as EvaluationStatus,
    weightsHash: (r.weights_hash as string | null) ?? null,
    adapterIds: (r.adapter_ids as string[]) ?? [],
    contextWindow: Number(r.context_window),
    maxOutputTokens: r.max_output_tokens == null ? null : Number(r.max_output_tokens),
    inputCostPerMillion: r.input_cost_per_million == null ? null : Number(r.input_cost_per_million),
    outputCostPerMillion: r.output_cost_per_million == null ? null : Number(r.output_cost_per_million),
    quantization: (r.quantization as string | null) ?? null,
    license: (r.license as string | null) ?? null,
    intendedUses: (r.intended_uses as string[]) ?? [],
    prohibitedUses: (r.prohibited_uses as string[]) ?? [],
    modificationHistory: (r.modification_history as ModelVersion["modificationHistory"]) ?? [],
    embeddingDimensions: r.embedding_dimensions == null ? null : Number(r.embedding_dimensions),
    enabled: Boolean(r.enabled),
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: isoRequired(r.created_at as string),
    updatedAt: isoRequired(r.updated_at as string),
  };
}

export interface ModelWithProvider {
  model: ModelVersion;
  provider: Provider;
}

export async function listProviders(q: Queryable): Promise<Provider[]> {
  const res = await q.query("SELECT * FROM providers ORDER BY display_name");
  return res.rows.map(toProvider);
}

export async function getProviderBySlug(q: Queryable, slug: string): Promise<Provider | null> {
  const res = await q.query("SELECT * FROM providers WHERE slug = $1", [slug]);
  return res.rows[0] ? toProvider(res.rows[0]) : null;
}

export async function upsertProvider(
  q: Queryable,
  input: Omit<Provider, "id" | "createdAt" | "updatedAt">,
): Promise<Provider> {
  const res = await q.query(
    `INSERT INTO providers (slug, kind, adapter, display_name, base_url, credential_ref, data_handling, enabled, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (slug) DO UPDATE SET
       kind = EXCLUDED.kind, adapter = EXCLUDED.adapter, display_name = EXCLUDED.display_name,
       base_url = EXCLUDED.base_url, credential_ref = EXCLUDED.credential_ref,
       data_handling = EXCLUDED.data_handling, enabled = EXCLUDED.enabled, metadata = EXCLUDED.metadata
     RETURNING *`,
    [
      input.slug,
      input.kind,
      input.adapter,
      input.displayName,
      input.baseUrl,
      input.credentialRef,
      JSON.stringify(input.dataHandling),
      input.enabled,
      JSON.stringify(input.metadata),
    ],
  );
  return toProvider(res.rows[0]);
}

export async function listModels(q: Queryable, opts: { includeDisabled?: boolean } = {}): Promise<ModelWithProvider[]> {
  const res = await q.query(
    `SELECT row_to_json(m.*) AS model, row_to_json(p.*) AS provider
     FROM model_versions m JOIN providers p ON p.id = m.provider_id
     WHERE ($1::boolean OR m.enabled)
     ORDER BY p.display_name, m.display_name`,
    [opts.includeDisabled ?? false],
  );
  return res.rows.map((r) => ({ model: toModelVersion(r.model), provider: toProvider(r.provider) }));
}

export async function getModel(q: Queryable, id: string): Promise<ModelWithProvider | null> {
  const res = await q.query(
    `SELECT row_to_json(m.*) AS model, row_to_json(p.*) AS provider
     FROM model_versions m JOIN providers p ON p.id = m.provider_id WHERE m.id = $1`,
    [id],
  );
  const r = res.rows[0];
  return r ? { model: toModelVersion(r.model), provider: toProvider(r.provider) } : null;
}

export async function findModelByName(
  q: Queryable,
  providerSlug: string,
  providerModelName: string,
  version: string | null,
): Promise<ModelWithProvider | null> {
  const res = await q.query(
    `SELECT row_to_json(m.*) AS model, row_to_json(p.*) AS provider
     FROM model_versions m JOIN providers p ON p.id = m.provider_id
     WHERE p.slug = $1 AND m.provider_model_name = $2 AND m.version IS NOT DISTINCT FROM $3`,
    [providerSlug, providerModelName, version],
  );
  const r = res.rows[0];
  return r ? { model: toModelVersion(r.model), provider: toProvider(r.provider) } : null;
}

/**
 * Registers a model version. A new version row is immutable in the
 * identity-bearing fields (provider, name, version, base model, weights hash);
 * changing those means registering a new version.
 */
export async function registerModel(q: Queryable, input: RegisterModelInput): Promise<ModelVersion> {
  const res = await q.query(
    `INSERT INTO model_versions
       (provider_id, provider_model_name, display_name, base_model, version, deployment_type, behavioral_profile,
        capabilities, privacy_classes_allowed, evaluation_status, weights_hash, adapter_ids, context_window,
        max_output_tokens, input_cost_per_million, output_cost_per_million, quantization, license,
        intended_uses, prohibited_uses, modification_history, embedding_dimensions, enabled, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
     ON CONFLICT (provider_id, provider_model_name, version) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       capabilities = EXCLUDED.capabilities,
       privacy_classes_allowed = EXCLUDED.privacy_classes_allowed,
       context_window = EXCLUDED.context_window,
       max_output_tokens = EXCLUDED.max_output_tokens,
       input_cost_per_million = EXCLUDED.input_cost_per_million,
       output_cost_per_million = EXCLUDED.output_cost_per_million,
       license = EXCLUDED.license,
       intended_uses = EXCLUDED.intended_uses,
       prohibited_uses = EXCLUDED.prohibited_uses,
       embedding_dimensions = EXCLUDED.embedding_dimensions,
       metadata = EXCLUDED.metadata
     RETURNING *`,
    [
      input.providerId,
      input.providerModelName,
      input.displayName,
      input.baseModel ?? null,
      input.version ?? null,
      input.deploymentType,
      input.behavioralProfile,
      input.capabilities,
      input.privacyClassesAllowed,
      input.evaluationStatus,
      input.weightsHash ?? null,
      input.adapterIds ?? [],
      input.contextWindow,
      input.maxOutputTokens ?? null,
      input.inputCostPerMillion ?? null,
      input.outputCostPerMillion ?? null,
      input.quantization ?? null,
      input.license ?? null,
      input.intendedUses ?? [],
      input.prohibitedUses ?? [],
      JSON.stringify(input.modificationHistory ?? []),
      input.embeddingDimensions ?? null,
      input.enabled ?? true,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return toModelVersion(res.rows[0]);
}

export async function setEvaluationStatus(
  q: Queryable,
  modelVersionId: string,
  to: EvaluationStatus,
  changedByIdentityId: string | null,
  reason: string | null,
  evaluationRunId: string | null = null,
): Promise<ModelVersion> {
  const current = await q.query("SELECT evaluation_status FROM model_versions WHERE id = $1 FOR UPDATE", [modelVersionId]);
  if (!current.rows[0]) throw new Error("model not found");
  const from: string = current.rows[0].evaluation_status;
  const res = await q.query(`UPDATE model_versions SET evaluation_status = $2 WHERE id = $1 RETURNING *`, [
    modelVersionId,
    to,
  ]);
  await q.query(
    `INSERT INTO model_status_changes (model_version_id, from_status, to_status, changed_by_identity, reason, evaluation_run_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [modelVersionId, from, to, changedByIdentityId, reason, evaluationRunId],
  );
  return toModelVersion(res.rows[0]);
}

export async function setModelEnabled(q: Queryable, modelVersionId: string, enabled: boolean): Promise<void> {
  await q.query("UPDATE model_versions SET enabled = $2 WHERE id = $1", [modelVersionId, enabled]);
}
