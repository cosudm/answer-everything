import { z } from "zod";

const Env = z.object({
  AE_ENV: z.enum(["dev", "uat", "prod", "test"]).default("dev"),
  NODE_ENV: z.string().default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default("0.0.0.0"),
  API_PUBLIC_URL: z.string().url().default("http://localhost:4000"),
  WEB_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  AE_SESSION_SECRET: z.string().min(32),
  AE_SESSION_TTL_MINUTES: z.coerce.number().int().positive().default(30),
  AE_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(14),
  AE_COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  AE_DEFAULT_WORKSPACE_MONTHLY_BUDGET_USD: z.coerce.number().nonnegative().default(25),
  AE_DEFAULT_ALLOW_EXPERIMENTAL: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  AE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  AE_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  AE_EMBEDDING_MODEL: z.string().default("local-dev/dev-embed-1536"),
  AE_INLINE_JOBS: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  LOG_LEVEL: z.string().default("info"),
});

export type ApiConfig = z.infer<typeof Env> & { isProd: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid API configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.AE_ENV === "prod") {
    if (!cfg.AE_COOKIE_SECURE) throw new Error("AE_COOKIE_SECURE must be true in prod");
    if (cfg.AE_DEFAULT_ALLOW_EXPERIMENTAL)
      throw new Error("AE_DEFAULT_ALLOW_EXPERIMENTAL must be false in prod");
    if (cfg.AE_SESSION_SECRET.includes("change-me"))
      throw new Error("AE_SESSION_SECRET is a placeholder");
  }
  return { ...cfg, isProd: cfg.AE_ENV === "prod" };
}
