import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, "../migrations");

export interface MigrationRecord {
  name: string;
  checksum: string;
  appliedAt: string;
}

export interface RoleConfig {
  appPassword: string;
  identityPassword: string;
}

/**
 * Creates the two application roles idempotently. Passwords come from the
 * environment, which is why this lives in code rather than a SQL file.
 */
export async function ensureRoles(pool: pg.Pool, roles: RoleConfig): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ae_app') THEN
          CREATE ROLE ae_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ae_identity') THEN
          CREATE ROLE ae_identity LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
        END IF;
      END $$;`);
    // Password changes are safe to repeat.
    await client.query(`ALTER ROLE ae_app WITH PASSWORD '${escapeLiteral(roles.appPassword)}'`);
    await client.query(
      `ALTER ROLE ae_identity WITH PASSWORD '${escapeLiteral(roles.identityPassword)}'`,
    );
  } finally {
    client.release();
  }
}

function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function ensureMigrationsTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
}

export async function listMigrationFiles(dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = await readdir(dir);
  return files.filter((f) => f.endsWith(".sql")).sort();
}

export async function appliedMigrations(pool: pg.Pool): Promise<MigrationRecord[]> {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const res = await client.query<{ name: string; checksum: string; applied_at: Date }>(
      "SELECT name, checksum, applied_at FROM schema_migrations ORDER BY name",
    );
    return res.rows.map((r) => ({
      name: r.name,
      checksum: r.checksum,
      appliedAt: r.applied_at.toISOString(),
    }));
  } finally {
    client.release();
  }
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies pending migrations in order, each in its own transaction, and
 * refuses to continue if an already-applied file has changed (checksum drift).
 */
export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<MigrateResult> {
  const files = await listMigrationFiles(dir);
  const applied = new Map((await appliedMigrations(pool)).map((m) => [m.name, m]));
  const result: MigrateResult = { applied: [], skipped: [] };

  for (const file of files) {
    const sql = await readFile(path.join(dir, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const existing = applied.get(file);
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error(
          `Migration ${file} has changed since it was applied (checksum drift). Create a new migration instead.`,
        );
      }
      result.skipped.push(file);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
        file,
        checksum,
      ]);
      await client.query("COMMIT");
      result.applied.push(file);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return result;
}

/** Drops and recreates the public schema. Development and test only. */
export async function resetSchema(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.query("GRANT ALL ON SCHEMA public TO public");
  } finally {
    client.release();
  }
}
