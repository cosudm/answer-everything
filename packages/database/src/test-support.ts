import pg from "pg";
import { createDatabase, databaseConfigFromEnv, type Database } from "./client.js";
import { ensureRoles, migrate, resetSchema } from "./migrate.js";

/**
 * Test helpers shared by integration and authorization suites. They require a
 * live PostgreSQL with pgvector; `describeWithDatabase` makes the absence of
 * DATABASE_URL an explicit skip, never a silent pass.
 */
export function databaseAvailable(): boolean {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_APP_URL && process.env.DATABASE_IDENTITY_URL);
}

export async function prepareTestDatabase(): Promise<void> {
  const config = databaseConfigFromEnv();
  const pool = new pg.Pool({ connectionString: config.migratorUrl, max: 2 });
  try {
    await resetSchema(pool);
    await ensureRoles(pool, {
      appPassword: process.env.AE_DB_APP_PASSWORD ?? "ae_app_dev_password",
      identityPassword: process.env.AE_DB_IDENTITY_PASSWORD ?? "ae_identity_dev_password",
    });
    await migrate(pool);
  } finally {
    await pool.end();
  }
}

export function openTestDatabase(): Database {
  return createDatabase({ ...databaseConfigFromEnv(), max: 4 });
}

/** Removes all tenant data between tests while keeping schema and roles. */
export async function truncateAll(db: Database): Promise<void> {
  await db.migrator.query(`
    TRUNCATE TABLE
      usage_ledger, evaluation_results, evaluation_runs, evaluation_cases, evaluation_suites,
      research_tasks, answer_claims, citations, answer_records, model_runs, context_manifests,
      messages, conversations, knowledge_chunks, knowledge_objects, projects,
      authorization_decisions, provenance_records, audit_events, jobs,
      sessions, login_attempts, workspace_memberships, workspaces,
      model_status_changes, model_versions, providers
    RESTART IDENTITY CASCADE`);
  await db.migrator.query(`DELETE FROM acting_identities WHERE kind <> 'SERVICE'`);
  await db.migrator.query(`DELETE FROM users`);
  // TRUNCATE ... CASCADE reaches acting_identities through its model_versions FK;
  // restore the platform service identity the worker and seeds depend on.
  await db.migrator.query(
    `INSERT INTO acting_identities (id, kind, display_name)
     VALUES ('00000000-0000-0000-0000-000000000001', 'SERVICE', 'Answer Everything Platform')
     ON CONFLICT (id) DO NOTHING`,
  );
}
