import { loadRootEnv } from "./env.js";
loadRootEnv();
import pg from "pg";
import {
  appliedMigrations,
  ensureRoles,
  listMigrationFiles,
  migrate,
  resetSchema,
} from "./migrate.js";

async function main() {
  const command = process.argv[2] ?? "migrate";
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  try {
    switch (command) {
      case "migrate": {
        await ensureRoles(pool, rolesFromEnv());
        const result = await migrate(pool);
        console.log(`applied: ${result.applied.length ? result.applied.join(", ") : "(none)"}`);
        console.log(`already applied: ${result.skipped.length}`);
        break;
      }
      case "reset": {
        if ((process.env.AE_ENV ?? "dev") === "prod")
          throw new Error("refusing to reset a prod database");
        await resetSchema(pool);
        await ensureRoles(pool, rolesFromEnv());
        const result = await migrate(pool);
        console.log(`schema reset; applied ${result.applied.length} migrations`);
        break;
      }
      case "status": {
        const files = await listMigrationFiles();
        const applied = new Set((await appliedMigrations(pool)).map((m) => m.name));
        for (const f of files) console.log(`${applied.has(f) ? "[x]" : "[ ]"} ${f}`);
        break;
      }
      default:
        throw new Error(`unknown command ${command}`);
    }
  } finally {
    await pool.end();
  }
}

function rolesFromEnv() {
  const appPassword = process.env.AE_DB_APP_PASSWORD;
  const identityPassword = process.env.AE_DB_IDENTITY_PASSWORD;
  if (!appPassword || !identityPassword) {
    throw new Error("AE_DB_APP_PASSWORD and AE_DB_IDENTITY_PASSWORD are required to create roles");
  }
  return { appPassword, identityPassword };
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
