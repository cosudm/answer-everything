import { createDatabase, databaseConfigFromEnv, loadRootEnv } from "@ae/database";
import path from "node:path";
import { seedRegistryFromFile } from "./seed.js";

const root = loadRootEnv();
async function main() {
  const db = createDatabase(databaseConfigFromEnv());
  try {
    const seedPath = path.resolve(
      root ?? process.cwd(),
      process.env.AE_MODEL_SEED_PATH ?? "config/models.seed.json",
    );
    const result = await seedRegistryFromFile(db.migrator, seedPath, {
      env: process.env,
      aeEnv: process.env.AE_ENV ?? "dev",
    });
    console.log(
      `providers: ${result.providers.map((p) => `${p.slug}${p.enabled ? "" : " (disabled)"}`).join(", ")}`,
    );
    console.log(`models: ${result.models.map((m) => m.displayName).join(", ")}`);
    if (result.skipped.length) console.log(`skipped: ${result.skipped.join("; ")}`);
  } finally {
    await db.close();
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
