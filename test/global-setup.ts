import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Global setup for the integration and authorization projects. Loads
 * .env.test (falling back to .env), then resets and migrates the test
 * database once per run. If no database is configured, it prints a clear
 * message; the suites themselves then skip with the same message.
 */
export default async function globalSetup() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  loadEnv({ path: path.join(root, ".env.test") });
  loadEnv({ path: path.join(root, ".env") });

  if (!process.env.DATABASE_URL) {
    console.warn(
      "\n[test] DATABASE_URL is not set. Integration and authorization tests will be SKIPPED.\n" +
        "       Start PostgreSQL with pgvector and copy .env.example to .env.test to run them.\n",
    );
    return;
  }
  const { prepareTestDatabase } = await import("../packages/database/src/test-support.js");
  await prepareTestDatabase();
  console.log("[test] database reset and migrated");
}
