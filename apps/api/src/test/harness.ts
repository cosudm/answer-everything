import { openTestDatabase, truncateAll, type Database } from "@ae/database";
import { createDevProviderServer, type DevProviderServer } from "@ae/dev-provider";
import { seedRegistry } from "@ae/model-registry";
import { createLogger } from "@ae/observability";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadConfig, type ApiConfig } from "../config.js";
import { createAppContext, type AppContext } from "../context.js";

export interface Harness {
  app: FastifyInstance;
  ctx: AppContext;
  db: Database;
  provider: DevProviderServer;
  config: ApiConfig;
  close(): Promise<void>;
  reset(): Promise<void>;
  /** Registers a user and returns the cookie header + workspace id. */
  signUp(
    email: string,
    displayName?: string,
  ): Promise<{ cookie: string; userId: string; workspaceId: string; accessToken: string }>;
  /** Collects SSE events from a streaming endpoint. */
  stream(
    path: string,
    cookie: string,
    body: Record<string, unknown>,
  ): Promise<Array<Record<string, any>>>;
}

/** Registry seed used by tests: the in-process dev stub plus a dead provider for fallback tests. */
export function testSeed(providerUrl: string) {
  return {
    providers: [
      {
        slug: "dead-provider",
        kind: "OPENAI_COMPATIBLE",
        adapter: "openai-compatible",
        displayName: "Dead provider (unreachable, for fallback tests)",
        baseUrl: "http://127.0.0.1:1/v1",
        credentialRef: null,
        dataHandling: { trainsOnData: false, retentionDays: 0, region: "test" },
        enabled: true,
        models: [
          {
            providerModelName: "dead-1",
            displayName: "Dead Model",
            deploymentType: "DEDICATED_ENDPOINT",
            behavioralProfile: "STANDARD",
            capabilities: ["chat", "streaming", "reasoning"],
            privacyClassesAllowed: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
            evaluationStatus: "APPROVED",
            contextWindow: 32000,
            inputCostPerMillion: 0,
            outputCostPerMillion: 0,
            metadata: { routingPriority: 500 },
          },
        ],
      },
      {
        slug: "local-dev",
        kind: "LOCAL_DEV",
        adapter: "openai-compatible",
        displayName: "Local development provider (stub)",
        baseUrl: providerUrl,
        credentialRef: null,
        dataHandling: { trainsOnData: false, retentionDays: 0, region: "local" },
        enabled: true,
        models: [
          {
            providerModelName: "dev-echo-1",
            displayName: "Local Development Model (stub)",
            deploymentType: "LOCAL",
            behavioralProfile: "STANDARD",
            capabilities: ["chat", "streaming", "json"],
            privacyClassesAllowed: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
            evaluationStatus: "TESTING",
            contextWindow: 32000,
            maxOutputTokens: 2048,
            inputCostPerMillion: 1,
            outputCostPerMillion: 2,
            metadata: { stub: true, routingPriority: -100 },
          },
          {
            providerModelName: "dev-embed-1536",
            displayName: "Local Development Embedder (hashing)",
            deploymentType: "LOCAL",
            behavioralProfile: "STANDARD",
            capabilities: ["embeddings"],
            privacyClassesAllowed: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
            evaluationStatus: "TESTING",
            contextWindow: 8192,
            embeddingDimensions: 1536,
            inputCostPerMillion: 0,
            outputCostPerMillion: 0,
          },
        ],
      },
      {
        slug: "anthropic",
        kind: "ANTHROPIC",
        adapter: "anthropic",
        displayName: "Anthropic",
        baseUrl: "https://api.anthropic.com",
        credentialRef: "ANTHROPIC_API_KEY_TEST_UNSET",
        dataHandling: { trainsOnData: false, retentionDays: 30, region: "US" },
        enabled: true,
        models: [
          {
            providerModelName: "claude-test",
            displayName: "Claude (unconfigured in tests)",
            deploymentType: "COMMERCIAL_API",
            behavioralProfile: "PROFESSIONAL",
            capabilities: ["chat", "streaming", "reasoning"],
            privacyClassesAllowed: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
            evaluationStatus: "APPROVED",
            contextWindow: 200000,
            inputCostPerMillion: 10,
            outputCostPerMillion: 50,
            metadata: { routingPriority: 1000 },
          },
        ],
      },
    ],
  };
}

export async function createHarness(
  opts: { allowExperimentalByDefault?: boolean; deadProvider?: boolean } = {},
): Promise<Harness> {
  const provider = await createDevProviderServer({ tokenDelayMs: 0 });
  const config = loadConfig({
    ...process.env,
    AE_ENV: "test",
    AE_SESSION_SECRET: "test-session-secret-test-session-secret-0123456789",
    AE_DEFAULT_ALLOW_EXPERIMENTAL: String(opts.allowExperimentalByDefault ?? true),
    AE_INLINE_JOBS: "false",
    AE_EMBEDDING_MODEL: "local-dev/dev-embed-1536",
    LOG_LEVEL: "silent",
    WEB_PUBLIC_URL: "http://localhost:3000",
  });
  const db = openTestDatabase();
  await truncateAll(db);
  const seed = testSeed(provider.url);
  if (opts.deadProvider === false)
    seed.providers = seed.providers.filter((p) => p.slug !== "dead-provider");
  await seedRegistry(db.migrator, seed, { env: process.env, aeEnv: "test" });
  const logger = createLogger({ name: "test", level: "silent", pretty: false });
  const ctx = await createAppContext(config, { db, logger });
  const app = await buildApp(ctx);
  await app.ready();

  const harness: Harness = {
    app,
    ctx,
    db,
    provider,
    config,
    async close() {
      await app.close();
      await db.close();
      await provider.close();
    },
    async reset() {
      await truncateAll(db);
      await seedRegistry(db.migrator, seed, { env: process.env, aeEnv: "test" });
    },
    async signUp(email, displayName = "Test User") {
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/register",
        payload: { email, password: "a long and sturdy passphrase", displayName },
      });
      if (res.statusCode !== 201) throw new Error(`register failed: ${res.statusCode} ${res.body}`);
      const body = res.json();
      const cookie = res.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      return {
        cookie,
        userId: body.user.id,
        workspaceId: body.workspace.id,
        accessToken: body.accessToken,
      };
    },
    async stream(path, cookie, body) {
      const res = await app.inject({
        method: "POST",
        url: path,
        headers: { cookie, "content-type": "application/json" },
        payload: body,
      });
      if (res.statusCode !== 200) throw new Error(`stream failed: ${res.statusCode} ${res.body}`);
      return res.body
        .split("\n")
        .filter((l: string) => l.startsWith("data:"))
        .map((l: string) => JSON.parse(l.slice(5)) as Record<string, any>);
    },
  };
  return harness;
}
