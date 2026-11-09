import { withTenant } from "@ae/database";
import { AskInput, CompareInput, CreateConversationInput, type AskStreamEvent } from "@ae/domain";
import { getWorkspace } from "@ae/identity";
import {
  createConversation,
  getConversation,
  listConversations,
  listMessages,
  listModelRunsForMessage,
  runAsk,
  runCompare,
  softDeleteConversation,
} from "@ae/orchestration";
import { getAnswerRecord, recordAudit } from "@ae/provenance";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { clientMeta, principalOf, requireAuth } from "../plugins/auth.js";
import { ApiHttpError } from "../plugins/errors.js";

const WsParams = z.object({ workspaceId: z.string().uuid() });
const ConvParams = WsParams.extend({ conversationId: z.string().uuid() });

/**
 * Server-Sent Events writer. Fastify's reply is hijacked so we control the
 * raw socket; a client disconnect aborts the model stream through `signal`.
 */
function openSse(req: FastifyRequest, reply: FastifyReply) {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": (req.headers.origin as string | undefined) ?? "*",
    "access-control-allow-credentials": "true",
  });
  res.write(": connected\n\n");
  const controller = new AbortController();
  req.raw.on("close", () => controller.abort());
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 15_000);
  return {
    signal: controller.signal,
    send(event: AskStreamEvent) {
      if (!res.writableEnded) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    end() {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    },
  };
}

