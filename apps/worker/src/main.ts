import { createDatabase, databaseConfigFromEnv, loadRootEnv, withTenant } from "@ae/database";
import { EventBus, PostgresJobQueue } from "@ae/events";
import { DefaultModelGateway, EnvCredentialBroker } from "@ae/model-gateway";
import { findModelByName, getModel } from "@ae/model-registry";
import { createLogger } from "@ae/observability";
import { JobRunner, PLATFORM_SERVICE_IDENTITY_ID } from "@ae/orchestration";
import { hostname } from "node:os";

loadRootEnv();

/**
 * Asynchronous worker. Claims jobs from the PostgreSQL queue (SKIP LOCKED)
 * and runs them under the requesting user's workspace context through the
 * platform service identity. Horizontally scalable: run several replicas.
 */
async function main() {
  const logger = createLogger({ name: "ae-worker", level: process.env.LOG_LEVEL ?? "info" });
  const db = createDatabase({ ...databaseConfigFromEnv(), max: 6 });
  const isProd = (process.env.AE_ENV ?? "dev") === "prod";
  const platformCtx = { userId: null, workspaceId: null, identityId: PLATFORM_SERVICE_IDENTITY_ID };

  const gateway = new DefaultModelGateway({
    resolver: {
      resolve: async (id) => {
        const r = await withTenant(db.app, platformCtx, (tx) => getModel(tx, id));
        return r ? { model: r.model, provider: r.provider } : null;
      },
    },
    credentials: new EnvCredentialBroker(),
    logger,
    allowLocalDeployments: !isProd,
  });

  const [slug, name] = (process.env.AE_EMBEDDING_MODEL ?? "local-dev/dev-embed-1536").split("/");
  const embedding = slug && name ? await withTenant(db.app, platformCtx, (tx) => findModelByName(tx, slug, name, null)) : null;
  const embeddingModelVersionId = embedding && embedding.model.enabled && embedding.provider.enabled ? embedding.model.id : null;
  if (!embeddingModelVersionId) logger.warn("no embedding model available; ingestion will index lexically only");

  const runner = new JobRunner({
    db,
    queue: new PostgresJobQueue(),
    gateway,
    logger,
    embeddingModelVersionId,
    events: new EventBus(),
    workerId: `${hostname()}-${process.pid}`,
  });

  const stop = async () => {
    logger.info("worker stopping");
    runner.stop();
    setTimeout(async () => {
      await db.close();
      process.exit(0);
    }, 500);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  logger.info({ embeddingModel: embeddingModelVersionId ?? "none" }, "Answer Everything worker ready");
  await runner.runForever(Number(process.env.AE_WORKER_POLL_MS ?? 1000));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
