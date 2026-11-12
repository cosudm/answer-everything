/**
 * Turns Worker variables and secrets into the environment of the API
 * container. Pure functions on purpose: no bindings, no I/O, unit tested.
 *
 * Three situations:
 *
 *   DATABASE_URL is set            external PostgreSQL (durable). The session
 *                                  secret and the two role passwords are used
 *                                  as given; outside prod, any that are missing
 *                                  are derived from DATABASE_URL so one secret
 *                                  is enough to go durable.
 *   no DATABASE_URL, not prod,     the container starts its own PostgreSQL.
 *   AE_EMBEDDED_DATABASE=true      Demo storage: lost whenever it restarts.
 *   anything else                  not configured; the Worker answers 503.
 */

/** Everything the Worker may hold as a plain-text variable or a secret. */
export interface DeploymentVariables {
  AE_ENV?: string;
  LOG_LEVEL?: string;
  AE_EMBEDDED_WORKER?: string;
  AE_EMBEDDED_DEV_PROVIDER?: string;
  AE_EMBEDDED_DATABASE?: string;
  AE_DEFAULT_ALLOW_EXPERIMENTAL?: string;
  AE_EMBEDDING_MODEL?: string;
  AE_DEFAULT_WORKSPACE_MONTHLY_BUDGET_USD?: string;
  AE_RATE_LIMIT_PER_MINUTE?: string;
  AE_SIGNUP_ALLOWLIST?: string;
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

const FORWARDED_KEYS: Array<keyof DeploymentVariables> = [
  "AE_ENV",
  "LOG_LEVEL",
  "AE_EMBEDDED_WORKER",
  "AE_EMBEDDED_DEV_PROVIDER",
  "AE_DEFAULT_ALLOW_EXPERIMENTAL",
  "AE_EMBEDDING_MODEL",
  "AE_DEFAULT_WORKSPACE_MONTHLY_BUDGET_USD",
  "AE_RATE_LIMIT_PER_MINUTE",
  "AE_SIGNUP_ALLOWLIST",
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

/** Fixed by the image layout and by how the Worker fronts the container. */
const CONTAINER_DEFAULTS: Record<string, string> = {
  API_HOST: "0.0.0.0",
  API_PORT: "4000",
  AE_COOKIE_SECURE: "true",
  AE_INLINE_JOBS: "false",
  AE_MIGRATIONS_DIR: "/app/migrations",
  AE_MODEL_SEED_PATH: "/app/config/models.seed.json",
  DEV_PROVIDER_BASE_URL: "http://127.0.0.1:4100/v1",
  DEV_PROVIDER_PORT: "4100",
  NODE_ENV: "production",
};

/** Secrets the API needs next to DATABASE_URL. Derivable outside prod. */
const DATABASE_COMPANIONS = [
  "AE_SESSION_SECRET",
  "AE_DB_APP_PASSWORD",
  "AE_DB_IDENTITY_PASSWORD",
] as const;

export type ApiEnvironment =
  | {
      ok: true;
      /** Environment for the container, without the request-specific public URLs. */
      envVars: Record<string, string>;
      /** "embedded" is the container-local demo database; "external" is DATABASE_URL. */
      storage: "embedded" | "external";
      /** Names of secrets that were derived rather than supplied. */
      derived: string[];
      /** Changes whenever the configuration does; names the container instance. */
      fingerprint: string;
    }
  | { ok: false; missing: string[] };

export async function resolveApiEnvironment(vars: DeploymentVariables): Promise<ApiEnvironment> {
  const isProd = vars.AE_ENV === "prod";
  const envVars: Record<string, string> = { ...CONTAINER_DEFAULTS };
  for (const key of FORWARDED_KEYS) {
    const value = vars[key];
    if (typeof value === "string" && value !== "") envVars[key] = value;
  }

  const derived: string[] = [];
  const missing: string[] = [];
  let storage: "embedded" | "external";

  const databaseUrl = envVars.DATABASE_URL;
  if (databaseUrl) {
    storage = "external";
    for (const key of DATABASE_COMPANIONS) {
      if (envVars[key]) continue;
      if (isProd) {
        missing.push(key);
        continue;
      }
      envVars[key] = await deriveSecret(databaseUrl, key);
      derived.push(key);
    }
  } else if (!isProd && vars.AE_EMBEDDED_DATABASE === "true") {
    storage = "embedded";
    // The entrypoint starts PostgreSQL and generates fresh secrets on each boot.
    envVars.AE_EMBEDDED_DATABASE = "true";
  } else {
    return { ok: false, missing: ["DATABASE_URL"] };
  }

  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, envVars, storage, derived, fingerprint: await fingerprint(envVars) };
}

/**
 * Deterministic secret bound to the database connection string. Whoever holds
 * DATABASE_URL already owns the database (and with it every session row), so
 * deriving the companions from it does not widen what that secret protects.
 * Production must set them explicitly: resolveApiEnvironment refuses to derive
 * when AE_ENV=prod.
 */
export async function deriveSecret(databaseUrl: string, purpose: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(databaseUrl),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`answer-everything:${purpose}:v1`),
  );
  return toHex(signature);
}

/** Short, stable hash of the container environment. Never logged with its input. */
export async function fingerprint(envVars: Record<string, string>): Promise<string> {
  const canonical = JSON.stringify(
    Object.keys(envVars)
      .sort()
      .map((key) => [key, envVars[key]]),
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return toHex(digest).slice(0, 16);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Routes that belong to the API container; everything else is the web app.
 * /metrics is deliberately not routed: it is unauthenticated operational data
 * and this Worker is the public edge.
 */
export function isApiPath(pathname: string): boolean {
  return pathname === "/health" || pathname === "/v1" || pathname.startsWith("/v1/");
}

/**
 * Paths that vulnerability scanners request on every public hostname. Nothing
 * in this application lives there, and a container bills for every second it
 * is awake, so these are answered at the edge without waking anything.
 */
const PROBE_EXTENSION = /\.(php\d?|aspx?|jsp|cgi|env|sql|bak|ini|ya?ml|log|sh|pem|key)$/i;
const PROBE_PREFIX =
  /^\/(wp-|wordpress|phpmyadmin|pma|cgi-bin|vendor\/|\.git|\.env|\.aws|\.ssh|\.svn|\.vscode|actuator|server-status|xmlrpc)/i;

export function isProbePath(pathname: string): boolean {
  return PROBE_EXTENSION.test(pathname) || PROBE_PREFIX.test(pathname);
}

/**
 * True for a person opening a page in a browser. Browsers label navigations
 * with Sec-Fetch headers; scripts and most crawlers do not, so they never
 * trigger the API warm-up.
 */
export function isBrowserNavigation(headers: Headers): boolean {
  return (
    headers.get("sec-fetch-mode") === "navigate" && headers.get("sec-fetch-dest") === "document"
  );
}
