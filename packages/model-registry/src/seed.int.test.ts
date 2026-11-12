import { databaseAvailable, openTestDatabase, truncateAll, type Database } from "@ae/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedRegistry } from "./seed.js";

const describeDb = databaseAvailable() ? describe : describe.skip;

function seedFile(displayName = "Seed Test Model") {
  return {
    providers: [
      {
        slug: "seed-test",
        kind: "OPENAI_COMPATIBLE",
        adapter: "openai-compatible",
        displayName: "Seed Test Provider",
        baseUrl: "http://127.0.0.1:9/v1",
        credentialRef: null,
        dataHandling: { trainsOnData: false, retentionDays: 0, region: "local" },
        enabled: true,
        devOnly: false,
        models: [
          {
            // No version label: the case the original unique constraint missed.
            providerModelName: "seed-test-1",
            displayName,
            deploymentType: "LOCAL",
            behavioralProfile: "STANDARD",
            capabilities: ["CHAT"],
            privacyClassesAllowed: ["PUBLIC"],
            evaluationStatus: "TESTING",
            contextWindow: 8000,
          },
          {
            providerModelName: "seed-test-1",
            displayName: `${displayName} v2`,
            version: "2",
            deploymentType: "LOCAL",
            behavioralProfile: "STANDARD",
            capabilities: ["CHAT"],
            privacyClassesAllowed: ["PUBLIC"],
            evaluationStatus: "TESTING",
            contextWindow: 8000,
          },
        ],
      },
    ],
  };
}

/**
 * The container entrypoint seeds the registry on every start, so seeding must
 * be repeatable: same rows, same ids, no copies.
 */
describeDb("model registry seed", () => {
  let db: Database;
  const opts = { env: {}, aeEnv: "test" };

  beforeAll(async () => {
    db = openTestDatabase();
    await truncateAll(db);
  });
  afterAll(async () => {
    await truncateAll(db);
    await db.close();
  });

  async function rows() {
    const res = await db.migrator.query<{
      id: string;
      version: string | null;
      display_name: string;
    }>(
      `SELECT mv.id, mv.version, mv.display_name
       FROM model_versions mv JOIN providers p ON p.id = mv.provider_id
       WHERE p.slug = 'seed-test' ORDER BY mv.version NULLS FIRST`,
    );
    return res.rows;
  }

  it("re-seeding keeps one row per model, including models without a version label", async () => {
    const first = await seedRegistry(db.migrator, seedFile(), opts);
    const afterFirst = await rows();
    expect(afterFirst.map((r) => r.version)).toEqual([null, "2"]);

    const second = await seedRegistry(db.migrator, seedFile(), opts);
    const afterSecond = await rows();
    expect(afterSecond).toEqual(afterFirst);
    expect(second.models.map((m) => m.id)).toEqual(first.models.map((m) => m.id));
  });

  it("a changed definition updates the existing row in place", async () => {
    const before = await rows();
    await seedRegistry(db.migrator, seedFile("Renamed Model"), opts);
    const after = await rows();
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.display_name)).toEqual(["Renamed Model", "Renamed Model v2"]);
  });

  it("the database itself refuses a second row for the same unlabelled model", async () => {
    await expect(
      db.migrator.query(
        `INSERT INTO model_versions
           (provider_id, provider_model_name, display_name, deployment_type, behavioral_profile, context_window)
         SELECT provider_id, provider_model_name, 'copy', deployment_type, behavioral_profile, context_window
         FROM model_versions WHERE provider_model_name = 'seed-test-1' AND version IS NULL`,
      ),
    ).rejects.toThrow(/model_versions_identity_key/);
  });
});
