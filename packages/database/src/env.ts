import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Loads environment files from the repository root regardless of the current
 * working directory (pnpm runs package scripts inside the package folder).
 * Order: .env.<AE_ENV> then .env. Existing process variables always win.
 */
export function loadRootEnv(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
      const envName = process.env.AE_ENV;
      if (envName && existsSync(path.join(dir, `.env.${envName}`))) {
        loadDotenv({ path: path.join(dir, `.env.${envName}`) });
      }
      loadDotenv({ path: path.join(dir, ".env") });
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
