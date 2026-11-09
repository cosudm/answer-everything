import { loadRootEnv } from "@ae/database";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createAppContext } from "./context.js";

loadRootEnv();

async function main() {
  const config = loadConfig();

  // Single-container deployments: run the labelled development provider in
  // this process (never in prod) so the pipeline works before real provider
  // keys are configured. The registry seed points local-dev at it.
  if (process.env.AE_EMBEDDED_DEV_PROVIDER === "true" && !config.isProd) {
    const { createDevProviderServer } = await import("@ae/dev-provider");
    const port = Number(process.env.DEV_PROVIDER_PORT ?? 4100);
    await createDevProviderServer({ port, host: "127.0.0.1" });
  }

  const ctx = await createAppContext(config);
  const app = await buildApp(ctx);

  // Single-container deployments: run the job runner in-process instead of a
  // separate worker. Same code path as apps/worker; one less process.
  if (process.env.AE_EMBEDDED_WORKER === "true") {
    void ctx.jobRunner.runForever(Number(process.env.AE_WORKER_POLL_MS ?? 1500)).catch((err) => {
      ctx.logger.error({ err }, "embedded job runner stopped");
    });
    ctx.logger.info("embedded job runner started");
  }

  const shutdown = async (signal: string) => {
    ctx.logger.info({ signal }, "shutting down");
    ctx.jobRunner.stop();
    await app.close();
    await ctx.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.API_PORT, host: config.API_HOST });
  ctx.logger.info(
    {
      url: config.API_PUBLIC_URL,
      env: config.AE_ENV,
      inlineJobs: config.AE_INLINE_JOBS,
      embeddingModel: ctx.embeddingModelVersionId ?? "none",
    },
    "Answer Everything API ready",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
