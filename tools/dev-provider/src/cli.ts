import { loadRootEnv } from "@ae/database";
import { createDevProviderServer } from "./server.js";

loadRootEnv();
const port = Number(process.env.DEV_PROVIDER_PORT ?? 4100);
createDevProviderServer({ port, host: "127.0.0.1" }).then((s) => {
  console.log(`[dev-provider] OpenAI-compatible stub listening at ${s.url} (models: dev-echo-1, dev-embed-1536)`);
  console.log("[dev-provider] This is a deterministic development stub, not a language model.");
});
