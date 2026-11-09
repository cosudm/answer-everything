import type { Queryable } from "@ae/database";
import { isoRequired } from "@ae/database";
import type { EvaluationCase, EvaluationRun, EvaluationSuite } from "@ae/domain";
import type { ModelGateway } from "@ae/model-gateway";
import type { Logger } from "@ae/observability";
import { graders } from "./graders.js";

export interface SuiteDefinition {
  slug: string;
  name: string;
  category: EvaluationSuite["category"];
  description: string;
  version: string;
  cases: Array<Omit<EvaluationCase, "id" | "suiteId">>;
}

/** Upserts a suite and its cases; returns the suite id. */
export async function upsertSuite(q: Queryable, def: SuiteDefinition): Promise<string> {
  const s = await q.query(
    `INSERT INTO evaluation_suites (slug, name, category, description, version) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category,
       description = EXCLUDED.description, version = EXCLUDED.version
     RETURNING id`,
    [def.slug, def.name, def.category, def.description, def.version],
  );
  const suiteId: string = s.rows[0].id;
  for (const c of def.cases) {
    await q.query(
      `INSERT INTO evaluation_cases (suite_id, name, input, grader, expected, tags, weight) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (suite_id, name) DO UPDATE SET input = EXCLUDED.input, grader = EXCLUDED.grader,
         expected = EXCLUDED.expected, tags = EXCLUDED.tags, weight = EXCLUDED.weight`,
      [
        suiteId,
        c.name,
        JSON.stringify(c.input),
        c.grader,
        JSON.stringify(c.expected),
        c.tags,
        c.weight,
      ],
    );
  }
  return suiteId;
}

export interface RunSuiteOptions {
  suiteSlug: string;
  modelVersionId: string;
  baselineModelVersionId?: string | null;
  /** Workspace used for RLS/budget accounting of evaluation runs (platform workspace). */
  workspaceId: string;
  actingIdentityId: string;
  gateway: ModelGateway;
  logger: Logger;
  /** Persist model_runs rows through this hook so evaluation spend is visible. */
  recordModelRun?: (info: {
    purpose: "EVALUATION";
    modelVersionId: string;
    usage: unknown;
    costUsd: number | null;
    latencyMs: number;
  }) => Promise<string | null>;
}

/**
 * Runs every case of a suite against a model through the gateway and stores
 * per-case results plus a summary. Scores on the Model Lab screen come from
 * these rows; nothing is invented.
 */
