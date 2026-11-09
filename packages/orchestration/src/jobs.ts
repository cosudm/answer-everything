import type { Database } from "@ae/database";
import { withTenant } from "@ae/database";
import type { Job } from "@ae/domain";
import { KnowledgeIngestPayload } from "@ae/domain";
import type { EventBus, JobQueue } from "@ae/events";
import { runSuite } from "@ae/evaluation";
import { ingestKnowledgeObject, updateKnowledgeStatus } from "@ae/knowledge";
import type { ModelGateway } from "@ae/model-gateway";
import { metrics, type Logger } from "@ae/observability";
import { z } from "zod";

export const PLATFORM_SERVICE_IDENTITY_ID = "00000000-0000-0000-0000-000000000001";

export interface JobRunnerDeps {
  db: Database;
  queue: JobQueue;
  gateway: ModelGateway;
  logger: Logger;
  embeddingModelVersionId: string | null;
  events?: EventBus;
  workerId?: string;
}

const EvaluationPayload = z.object({
  suiteSlug: z.string(),
  modelVersionId: z.string().uuid(),
  baselineModelVersionId: z.string().uuid().nullable().optional(),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
});

/**
 * Executes background jobs. Each handler runs AS the user who requested the
 * work (app.user_id) THROUGH the platform service identity (app.identity_id),
 * so RLS keeps it inside that user's workspace and provenance records which
 * identity performed the step.
 */
export class JobRunner {
  private readonly workerId: string;
  private stopped = false;

  constructor(private readonly deps: JobRunnerDeps) {
    this.workerId = deps.workerId ?? `worker-${process.pid}`;
  }

  /** Claims and runs at most one job. Returns the job or null when idle. */
  async runOnce(): Promise<Job | null> {
    const job = await this.deps.queue.claim(this.deps.db.app, this.workerId);
    if (!job) return null;
    const log = this.deps.logger.child({ jobId: job.id, type: job.type, attempt: job.attempts });
    try {
      await this.handle(job);
      await this.deps.queue.succeed(this.deps.db.app, job.id);
      metrics.jobs.inc({ type: job.type, status: "succeeded" });
      log.info("job succeeded");
    } catch (err) {
      const status = await this.deps.queue.fail(this.deps.db.app, job.id, (err as Error).message);
      metrics.jobs.inc({ type: job.type, status: status === "DEAD" ? "dead" : "failed" });
      log.error({ err: (err as Error).message, status }, "job failed");
    }
    return job;
  }

  /** Polls until stop() is called. */
  async runForever(pollMs = 1000): Promise<void> {
    while (!this.stopped) {
      const job = await this.runOnce();
      if (!job) await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  stop() {
    this.stopped = true;
  }

  private async handle(job: Job): Promise<void> {
    switch (job.type) {
      case "knowledge.ingest":
        return this.ingest(job);
      case "knowledge.reindex":
        return this.ingest(job);
      case "evaluation.run_suite":
        return this.evaluate(job);
      case "model.health_check":
      case "answer.verify_claims":
      case "research.run":
      case "account.export":
      case "account.delete":
      case "retention.sweep":
        throw new Error(`handler for ${job.type} is not implemented yet (see ROADMAP.md)`);
      default:
        throw new Error(`unknown job type ${job.type}`);
    }
  }

  private async ingest(job: Job): Promise<void> {
    const payload = KnowledgeIngestPayload.extend({ userId: z.string().uuid() }).parse(job.payload);
    const ctx = { userId: payload.userId, workspaceId: payload.workspaceId, identityId: PLATFORM_SERVICE_IDENTITY_ID };
    try {
      const result = await withTenant(this.deps.db.app, ctx, (tx) =>
        ingestKnowledgeObject(tx, {
          knowledgeObjectId: payload.knowledgeObjectId,
          actingIdentityId: PLATFORM_SERVICE_IDENTITY_ID,
          embeddingModelVersionId: this.deps.embeddingModelVersionId,
          gateway: this.deps.gateway,
        }),
      );
      void this.deps.events?.emit({ type: "knowledge.ready", workspaceId: payload.workspaceId, knowledgeObjectId: payload.knowledgeObjectId, chunkCount: result.chunkCount });
    } catch (err) {
      await withTenant(this.deps.db.app, ctx, (tx) =>
        updateKnowledgeStatus(tx, payload.knowledgeObjectId, "FAILED", `Ingestion failed: ${(err as Error).message.slice(0, 500)}`),
      ).catch(() => undefined);
      void this.deps.events?.emit({ type: "knowledge.failed", workspaceId: payload.workspaceId, knowledgeObjectId: payload.knowledgeObjectId, reason: (err as Error).message });
      throw err;
    }
  }

  private async evaluate(job: Job): Promise<void> {
    const p = EvaluationPayload.parse(job.payload);
    const ctx = { userId: p.userId, workspaceId: p.workspaceId, identityId: PLATFORM_SERVICE_IDENTITY_ID };
    await withTenant(this.deps.db.app, ctx, (tx) =>
      runSuite(tx, {
        suiteSlug: p.suiteSlug,
        modelVersionId: p.modelVersionId,
        baselineModelVersionId: p.baselineModelVersionId ?? null,
        workspaceId: p.workspaceId,
        actingIdentityId: PLATFORM_SERVICE_IDENTITY_ID,
        gateway: this.deps.gateway,
        logger: this.deps.logger,
      }),
    );
  }
}
