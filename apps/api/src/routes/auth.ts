import { LoginInput, RegisterInput } from "@ae/domain";
import { listWorkspacesForUser } from "@ae/identity";
import { withTenant } from "@ae/database";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import {
  REFRESH_COOKIE,
  clearSessionCookies,
  clientMeta,
  principalOf,
  requireAuth,
  setSessionCookies,
} from "../plugins/auth.js";
import { ApiHttpError } from "../plugins/errors.js";

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const cookieOpts = {
    secure: ctx.config.AE_COOKIE_SECURE || ctx.config.isProd,
    sessionTtlMinutes: ctx.config.AE_SESSION_TTL_MINUTES,
    refreshTtlDays: ctx.config.AE_REFRESH_TTL_DAYS,
  };
  const strict = { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

  app.post("/v1/auth/register", strict, async (req, reply) => {
    const input = RegisterInput.parse(req.body);
    const result = await ctx.identity.register(input, clientMeta(req));
    // Dev convenience: new workspaces may opt into experimental models by default (never in prod).
    if (ctx.config.AE_DEFAULT_ALLOW_EXPERIMENTAL && !ctx.config.isProd) {
      await withTenant(
        ctx.db.app,
        {
          userId: result.principal.user.id,
          workspaceId: result.workspace.id,
          identityId: result.principal.actingIdentity.id,
        },
        (tx) =>
          tx.query(
            `UPDATE workspaces SET settings = settings || '{"allowExperimentalModels": true}'::jsonb WHERE id = $1`,
            [result.workspace.id],
          ),
      );
      result.workspace.settings.allowExperimentalModels = true;
    }
    setSessionCookies(reply, result.tokens, cookieOpts);
    return reply.status(201).send({
      user: result.principal.user,
      workspace: result.workspace,
      accessToken: result.tokens.accessToken,
      expiresAt: result.tokens.session.expiresAt,
    });
  });

  app.post("/v1/auth/login", strict, async (req, reply) => {
    const input = LoginInput.parse(req.body);
    const result = await ctx.identity.login(input, clientMeta(req));
    setSessionCookies(reply, result.tokens, cookieOpts);
    return {
      user: result.principal.user,
      accessToken: result.tokens.accessToken,
      expiresAt: result.tokens.session.expiresAt,
    };
  });

  app.post("/v1/auth/refresh", strict, async (req, reply) => {
    const token =
      req.cookies[REFRESH_COOKIE] ??
      (req.body as { refreshToken?: string } | undefined)?.refreshToken;
    if (!token) throw new ApiHttpError(401, "SESSION_INVALID", "No refresh token.");
    const result = await ctx.identity.refresh(token, clientMeta(req));
    setSessionCookies(reply, result.tokens, cookieOpts);
    return {
      user: result.principal.user,
      accessToken: result.tokens.accessToken,
      expiresAt: result.tokens.session.expiresAt,
    };
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    await ctx.identity.logout(req.accessToken);
    clearSessionCookies(reply);
    return reply.status(204).send();
  });

  app.get("/v1/auth/me", { preHandler: requireAuth }, async (req) => {
    const principal = principalOf(req);
    const workspaces = await withTenant(
      ctx.db.app,
      { userId: principal.user.id, workspaceId: null, identityId: principal.actingIdentity.id },
      (tx) => listWorkspacesForUser(tx, principal.user.id),
    );
    return { user: principal.user, actingIdentity: principal.actingIdentity, workspaces };
  });
}
