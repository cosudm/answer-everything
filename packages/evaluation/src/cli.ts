import { createDatabase, databaseConfigFromEnv, loadRootEnv, withTenant } from "@ae/database";
import { DefaultModelGateway, EnvCredentialBroker } from "@ae/model-gateway";
import { findModelByName, getModel } from "@ae/model-registry";
import { createLogger } from "@ae/observability";
import { STARTER_SUITES } from "./suites.js";
import { runSuite, upsertSuite } from "./runner.js";

loadRootEnv();

/**
 * Operator CLI for the evaluation harness.
 *
 *   pnpm eval <suite-slug|all> <provider-slug>/<model-name> [--baseline <provider>/<model>]
 *
 * Runs as the platform operator (migrator connection, no RLS) and attributes
 * spend to the first workspace found unless AE_EVAL_WORKSPACE_ID is set.
 */
async function main() {
  const [suiteArg, modelArg, ...rest] = process.argv.slice(2);
  if (!suiteArg || !modelArg) {
    console.error(
      "usage: pnpm eval <suite-slug|all> <provider-slug>/<model-name> [--baseline <provider>/<model>]",
    );
    process.exit(1);
  }
  const baselineArg = rest.includes("--baseline") ? rest[rest.indexOf("--baseline") + 1] : null;
  const logger = createLogger({ name: "ae-eval", level: process.env.LOG_LEVEL ?? "info" });
  const db = createDatabase({ ...databaseConfigFromEnv(), max: 4 });
  const platformCtx = {
    userId: null,
    workspaceId: null,
    identityId: "00000000-0000-0000-0000-000000000001",
  };
  try {
    for (const def of STARTER_SUITES) await upsertSuite(db.migrator, def);

    const resolve = async (arg: string) => {
      const [slug, name] = arg.split("/");
      if (!slug || !name) throw new Error(`model must be <provider-slug>/<model-name>, got ${arg}`);
      const found = await withTenant(db.app, platformCtx, (tx) =>
        findModelByName(tx, slug, name, null),
      );
      if (!found) throw new Error(`model ${arg} is not registered`);
      return found;
    };
    const target = await resolve(modelArg);
    const baseline = baselineArg ? await resolve(baselineArg) : null;

    const gateway = new DefaultModelGateway({
      resolver: {
        resolve: async (id) => {
          const r = await withTenant(db.app, platformCtx, (tx) => getModel(tx, id));
          return r ? { model: r.model, provider: r.provider } : null;
        },
      },
      credentials: new EnvCredentialBroker(),
      logger,
      allowLocalDeployments: (process.env.AE_ENV ?? "dev") !== "prod",
    });

    const workspaceId =
      process.env.AE_EVAL_WORKSPACE_ID ??
      (
        await db.migrator.query(
          "SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1",
        )
      ).rows[0]?.id;
    if (!workspaceId)
      throw new Error("no workspace exists yet; register a user first or set AE_EVAL_WORKSPACE_ID");

    const slugs = suiteArg === "all" ? STARTER_SUITES.map((s) => s.slug) : [suiteArg];
    for (const slug of slugs) {
      const run = await runSuite(db.migrator, {
        suiteSlug: slug,
        modelVersionId: target.model.id,
        baselineModelVersionId: baseline?.model.id ?? null,
        workspaceId,
        actingIdentityId: platformCtx.identityId,
        gateway,
        logger,
      });
      const s = run.summary;
      console.log(
        `${slug}: ${run.status} · score ${s ? Math.round(s.weightedScore * 100) : "n/a"} · passed ${s?.passed}/${s?.cases}` +
          (s?.excessiveRefusalRate != null
            ? ` · over-refusal ${Math.round(s.excessiveRefusalRate * 100)}%`
            : "") +
          (s?.missedRefusalRate != null
            ? ` · missed-refusal ${Math.round(s.missedRefusalRate * 100)}%`
            : "") +
          (run.error ? ` · error: ${run.error}` : ""),
      );
    }
    console.log(
      `\nRuns are recorded for ${target.model.displayName}; approval still requires a platform admin decision.`,
    );
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
