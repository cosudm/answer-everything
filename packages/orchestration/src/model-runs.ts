import type { Queryable } from "@ae/database";
import { iso, isoRequired, withTenant } from "@ae/database";
import type {
  ModelRun,
  ModelRunPurpose,
  PrivacyClass,
  ProviderError,
  ProviderRefusal,
  TokenUsage,
} from "@ae/domain";
import type { BudgetGuard } from "@ae/model-gateway";
import { metrics } from "@ae/observability";
import type pg from "pg";

export function toModelRun(r: Record<string, unknown>): ModelRun {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    conversationId: (r.conversation_id as string | null) ?? null,
    messageId: (r.message_id as string | null) ?? null,
    modelVersionId: r.model_version_id as string,
    providerId: r.provider_id as string,
    actingIdentityId: r.acting_identity_id as string,
    purpose: r.purpose as ModelRunPurpose,
    status: r.status as ModelRun["status"],
    requestSnapshot: r.request_snapshot as ModelRun["requestSnapshot"],
    usage: (r.usage as TokenUsage | null) ?? null,
    estimatedCostUsd: r.estimated_cost_usd == null ? null : Number(r.estimated_cost_usd),
    latencyMs: r.latency_ms == null ? null : Number(r.latency_ms),
    timeToFirstTokenMs: r.time_to_first_token_ms == null ? null : Number(r.time_to_first_token_ms),
    providerRequestId: (r.provider_request_id as string | null) ?? null,
    refusal: (r.refusal as ProviderRefusal | null) ?? null,
    error: (r.error as ProviderError | null) ?? null,
    finishReason: (r.finish_reason as string | null) ?? null,
    startedAt: isoRequired(r.started_at as string),
    finishedAt: iso(r.finished_at as string | null),
  };
}

export async function startModelRun(
  q: Queryable,
  input: {
    workspaceId: string;
    conversationId: string | null;
    messageId: string | null;
    modelVersionId: string;
    providerId: string;
    actingIdentityId: string;
    purpose: ModelRunPurpose;
    snapshot: {
      messageCount: number;
      systemPromptHash: string | null;
      temperature: number | null;
      maxOutputTokens: number | null;
      informationPrivacyClass: PrivacyClass;
      contextManifestId: string | null;
    };
  },
): Promise<ModelRun> {
  const res = await q.query(
    `INSERT INTO model_runs
       (workspace_id, conversation_id, message_id, model_version_id, provider_id, acting_identity_id, purpose, status, request_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'RUNNING',$8) RETURNING *`,
    [
      input.workspaceId,
      input.conversationId,
      input.messageId,
      input.modelVersionId,
      input.providerId,
      input.actingIdentityId,
      input.purpose,
      JSON.stringify(input.snapshot),
    ],
  );
  return toModelRun(res.rows[0]);
}

export async function finishModelRun(
  q: Queryable,
  id: string,
  result: {
    status: ModelRun["status"];
    usage: TokenUsage | null;
    estimatedCostUsd: number | null;
    latencyMs: number;
    timeToFirstTokenMs: number | null;
    providerRequestId: string | null;
    refusal: ProviderRefusal | null;
    error: ProviderError | null;
    finishReason: string | null;
  },
): Promise<ModelRun> {
  const res = await q.query(
    `UPDATE model_runs SET status = $2, usage = $3, estimated_cost_usd = $4, latency_ms = $5, time_to_first_token_ms = $6,
       provider_request_id = $7, refusal = $8, error = $9, finish_reason = $10, finished_at = now()
     WHERE id = $1 RETURNING *`,
    [
      id,
      result.status,
      result.usage ? JSON.stringify(result.usage) : null,
      result.estimatedCostUsd,
      result.latencyMs,
      result.timeToFirstTokenMs,
      result.providerRequestId,
      result.refusal ? JSON.stringify(result.refusal) : null,
      result.error ? JSON.stringify(result.error) : null,
      result.finishReason,
    ],
  );
  const run = toModelRun(res.rows[0]);
  if (result.usage) {
    await q.query(
      `INSERT INTO usage_ledger (workspace_id, model_run_id, model_version_id, input_tokens, output_tokens, cost_usd) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        run.workspaceId,
        run.id,
        run.modelVersionId,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.estimatedCostUsd ?? 0,
      ],
    );
    metrics.modelTokens.inc(
      { model: run.modelVersionId, direction: "input" },
      result.usage.inputTokens,
    );
    metrics.modelTokens.inc(
      { model: run.modelVersionId, direction: "output" },
      result.usage.outputTokens,
    );
    if (result.estimatedCostUsd)
      metrics.modelCostUsd.inc({ workspace: run.workspaceId }, result.estimatedCostUsd);
  }
  return run;
}

export async function listModelRunsForMessage(
  q: Queryable,
  messageId: string,
): Promise<ModelRun[]> {
  const res = await q.query("SELECT * FROM model_runs WHERE message_id = $1 ORDER BY started_at", [
    messageId,
  ]);
  return res.rows.map(toModelRun);
}

export interface WorkspaceSpend {
  monthToDateUsd: number;
  limitUsd: number;
  remainingUsd: number;
  inputTokens: number;
  outputTokens: number;
  runs: number;
}

export async function workspaceSpend(q: Queryable, workspaceId: string): Promise<WorkspaceSpend> {
  const res = await q.query(
    `SELECT COALESCE(SUM(l.cost_usd),0) AS cost, COALESCE(SUM(l.input_tokens),0) AS inp, COALESCE(SUM(l.output_tokens),0) AS outp, COUNT(*) AS runs,
            (SELECT COALESCE((settings->>'monthlyBudgetUsd')::numeric, 25) FROM workspaces WHERE id = $1) AS limit_usd
     FROM usage_ledger l WHERE l.workspace_id = $1 AND l.created_at >= date_trunc('month', now())`,
    [workspaceId],
  );
  const r = res.rows[0];
  const cost = Number(r.cost);
  const limit = Number(r.limit_usd);
  return {
    monthToDateUsd: cost,
    limitUsd: limit,
    remainingUsd: Math.max(0, limit - cost),
    inputTokens: Number(r.inp),
    outputTokens: Number(r.outp),
    runs: Number(r.runs),
  };
}

/**
 * Budget guard backed by the usage ledger. Runs in its own tenant transaction
 * because the gateway calls it outside the orchestrator's transactions.
 */
export class LedgerBudgetGuard implements BudgetGuard {
  constructor(
    private readonly pool: pg.Pool,
    private readonly ctxFor: (workspaceId: string) => { userId: string | null; identityId: string },
  ) {}
  async check(workspaceId: string, estimatedCostUsd: number | null) {
    const ctx = this.ctxFor(workspaceId);
    const spend = await withTenant(
      this.pool,
      { userId: ctx.userId, workspaceId, identityId: ctx.identityId },
      (tx) => workspaceSpend(tx, workspaceId),
    );
    const projected = spend.monthToDateUsd + (estimatedCostUsd ?? 0);
    if (spend.limitUsd > 0 && projected > spend.limitUsd && (estimatedCostUsd ?? 0) > 0) {
      return {
        allowed: false,
        remainingUsd: spend.remainingUsd,
        reason: `Workspace monthly model budget of $${spend.limitUsd.toFixed(2)} would be exceeded (spent $${spend.monthToDateUsd.toFixed(4)}).`,
      };
    }
    return { allowed: true, remainingUsd: spend.remainingUsd, reason: null };
  }
}