export async function runSuite(q: Queryable, opts: RunSuiteOptions): Promise<EvaluationRun> {
  const suiteRow = await q.query("SELECT * FROM evaluation_suites WHERE slug = $1", [
    opts.suiteSlug,
  ]);
  if (!suiteRow.rows[0]) throw new Error(`suite ${opts.suiteSlug} not found`);
  const suite = suiteRow.rows[0];
  const cases = (
    await q.query("SELECT * FROM evaluation_cases WHERE suite_id = $1 ORDER BY name", [suite.id])
  ).rows;

  const runRow = await q.query(
    `INSERT INTO evaluation_runs (suite_id, suite_version, model_version_id, baseline_model_version_id, status, triggered_by_identity_id)
     VALUES ($1,$2,$3,$4,'RUNNING',$5) RETURNING *`,
    [
      suite.id,
      suite.version,
      opts.modelVersionId,
      opts.baselineModelVersionId ?? null,
      opts.actingIdentityId,
    ],
  );
  const runId: string = runRow.rows[0].id;

  let passed = 0;
  let weightSum = 0;
  let weighted = 0;
  let answerExpected = 0;
  let answerExpectedRefused = 0;
  let refusalExpected = 0;
  let refusalExpectedAnswered = 0;
  let error: string | null = null;

  try {
    for (const c of cases) {
      const input = c.input as {
        system: string | null;
        messages: Array<{ role: "user" | "assistant"; content: string }>;
      };
      const started = Date.now();
      let output = "";
      let refused = false;
      let errored = false;
      let modelRunId: string | null = null;
      try {
        const res = await opts.gateway.generate({
          modelVersionId: opts.modelVersionId,
          messages: input.messages,
          system: input.system ?? undefined,
          informationPrivacyClass: "PUBLIC",
          modelRunId: "00000000-0000-0000-0000-000000000000",
          workspaceId: opts.workspaceId,
          actingIdentityId: opts.actingIdentityId,
          temperature: 0,
          maxOutputTokens: 800,
        });
        output = res.text;
        refused = Boolean(res.refusal);
        errored = Boolean(res.error);
        if (opts.recordModelRun) {
          modelRunId = await opts.recordModelRun({
            purpose: "EVALUATION",
            modelVersionId: opts.modelVersionId,
            usage: res.usage,
            costUsd: res.estimatedCostUsd,
            latencyMs: res.latencyMs,
          });
        }
      } catch (err) {
        errored = true;
        output = "";
        opts.logger.warn({ err, case: c.name }, "evaluation case errored");
      }
      const grader = graders[c.grader as keyof typeof graders];
      const grade = grader
        ? grader({ output, refused, errored, expected: c.expected })
        : { passed: false, score: 0, details: { error: `grader ${c.grader} not available` } };
      if (c.grader === "answer_expected") {
        answerExpected++;
        if (refused || (grade.details as { declined?: boolean }).declined) answerExpectedRefused++;
      }
      if (c.grader === "refusal_expected") {
        refusalExpected++;
        if (!grade.passed) refusalExpectedAnswered++;
      }
      if (grade.passed) passed++;
      weightSum += Number(c.weight);
      weighted += grade.score * Number(c.weight);
      await q.query(
        `INSERT INTO evaluation_results (run_id, case_id, model_run_id, passed, score, output, details) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          runId,
          c.id,
          modelRunId,
          grade.passed,
          grade.score,
          output.slice(0, 20_000),
          JSON.stringify({ ...grade.details, latencyMs: Date.now() - started, refused, errored }),
        ],
      );
    }
  } catch (err) {
    error = (err as Error).message;
  }

  const summary = {
    cases: cases.length,
    passed,
    failed: cases.length - passed,
    weightedScore: weightSum ? Math.round((weighted / weightSum) * 1000) / 1000 : 0,
    excessiveRefusalRate: answerExpected
      ? Math.round((answerExpectedRefused / answerExpected) * 1000) / 1000
      : null,
    missedRefusalRate: refusalExpected
      ? Math.round((refusalExpectedAnswered / refusalExpected) * 1000) / 1000
      : null,
  };
  const finished = await q.query(
    `UPDATE evaluation_runs SET status = $2, finished_at = now(), summary = $3, error = $4 WHERE id = $1 RETURNING *`,
    [runId, error ? "FAILED" : "COMPLETED", JSON.stringify(summary), error],
  );
  const r = finished.rows[0];
  return {
    id: r.id,
    suiteId: r.suite_id,
    suiteVersion: r.suite_version,
    modelVersionId: r.model_version_id,
    baselineModelVersionId: r.baseline_model_version_id,
    status: r.status,
    startedAt: isoRequired(r.started_at),
    finishedAt: r.finished_at ? isoRequired(r.finished_at) : null,
    summary: r.summary,
    triggeredByIdentityId: r.triggered_by_identity_id,
    error: r.error,
  };
}

export async function listRunsForModel(
  q: Queryable,
  modelVersionId: string,
): Promise<Array<EvaluationRun & { suiteSlug: string; suiteName: string; category: string }>> {
  const res = await q.query(
    `SELECT r.*, s.slug AS suite_slug, s.name AS suite_name, s.category
     FROM evaluation_runs r JOIN evaluation_suites s ON s.id = r.suite_id
     WHERE r.model_version_id = $1 ORDER BY r.started_at DESC LIMIT 50`,
    [modelVersionId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    suiteId: r.suite_id,
    suiteVersion: r.suite_version,
    modelVersionId: r.model_version_id,
    baselineModelVersionId: r.baseline_model_version_id,
    status: r.status,
    startedAt: isoRequired(r.started_at),
    finishedAt: r.finished_at ? isoRequired(r.finished_at) : null,
    summary: r.summary,
    triggeredByIdentityId: r.triggered_by_identity_id,
    error: r.error,
    suiteSlug: r.suite_slug,
    suiteName: r.suite_name,
    category: r.category,
  }));
}
