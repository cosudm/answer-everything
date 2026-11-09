import { AuthorizationDeniedError } from "@ae/authorization";
import { IdentityError } from "@ae/identity";
import { GatewayError } from "@ae/model-gateway";
import { AskError } from "@ae/orchestration";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

export class ApiHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

const IDENTITY_STATUS: Record<IdentityError["code"], number> = {
  EMAIL_TAKEN: 409,
  WEAK_PASSWORD: 400,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 429,
  ACCOUNT_INACTIVE: 403,
  SESSION_INVALID: 401,
};

const GATEWAY_STATUS: Record<GatewayError["code"], number> = {
  MODEL_NOT_FOUND: 404,
  MODEL_DISABLED: 409,
  PROVIDER_DISABLED: 409,
  PROVIDER_UNCONFIGURED: 503,
  PRIVACY_CLASS_NOT_ALLOWED: 403,
  BUDGET_EXCEEDED: 402,
  CAPABILITY_UNAVAILABLE: 409,
};

/**
 * Maps domain errors to HTTP without leaking internals. Every response
 * carries the request id so the user can quote it and we can find the log.
 */
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) => {
    const requestId = req.id as string;
    const send = (status: number, code: string, message: string, details?: unknown) =>
      reply.status(status).send({ error: { code, message, details, requestId } });

    if (err instanceof ApiHttpError) return send(err.status, err.code, err.message, err.details);
    if (err instanceof ZodError) return send(400, "VALIDATION", "Request validation failed.", err.flatten());
    if (err instanceof IdentityError) return send(IDENTITY_STATUS[err.code], err.code, err.message);
    if (err instanceof AuthorizationDeniedError) {
      return send(err.decision.outcome === "REQUIRES_APPROVAL" ? 409 : 403, err.decision.outcome === "REQUIRES_APPROVAL" ? "REQUIRES_APPROVAL" : "AUTHORIZATION_DENIED", "This action is not authorized.", {
        reasonCodes: err.decision.reasonCodes,
        policyIds: err.decision.policyIds,
      });
    }
    if (err instanceof AskError) {
      const status = err.code === "NOT_FOUND" ? 404 : err.code === "AUTHORIZATION_DENIED" ? 403 : 400;
      return send(status, err.code, err.message, { reasonCodes: err.reasonCodes });
    }
    if (err instanceof GatewayError) return send(GATEWAY_STATUS[err.code], err.code, err.message);
    const fastifyErr = err as FastifyError;
    if (fastifyErr.statusCode && fastifyErr.statusCode < 500) {
      return send(fastifyErr.statusCode, fastifyErr.code ?? "BAD_REQUEST", fastifyErr.message);
    }
    req.log.error({ err }, "unhandled error");
    return send(500, "INTERNAL", "Something went wrong on our side. Quote the request id when reporting it.");
  });
}
