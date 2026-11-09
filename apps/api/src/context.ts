import { AuthorizationService, DatabaseFactsLoader } from "@ae/authorization";
import { createDatabase, databaseConfigFromEnv, withTenant, type Database } from "@ae/database";
import { EventBus, PostgresJobQueue, type JobQueue } from "@ae/events";
import { IdentityService } from "@ae/identity";
import { DefaultModelGateway, EnvCredentialBroker, type ModelGateway } from "@ae/model-gateway";
import { findModelByName, getModel } from "@ae/model-registry";
import { createLogger, type Logger } from "@ae/observability";
import { JobRunner, LedgerBudgetGuard, PLATFORM_SERVICE_IDENTITY_ID } from "@ae/orchestration";
import type { ApiConfig } from "./config.js";

export interface AppContext {
  config: ApiConfig;
  db: Database;
  logger: Logger;
  identity: IdentityService;
  authz: AuthorizationService;
  gateway: ModelGateway;
  queue: JobQueue;
  events: EventBus;
  jobRunner: JobRunner;
  /** Resolved at startup from AE_EMBEDDING_MODEL ("provider-slug/model-name"). */
  embeddingModelVersionId: string | null;
  close(): Promise<void>;
}

export async function createAppContext(
  config: ApiConfig,
  overrides: Partial<Pick<AppContext, "db" | "logger">> = {},
): Promise<AppContext> {
  const logger = overrides.logger ?? createLogger({ name: "ae-api", level: config.LOG_LEVEL });
  const db = overrides.db ?? createDatabase({ ...databaseConfigFromEnv(), max: 12 });

  const identity = new IdentityService(
    db,
    {
      sessionSecret: config.AE_SESSION_SECRET,
      sessionTtlMinutes: config.AE_SESSION_TTL_MINUTES,
      refreshTtlDays: config.AE_REFRESH_TTL_DAYS,
      defaultWorkspaceBudgetUsd: config.AE_DEFAULT_WORKSPACE_MONTHLY_BUDGET_USD,
    },
    logger,
  );
  const authz = new AuthorizationService(new DatabaseFactsLoader(), logger, db.app);

  // Registry lookups for the gateway run as the platform service identity;
  // model_versions/providers are platform-global tables (no RLS).
  const resolver = {
    resolve: async (id: string) => {
      const r = await withTenant(
        db.app,
        { userId: null, workspaceId: null, identityId: PLATFORM_SERVICE_IDENTITY_ID },
        (tx) => getModel(tx, id),
      );
      return r ? { model: r.model, provider: r.provider } : null;
    },
  };
  const gateway = new DefaultModelGateway({
    resolver,
    credentials: new EnvCredentialBroker(),
    budget: new WorkspaceOwnerBudgetGuard(db),
    logger,
    allowLocalDeployments: !config.isProd,
  });

  const queue = new PostgresJobQueue();
  const events = new EventBus();

  const [slug, name] = config.AE_EMBEDDING_MODEL.split("/");
  let embeddingModelVersionId: string | null = null;
  if (slug && name) {
    const found = await withTenant(
      db.app,
      { userId: null, workspaceId: null, identityId: PLATFORM_SERVICE_IDENTITY_ID },
      (tx) => findModelByName(tx, slug, name, null),
    );
    if (found && found.model.enabled && found.provider.enabled)
      embeddingModelVersionId = found.model.id;
    else
      logger.warn(
        { embeddingModel: config.AE_EMBEDDING_MODEL },
        "embedding model not available; retrieval will be lexical only",
      );
  }

  const jobRunner = new JobRunner({
    db,
    queue,
    gateway,
    logger,
    embeddingModelVersionId,
    events,
    workerId: "api-inline",
  });

  return {
    config,
    db,
    logger,
    identity,
    authz,
    gateway,
    queue,
    events,
    jobRunner,
    embeddingModelVersionId,
    close: () => db.close(),
  };
}

/**
 * The ledger guard needs a user context to pass RLS. The gateway only knows
 * the workspace id, so we look up the workspace owner through the identity
 * pool (BYPASSRLS, read-only here) and evaluate the budget as that owner.
 */
class WorkspaceOwnerBudgetGuard {
  constructor(private readonly db: Database) {}
  async check(workspaceId: string, estimatedCostUsd: number | null) {
    const owner = await this.db.identity.query(
      "SELECT owner_user_id FROM workspaces WHERE id = $1 AND deleted_at IS NULL",
      [workspaceId],
    );
    const ownerId: string | undefined = owner.rows[0]?.owner_user_id;
    if (!ownerId) return { allowed: false, remainingUsd: null, reason: "workspace not found" };
    const guard = new LedgerBudgetGuard(this.db.app, () => ({
      userId: ownerId,
      identityId: PLATFORM_SERVICE_IDENTITY_ID,
    }));
    return guard.check(workspaceId, estimatedCostUsd);
  }
}