export async function conversationRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook("preHandler", requireAuth);

  app.get("/v1/workspaces/:workspaceId/conversations", async (req) => {
    const p = principalOf(req);
    const { workspaceId } = WsParams.parse(req.params);
    const q = z.object({ projectId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "conversation.read", resource: { kind: "CONVERSATION", id: null, workspaceId }, purpose: "list", modelVersionId: null, informationPrivacyClass: null });
      return { items: await listConversations(tx, workspaceId, { projectId: q.projectId ?? null, limit: q.limit }) };
    });
  });

  app.post("/v1/workspaces/:workspaceId/conversations", async (req, reply) => {
    const p = principalOf(req);
    const { workspaceId } = WsParams.parse(req.params);
    const input = CreateConversationInput.parse(req.body ?? {});
    const conversation = await withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "conversation.create", resource: { kind: "CONVERSATION", id: null, workspaceId }, purpose: "create", modelVersionId: null, informationPrivacyClass: null });
      const ws = await getWorkspace(tx, workspaceId);
      if (!ws) throw new ApiHttpError(404, "NOT_FOUND", "Workspace not found.");
      const c = await createConversation(tx, {
        workspaceId,
        projectId: input.projectId ?? null,
        createdByUserId: p.user.id,
        title: input.title ?? null,
        privacyClass: ws.settings.defaultPrivacyClass,
        modelMode: input.modelMode,
        pinnedModelVersionId: input.pinnedModelVersionId ?? null,
      });
      await recordAudit(tx, { workspaceId, actorIdentityId: p.actingIdentity.id, actorUserId: p.user.id, eventType: "conversation.created", resourceKind: "CONVERSATION", resourceId: c.id, outcome: "SUCCESS", ...clientMeta(req) });
      return c;
    });
    return reply.status(201).send(conversation);
  });

  app.get("/v1/workspaces/:workspaceId/conversations/:conversationId", async (req) => {
    const p = principalOf(req);
    const { workspaceId, conversationId } = ConvParams.parse(req.params);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      const conversation = await getConversation(tx, conversationId);
      if (!conversation) throw new ApiHttpError(404, "NOT_FOUND", "Conversation not found.");
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "conversation.read", resource: { kind: "CONVERSATION", id: conversation.id, workspaceId: conversation.workspaceId, ownerUserId: conversation.createdByUserId }, purpose: "view", modelVersionId: null, informationPrivacyClass: null });
      const messages = await listMessages(tx, conversation.id);
      const answers: Record<string, unknown> = {};
      for (const m of messages) {
        if (m.answerRecordId) {
          const rec = await getAnswerRecord(tx, m.answerRecordId);
          if (rec) answers[m.answerRecordId] = { ...rec, modelRuns: await listModelRunsForMessage(tx, m.id) };
        }
      }
      return { conversation, messages, answers };
    });
  });

  app.delete("/v1/workspaces/:workspaceId/conversations/:conversationId", async (req, reply) => {
    const p = principalOf(req);
    const { workspaceId, conversationId } = ConvParams.parse(req.params);
    await withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      const conversation = await getConversation(tx, conversationId);
      if (!conversation) throw new ApiHttpError(404, "NOT_FOUND", "Conversation not found.");
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "conversation.delete", resource: { kind: "CONVERSATION", id: conversation.id, workspaceId: conversation.workspaceId, ownerUserId: conversation.createdByUserId }, purpose: "delete", modelVersionId: null, informationPrivacyClass: null }, { ipAddress: req.ip });
      await softDeleteConversation(tx, conversation.id);
      await recordAudit(tx, { workspaceId, actorIdentityId: p.actingIdentity.id, actorUserId: p.user.id, eventType: "conversation.deleted", resourceKind: "CONVERSATION", resourceId: conversation.id, outcome: "SUCCESS", ...clientMeta(req) });
    });
    return reply.status(204).send();
  });

  /** Ask: streams AskStreamEvents as SSE until `complete` or `error`. */
  app.post("/v1/workspaces/:workspaceId/conversations/:conversationId/messages", async (req, reply) => {
    const p = principalOf(req);
    const { workspaceId, conversationId } = ConvParams.parse(req.params);
    const input = AskInput.parse(req.body);
    const sse = openSse(req, reply);
    try {
      for await (const ev of runAsk(
        { db: ctx.db, gateway: ctx.gateway, authz: ctx.authz, logger: ctx.logger, embeddingModelVersionId: ctx.embeddingModelVersionId, events: ctx.events },
        { principal: p, workspaceId, conversationId, input, ipAddress: req.ip, signal: sse.signal },
      )) {
        sse.send(ev);
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      req.log.error({ err }, "ask stream failed");
      sse.send({ type: "error", code: e.code ?? "INTERNAL", message: e.code ? e.message : "The request could not be completed." });
    } finally {
      sse.end();
    }
  });

  /** Compare: 2-4 models answer the same question side by side. */
  app.post("/v1/workspaces/:workspaceId/conversations/:conversationId/compare", async (req, reply) => {
    const p = principalOf(req);
    const { workspaceId, conversationId } = ConvParams.parse(req.params);
    const input = CompareInput.parse(req.body);
    const sse = openSse(req, reply);
    try {
      for await (const ev of runCompare(
        { db: ctx.db, gateway: ctx.gateway, authz: ctx.authz, logger: ctx.logger, embeddingModelVersionId: ctx.embeddingModelVersionId, events: ctx.events },
        { principal: p, workspaceId, conversationId, input: { content: input.content, useKnowledge: input.useKnowledge }, modelVersionIds: input.modelVersionIds, ipAddress: req.ip, signal: sse.signal },
      )) {
        sse.send(ev);
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      req.log.error({ err }, "compare stream failed");
      sse.send({ type: "error", code: e.code ?? "INTERNAL", message: e.code ? e.message : "The request could not be completed." });
    } finally {
      sse.end();
    }
  });

  app.get("/v1/workspaces/:workspaceId/answers/:answerId", async (req) => {
    const p = principalOf(req);
    const { workspaceId, answerId } = WsParams.extend({ answerId: z.string().uuid() }).parse(req.params);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      const rec = await getAnswerRecord(tx, answerId);
      if (!rec) throw new ApiHttpError(404, "NOT_FOUND", "Answer not found.");
      const conversation = await getConversation(tx, rec.conversationId);
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "conversation.read", resource: { kind: "CONVERSATION", id: rec.conversationId, workspaceId: rec.workspaceId, ownerUserId: conversation?.createdByUserId ?? null }, purpose: "view answer", modelVersionId: null, informationPrivacyClass: null });
      const manifest = rec.contextManifestId ? (await tx.query("SELECT * FROM context_manifests WHERE id = $1", [rec.contextManifestId])).rows[0] : null;
      return { answer: rec, modelRuns: await listModelRunsForMessage(tx, rec.messageId), manifest: manifest ? { id: manifest.id, strategy: manifest.strategy, informationPrivacyClass: manifest.information_privacy_class, tokenBudget: manifest.token_budget, tokensUsed: manifest.tokens_used, items: manifest.items, retrieval: manifest.retrieval } : null };
    });
  });
}
