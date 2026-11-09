import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { metrics } from "@ae/observability";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { AppContext } from "./context.js";
import { authPlugin } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/errors.js";
import { accountRoutes } from "./routes/account.js";
import { authRoutes } from "./routes/auth.js";
import { conversationRoutes } from "./routes/conversations.js";
import { knowledgeRoutes } from "./routes/knowledge.js";
import { modelRoutes } from "./routes/models.js";
import { workspaceRoutes } from "./routes/workspaces.js";

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  // pino 10 types differ slightly from the pino version Fastify's typings
  // reference; the runtime logger is compatible.
  const app: FastifyInstance = Fastify({
    loggerInstance: ctx.logger as unknown as FastifyBaseLogger,
    genReqId: (req) => (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });
  await app.register(cors, {
    origin: [
      ctx.config.WEB_PUBLIC_URL,
      ...(ctx.config.isProd ? [] : ["http://localhost:3000", "http://127.0.0.1:3000"]),
    ],
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-request-id"],
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: ctx.config.AE_MAX_UPLOAD_BYTES, files: 1 } });
  await app.register(rateLimit, {
    max: ctx.config.AE_RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    keyGenerator: (req) => req.principal?.user.id ?? req.ip,
    onExceeded: (req) =>
      req.log.warn({ ip: req.ip, userId: req.principal?.user.id }, "rate limit exceeded"),
  });
  await app.register(authPlugin, { ctx });
  registerErrorHandler(app);

  app.addHook("onResponse", async (req, reply) => {
    metrics.httpRequests.inc({
      route: req.routeOptions.url ?? "unknown",
      method: req.method,
      status: String(reply.statusCode),
    });
  });
  app.addHook("onSend", async (_req, reply) => {
    reply.header("x-request-id", _req.id);
  });

  app.get("/health", async () => {
    const db = await ctx.db.app
      .query("SELECT 1")
      .then(() => "ok")
      .catch((e: Error) => `error: ${e.message}`);
    return {
      status: db === "ok" ? "ok" : "degraded",
      env: ctx.config.AE_ENV,
      db,
      embeddingModel: ctx.embeddingModelVersionId ? "configured" : "lexical-only",
      time: new Date().toISOString(),
    };
  });
  app.get("/metrics", async (_req, reply) => {
    reply.header("content-type", "text/plain; version=0.0.4");
    return metrics.render();
  });

  await app.register(async (scope) => authRoutes(scope, ctx));
  await app.register(async (scope) => workspaceRoutes(scope, ctx));
  await app.register(async (scope) => conversationRoutes(scope, ctx));
  await app.register(async (scope) => modelRoutes(scope, ctx));
  await app.register(async (scope) => knowledgeRoutes(scope, ctx));
  await app.register(async (scope) => accountRoutes(scope, ctx));

  return app;
}
