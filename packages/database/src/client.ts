import pg from "pg";

const { Pool, types } = pg;

// Keep numerics as strings by default except the ones we know are safe.
types.setTypeParser(20, (v) => Number(v)); // int8
types.setTypeParser(1700, (v) => Number(v)); // numeric
types.setTypeParser(700, (v) => Number(v)); // float4

export type Queryable = Pick<pg.PoolClient, "query">;
export type Tx = pg.PoolClient;

export interface DatabaseConfig {
  /** Owner / migrator connection. */
  migratorUrl: string;
  /** ae_app connection (RLS enforced). */
  appUrl: string;
  /** ae_identity connection (identity tables only). */
  identityUrl: string;
  max?: number;
}

export interface Database {
  migrator: pg.Pool;
  app: pg.Pool;
  identity: pg.Pool;
  close(): Promise<void>;
}

export function createDatabase(config: DatabaseConfig): Database {
  const max = config.max ?? 10;
  const migrator = new Pool({ connectionString: config.migratorUrl, max: 2 });
  const app = new Pool({ connectionString: config.appUrl, max });
  const identity = new Pool({
    connectionString: config.identityUrl,
    max: Math.max(2, Math.floor(max / 2)),
  });
  for (const p of [migrator, app, identity]) {
    p.on("error", (err) => {
      // Idle client errors must not crash the process; they surface on next use.
      console.error("[database] idle client error", err.message);
    });
  }
  return {
    migrator,
    app,
    identity,
    async close() {
      await Promise.all([migrator.end(), app.end(), identity.end()]);
    },
  };
}

export function databaseConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const migratorUrl = env.DATABASE_URL;
  const appUrl = env.DATABASE_APP_URL;
  const identityUrl = env.DATABASE_IDENTITY_URL;
  if (!migratorUrl || !appUrl || !identityUrl) {
    throw new Error(
      "DATABASE_URL, DATABASE_APP_URL and DATABASE_IDENTITY_URL must all be set (see .env.example)",
    );
  }
  return { migratorUrl, appUrl, identityUrl };
}

/**
 * Request context for RLS. All three are required for workspace-scoped work.
 * `workspaceId` may be null for account-level operations (then only the
 * user/identity-scoped policies apply).
 */
export interface TenantContext {
  userId: string | null;
  workspaceId: string | null;
  identityId: string;
}

/**
 * Runs `fn` inside a transaction on the ae_app pool with the tenant context
 * applied via transaction-local settings. This is the ONLY sanctioned way to
 * touch workspace-scoped tables.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [ctx.userId ?? ""]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [ctx.workspaceId ?? ""]);
    await client.query("SELECT set_config('app.identity_id', $1, true)", [ctx.identityId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Plain transaction without tenant context (identity pool / migrator). */
export async function withTransaction<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

export function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function isoRequired(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** pgvector literal: '[0.1,0.2,...]' */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((v) => (Number.isFinite(v) ? v : 0)).join(",")}]`;
}
