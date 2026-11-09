import { loadRootEnv } from "@ae/database";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createAppContext } from "./context.js";

loadRootEnv();

async function main() {
  const config = loadConfig();
  const ctx = await createAppContext(config);
  const app = await buildApp(ctx);

  const shutdown = async (signal: string) => {
    ctx.logger.info({ signal }, "shutting down");
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
