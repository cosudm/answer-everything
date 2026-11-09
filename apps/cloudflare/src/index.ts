import { Container, getContainer } from "@cloudflare/containers";

/**
 * Answer Everything on Cloudflare: one Worker, two Containers, one origin.
 *
 * The API container runs Fastify plus the embedded job runner and, outside
 * prod, the labelled development provider. The web container runs the Next.js
 * standalone server built with NEXT_PUBLIC_API_URL="" so the browser calls the
 * API on the same origin (cookies are first-party, no CORS).
 *
 * Secrets never appear in this file. They are Worker secrets (dashboard ->
 * Settings -> Variables and Secrets) and are forwarded to the API container
 * as environment variables at start.
 */

interface Env {
  API: DurableObjectNamespace<ApiContainer>;
  WEB: DurableObjectNamespace<WebContainer>;
  AE_ENV: string;
  LOG_LEVEL: string;
  AE_EMBEDDED_WORKER: string;
  AE_EMBEDDED_DEV_PROVIDER: string;
  AE_DEFAULT_ALLOW_EXPERIMENTAL: string;
  AE_EMBEDDING_MODEL: string;
  AE_DEFAULT_WORKSPACE_MONTHLY_BUDGET_USD: string;
  // secrets
  DATABASE_URL?: string;
  DATABASE_APP_URL?: string;
  DATABASE_IDENTITY_URL?: string;
  AE_DB_APP_PASSWORD?: string;
  AE_DB_IDENTITY_PASSWORD?: string;
  AE_SESSION_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  XAI_API_KEY?: string;
  PERPLEXITY_API_KEY?: string;
  PRIVATE_INFERENCE_BASE_URL?: string;
  PRIVATE_INFERENCE_API_KEY?: string;
}

const FORWARDED_KEYS: Array<keyof Env> = [
  "AE_ENV",
  "LOG_LEVEL",
  "AE_EMBEDDED_WORKER",
  "AE_EMBEDDED_DEV_PROVIDER",
  "AE_DEFAULT_ALLOW_EXPERIMENTAL",
  "AE_EMBEDDING_MODEL",
  "AE_DEFAULT_WORKSPACE_MONTHLY_BUDGET_USD",
  "DATABASE_URL",
  "DATABASE_APP_URL",
  "DATABASE_IDENTITY_URL",
  "AE_DB_APP_PASSWORD",
  "AE_DB_IDENTITY_PASSWORD",
  "AE_SESSION_SECRET",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "PERPLEXITY_API_KEY",
  "PRIVATE_INFERENCE_BASE_URL",
  "PRIVATE_INFERENCE_API_KEY",
];

function containerEnv(env: Env, origin: string): Record<string, string> {
  const out: Record<string, string> = {
    API_HOST: "0.0.0.0",
    API_PORT: "4000",
    API_PUBLIC_URL: origin,
    WEB_PUBLIC_URL: origin,
    AE_COOKIE_SECURE: "true",
    AE_INLINE_JOBS: "false",
    AE_MIGRATIONS_DIR: "/app/migrations",
    AE_MODEL_SEED_PATH: "/app/config/models.seed.json",
    DEV_PROVIDER_BASE_URL: "http://127.0.0.1:4100/v1",
    DEV_PROVIDER_PORT: "4100",
    NODE_ENV: "production",
  };
  for (const key of FORWARDED_KEYS) {
    const v = env[key];
    if (typeof v === "string" && v !== "") out[key] = v;
  }
  return out;
}

export class ApiContainer extends Container<Env> {
  defaultPort = 4000;
  sleepAfter = "30m";
  override onError(error: unknown) {
    console.error("api container error", error);
  }
}

export class WebContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "30m";
  override onError(error: unknown) {
    console.error("web container error", error);
  }
}

const API_PREFIXES = ["/v1/", "/health", "/metrics"];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;
    const isApi = API_PREFIXES.some(
      (p) => url.pathname === p.replace(/\/$/, "") || url.pathname.startsWith(p),
    );

    if (isApi) {
      if (!env.DATABASE_URL || !env.AE_SESSION_SECRET) {
        return new Response(
          JSON.stringify({
            error: {
              code: "NOT_CONFIGURED",
              message:
                "Set DATABASE_URL, AE_DB_APP_PASSWORD, AE_DB_IDENTITY_PASSWORD and AE_SESSION_SECRET as Worker secrets, then redeploy.",
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      const api = getContainer(env.API, "primary");
      await api.startAndWaitForPorts({
        ports: [4000],
        startOptions: { envVars: containerEnv(env, origin) },
        // Migrations and the registry seed run before the server listens; allow for a cold start.
        cancellationOptions: { portReadyTimeoutMS: 120_000 },
      });
      return api.fetch(request);
    }

    const web = getContainer(env.WEB, "primary");
    await web.startAndWaitForPorts({
      ports: [3000],
      startOptions: { envVars: { PORT: "3000", HOSTNAME: "0.0.0.0", NODE_ENV: "production" } },
      cancellationOptions: { portReadyTimeoutMS: 60_000 },
    });
    return web.fetch(request);
  },
} satisfies ExportedHandler<Env>;
