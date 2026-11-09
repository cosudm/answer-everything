import type { Queryable } from "@ae/database";
import { iso, isoRequired } from "@ae/database";
import type { DomainEvent, Job, JobStatus, JobType } from "@ae/domain";
import type pg from "pg";

/* ------------------------------------------------------------------------ */
/* Job queue                                                                 */
/* ------------------------------------------------------------------------ */

export interface EnqueueInput {
  type: JobType;
  payload: Record<string, unknown>;
  workspaceId?: string | null;
  actingIdentityId?: string | null;
  runAt?: Date;
  maxAttempts?: number;
}

/**
 * Broker-neutral queue contract. Producers and handlers depend on this, not
 * on PostgreSQL, so Service Bus / SQS can be substituted (ADR-0004).
 */
export interface JobQueue {
  enqueue(q: Queryable, input: EnqueueInput): Promise<Job>;
  /** Atomically claims the next ready job for this worker, or null. */
  claim(pool: pg.Pool, workerId: string, types?: JobType[]): Promise<Job | null>;
  succeed(pool: pg.Pool, jobId: string): Promise<void>;
  fail(pool: pg.Pool, jobId: string, error: string, backoffSeconds?: number): Promise<JobStatus>;
  get(q: Queryable, jobId: string): Promise<Job | null>;
}

interface JobRow {
  id: string;
  type: JobType;
  workspace_id: string | null;
  acting_identity_id: string | null;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: Date;
  finished_at: Date | null;
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    type: r.type,
    workspaceId: r.workspace_id,
    actingIdentityId: r.acting_identity_id,
    payload: r.payload,
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    runAt: isoRequired(r.run_at),
    lockedAt: iso(r.locked_at),
    lockedBy: r.locked_by,
    lastError: r.last_error,
    createdAt: isoRequired(r.created_at),
    finishedAt: iso(r.finished_at),
  };
}

export class PostgresJobQueue implements JobQueue {
  async enqueue(q: Queryable, input: EnqueueInput): Promise<Job> {
    const res = await q.query<JobRow>(
      `INSERT INTO jobs (type, workspace_id, acting_identity_id, payload, run_at, max_attempts)
       VALUES ($1, $2, $3, $4, COALESCE($5, now()), COALESCE($6, 5))
       RETURNING *`,
      [
        input.type,
        input.workspaceId ?? null,
        input.actingIdentityId ?? null,
        JSON.stringify(input.payload),
        input.runAt ?? null,
        input.maxAttempts ?? null,
      ],
    );
    return toJob(res.rows[0]!);
  }

  async claim(pool: pg.Pool, workerId: string, types?: JobType[]): Promise<Job | null> {
    const res = await pool.query<JobRow>(
      `WITH next AS (
         SELECT id FROM jobs
         WHERE status = 'QUEUED' AND run_at <= now()
           AND ($1::text[] IS NULL OR type = ANY($1))
         ORDER BY run_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs j SET status = 'RUNNING', locked_at = now(), locked_by = $2, attempts = attempts + 1
       FROM next WHERE j.id = next.id
       RETURNING j.*`,
      [types ?? null, workerId],
    );
    return res.rows[0] ? toJob(res.rows[0]) : null;
  }

  async succeed(pool: pg.Pool, jobId: string): Promise<void> {
    await pool.query(
      `UPDATE jobs SET status = 'SUCCEEDED', finished_at = now(), locked_at = NULL, locked_by = NULL WHERE id = $1`,
      [jobId],
    );
  }

  async fail(pool: pg.Pool, jobId: string, error: string, backoffSeconds = 30): Promise<JobStatus> {
    const res = await pool.query<{ status: JobStatus }>(
      `UPDATE jobs SET
         status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'QUEUED' END,
         run_at = CASE WHEN attempts >= max_attempts THEN run_at ELSE now() + ($2::int * attempts) * interval '1 second' END,
         last_error = left($3, 4000),
         locked_at = NULL, locked_by = NULL,
         finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END
       WHERE id = $1 RETURNING status`,
      [jobId, backoffSeconds, error],
    );
    return res.rows[0]?.status ?? "FAILED";
  }

  async get(q: Queryable, jobId: string): Promise<Job | null> {
    const res = await q.query<JobRow>("SELECT * FROM jobs WHERE id = $1", [jobId]);
    return res.rows[0] ? toJob(res.rows[0]) : null;
  }
}

/* ------------------------------------------------------------------------ */
/* In-process domain event bus                                               */
/* ------------------------------------------------------------------------ */

export type DomainEventHandler = (event: DomainEvent) => void | Promise<void>;

export class EventBus {
  private readonly handlers = new Map<DomainEvent["type"] | "*", Set<DomainEventHandler>>();

  on(type: DomainEvent["type"] | "*", handler: DomainEventHandler): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
    return () => set.delete(handler);
  }

  async emit(event: DomainEvent): Promise<void> {
    const targets = [...(this.handlers.get(event.type) ?? []), ...(this.handlers.get("*") ?? [])];
    await Promise.allSettled(targets.map((h) => h(event)));
  }
}
