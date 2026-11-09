import type { Principal } from "@ae/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { AppContext } from "../context.js";
import { ApiHttpError } from "./errors.js";

export const SESSION_COOKIE = "ae_session";
export const REFRESH_COOKIE = "ae_refresh";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal | null;
    accessToken: string | null;
  }
}

/**
 * Resolves the caller on every request from the httpOnly session cookie or a
 * Bearer token. Routes opt into `requireAuth` via a preHandler.
 */
export const authPlugin = fp(async (app: FastifyInstance, opts: { ctx: AppContext }) => {
  app.decorateRequest("principal", null);
  app.decorateRequest("accessToken", null);

  app.addHook("onRequest", async (req) => {
    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const token = bearer ?? req.cookies[SESSION_COOKIE] ?? null;
    req.accessToken = token;
    req.principal = token ? await opts.ctx.identity.resolveSession(token) : null;
  });
});

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!req.principal) throw new ApiHttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
}

export function principalOf(req: FastifyRequest): Principal {
  if (!req.principal) throw new ApiHttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  return req.principal;
}

export function clientMeta(req: FastifyRequest) {
  return { ipAddress: req.ip ?? null, userAgent: (req.headers["user-agent"] as string | undefined) ?? null };
}

export function setSessionCookies(
  reply: FastifyReply,
  tokens: { accessToken: string; refreshToken: string },
  opts: { secure: boolean; sessionTtlMinutes: number; refreshTtlDays: number },
) {
  reply.setCookie(SESSION_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: "lax",
    path: "/",
    maxAge: opts.sessionTtlMinutes * 60,
  });
  reply.setCookie(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: "lax",
    path: "/v1/auth/refresh",
    maxAge: opts.refreshTtlDays * 24 * 60 * 60,
  });
}

export function clearSessionCookies(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  reply.clearCookie(REFRESH_COOKIE, { path: "/v1/auth/refresh" });
}
