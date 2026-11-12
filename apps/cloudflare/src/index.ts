import { Container, getContainer } from "@cloudflare/containers";
import {
  isApiPath,
  resolveApiEnvironment,
  type ApiEnvironment,
  type DeploymentVariables,
} from "./config";

/**
 * Answer Everything on Cloudflare: one Worker, two Containers, one origin.
 *
 *   /v1/*, /health   -> API container (Fastify, embedded job runner and, outside
 *                       prod, the labelled development provider)
 *   everything else  -> web container (Next.js standalone, same-origin API calls)
 *
 * Secrets never appear in this repository. They are Worker secrets (dashboard:
 * Settings, Variables and Secrets) and are handed to the API container as
 * environment variables when it starts. See ./config.ts for how a missing
 * database falls back to labelled demo storage.
 */

interface Env extends DeploymentVariables {
  API: DurableObjectNamespace<ApiContainer>;
  WEB: DurableObjectNamespace<WebContainer>;
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

/** Cold start budget: boot, optional PostgreSQL init, migrations, registry seed. */
const API_READY_TIMEOUT_MS = 150_000;
const WEB_READY_TIMEOUT_MS = 60_000;
/** A new instance can take a while to be placed right after a deployment. */
const INSTANCE_TIMEOUT_MS = 30_000;

const resolutions = new WeakMap<object, Promise<ApiEnvironment>>();

/** The variables are fixed for a deployment, so resolve them once per isolate. */
function apiEnvironment(env: Env): Promise<ApiEnvironment> {
  let resolution = resolutions.get(env);
  if (!resolution) {
    resolution = resolveApiEnvironment(env);
    resolutions.set(env, resolution);
  }
  return resolution;
}

/**
 * Starts the API container for the current configuration and waits until it
 * listens. The instance is named after the configuration fingerprint, so a
 * changed secret gets a fresh container instead of one still running with the
 * old environment; the previous instance sleeps on its own.
 */
async function startApi(env: Env, config: ApiEnvironment & { ok: true }, origin: string) {
  const api = getContainer(env.API, `api-${config.fingerprint}`);
  await api.startAndWaitForPorts({
    ports: [4000],
    startOptions: {
      envVars: { ...config.envVars, API_PUBLIC_URL: origin, WEB_PUBLIC_URL: origin },
    },
    cancellationOptions: {
      instanceGetTimeoutMS: INSTANCE_TIMEOUT_MS,
      portReadyTimeoutMS: API_READY_TIMEOUT_MS,
    },
  });
  return api;
}

async function handleApi(request: Request, env: Env, origin: string): Promise<Response> {
  const config = await apiEnvironment(env);
  if (!config.ok) {
    return json(503, {
      error: {
        code: "NOT_CONFIGURED",
        message: `Missing Worker secrets: ${config.missing.join(", ")}. Add them under Settings, Variables and Secrets.`,
      },
    });
  }
  try {
    const api = await startApi(env, config, origin);
    return await api.fetch(withClientAddress(request));
  } catch (error) {
    console.error("api container is not ready", error);
    return json(
      503,
      {
        error: {
          code: "API_UNAVAILABLE",
          message:
            "The API is not ready yet. It may still be starting; if this lasts more than a couple of minutes, check the container logs in the Cloudflare dashboard.",
        },
      },
      { "retry-after": "5" },
    );
  }
}

/** Last time the web container was confirmed listening, per isolate. */
let webReadyUntil = 0;

async function handleWeb(request: Request, env: Env): Promise<Response> {
  const web = getContainer(env.WEB, "web");
  try {
    // A page load is a burst of asset requests. Confirm the container once,
    // then let the following requests go straight through; the web image
    // carries its own PORT and HOSTNAME, so an automatic restart is safe.
    if (Date.now() > webReadyUntil) {
      await web.startAndWaitForPorts({
        ports: [3000],
        cancellationOptions: {
          instanceGetTimeoutMS: INSTANCE_TIMEOUT_MS,
          portReadyTimeoutMS: WEB_READY_TIMEOUT_MS,
        },
      });
      webReadyUntil = Date.now() + 20_000;
    }
    return await web.fetch(request);
  } catch (error) {
    webReadyUntil = 0;
    console.error("web container is not ready", error);
    return wantsDocument(request)
      ? startingPage()
      : new Response("Starting", { status: 503, headers: { "retry-after": "5" } });
  }
}

/**
 * The container sees the Worker as its client. Pass the visitor's address on
 * (from Cloudflare, not from anything the visitor sent) so rate limits and
 * audit records attribute requests correctly.
 */
function withClientAddress(request: Request): Request {
  const address = request.headers.get("cf-connecting-ip");
  if (!address) return request;
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-for", address);
  headers.set("x-forwarded-proto", new URL(request.url).protocol.replace(":", ""));
  return new Request(request, { headers });
}

function wantsDocument(request: Request): boolean {
  return request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

/** Shown while the web container boots; reloads itself. */
function startingPage(): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>Starting · Answer Everything</title>
<style>
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; background: #f8f6f2; color: #1c1b19; font: 16px/1.5 Georgia, "Times New Roman", serif; }
  main { max-width: 26rem; padding: 2rem; text-align: center; }
  i { display: inline-block; width: 28px; height: 28px; border-radius: 6px; background: #14665e; }
  h1 { font-size: 1.375rem; margin: 1rem 0 0.5rem; }
  p { margin: 0; color: #5c5953; font-family: system-ui, sans-serif; font-size: 0.9375rem; }
</style>
</head>
<body>
<main>
  <i aria-hidden="true"></i>
  <h1>Answer Everything is starting</h1>
  <p>This environment sleeps when nobody is using it. It takes a moment to wake, and this page reloads on its own.</p>
</main>
</body>
</html>`;
  return new Response(html, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "5",
    },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (isApiPath(url.pathname)) return handleApi(request, env, url.origin);

    // Someone opening a page will call the API next: start waking it now.
    if (wantsDocument(request)) {
      ctx.waitUntil(
        apiEnvironment(env)
          .then((config) => (config.ok ? startApi(env, config, url.origin) : undefined))
          .catch(() => undefined),
      );
    }
    return handleWeb(request, env);
  },
} satisfies ExportedHandler<Env>;
