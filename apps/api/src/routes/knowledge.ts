import { withTenant } from "@ae/database";
import { CreateNoteInput, KnowledgeSearchInput, UpdateKnowledgeInput } from "@ae/domain";
import { getWorkspace } from "@ae/identity";
import { getKnowledgeObject, hybridSearch, insertKnowledgeObject, isSupportedMimeType, listKnowledgeObjects, softDeleteKnowledgeObject, updateKnowledgeObject } from "@ae/knowledge";
import { provenanceFor, recordAudit, recordProvenance } from "@ae/provenance";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { clientMeta, principalOf, requireAuth } from "../plugins/auth.js";
import { ApiHttpError } from "../plugins/errors.js";

const WsParams = z.object({ workspaceId: z.string().uuid() });
const ObjParams = WsParams.extend({ knowledgeId: z.string().uuid() });

export async function knowledgeRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook("preHandler", requireAuth);

  app.get("/v1/workspaces/:workspaceId/knowledge", async (req) => {
    const p = principalOf(req);
    const { workspaceId } = WsParams.parse(req.params);
    const q = z.object({ projectId: z.string().uuid().optional(), kind: z.string().optional(), search: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "knowledge.read", resource: { kind: "KNOWLEDGE_OBJECT", id: null, workspaceId }, purpose: "list", modelVersionId: null, informationPrivacyClass: null });
      return { items: await listKnowledgeObjects(tx, { workspaceId, projectId: q.projectId ?? null, kind: q.kind as never, search: q.search, limit: q.limit }) };
    });
  });

  async function createAndEnqueue(req: FastifyRequest, workspaceId: string, input: { title: string; content: string; mimeType: string | null; kind: "NOTE" | "DOCUMENT"; projectId?: string | null; privacyClass?: string; tags?: string[]; aiUsePermission: "ALLOW" | "DENY"; sourceUri?: string | null }) {
    const p = principalOf(req);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      const ws = await getWorkspace(tx, workspaceId);
      if (!ws) throw new ApiHttpError(404, "NOT_FOUND", "Workspace not found.");
      const privacyClass = (input.privacyClass as never) ?? ws.settings.defaultPrivacyClass;
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "knowledge.create", resource: { kind: "KNOWLEDGE_OBJECT", id: null, workspaceId, privacyClass }, purpose: "add knowledge", modelVersionId: null, informationPrivacyClass: null });
      const obj = await insertKnowledgeObject(tx, {
        workspaceId,
        projectId: input.projectId ?? null,
        kind: input.kind,
        title: input.title,
        mimeType: input.mimeType,
        textContent: input.content,
        sourceUri: input.sourceUri ?? null,
        privacyClass,
        aiUsePermission: input.aiUsePermission,
        ownerUserId: p.user.id,
        tags: input.tags ?? [],
      });
      await recordProvenance(tx, { workspaceId, subjectKind: "KNOWLEDGE_OBJECT", subjectId: obj.id, event: input.kind === "NOTE" ? "CREATED" : "UPLOADED", actorIdentityId: p.actingIdentity.id, details: { mimeType: input.mimeType, bytes: obj.byteSize, privacyClass } });
      await recordAudit(tx, { workspaceId, actorIdentityId: p.actingIdentity.id, actorUserId: p.user.id, eventType: "knowledge.created", resourceKind: "KNOWLEDGE_OBJECT", resourceId: obj.id, outcome: "SUCCESS", details: { kind: input.kind, privacyClass }, ...clientMeta(req) });
      const job = await ctx.queue.enqueue(tx, { type: "knowledge.ingest", workspaceId, actingIdentityId: p.actingIdentity.id, payload: { knowledgeObjectId: obj.id, workspaceId, userId: p.user.id } });
      return { obj, job };
    });
  }

  /** Notes and pasted text. */
  app.post("/v1/workspaces/:workspaceId/knowledge/notes", async (req, reply) => {
    const { workspaceId } = WsParams.parse(req.params);
    const input = CreateNoteInput.parse(req.body);
    const { obj, job } = await createAndEnqueue(req, workspaceId, { title: input.title, content: input.content, mimeType: "text/markdown", kind: "NOTE", projectId: input.projectId ?? null, privacyClass: input.privacyClass, tags: input.tags, aiUsePermission: input.aiUsePermission });
    if (ctx.config.AE_INLINE_JOBS) await ctx.jobRunner.runOnce();
    return reply.status(201).send({ knowledge: obj, job });
  });

  /** File upload (multipart). Text formats are extracted; others are recorded as unsupported. */
  app.post("/v1/workspaces/:workspaceId/knowledge/upload", async (req, reply) => {
    const { workspaceId } = WsParams.parse(req.params);
    const file = await req.file({ limits: { fileSize: ctx.config.AE_MAX_UPLOAD_BYTES } });
    if (!file) throw new ApiHttpError(400, "NO_FILE", "Attach a file in the 'file' field.");
    const buf = await file.toBuffer();
    const fields = file.fields as Record<string, { value?: string } | undefined>;
    const mime = file.mimetype || "application/octet-stream";
    const supported = isSupportedMimeType(mime);
    const content = supported ? buf.toString("utf8") : "";
    const { obj, job } = await createAndEnqueue(req, workspaceId, {
      title: fields.title?.value || file.filename,
      content,
      mimeType: mime,
      kind: "DOCUMENT",
      projectId: fields.projectId?.value || null,
      privacyClass: fields.privacyClass?.value,
      aiUsePermission: (fields.aiUsePermission?.value as "ALLOW" | "DENY") || "ALLOW",
      sourceUri: `upload:${file.filename}`,
    });
    if (ctx.config.AE_INLINE_JOBS) await ctx.jobRunner.runOnce();
    return reply.status(201).send({ knowledge: obj, job, supported, note: supported ? null : `Files of type ${mime} are stored but not yet extracted; text extraction for this format is on the roadmap.` });
  });

  app.get("/v1/workspaces/:workspaceId/knowledge/:knowledgeId", async (req) => {
    const p = principalOf(req);
    const { workspaceId, knowledgeId } = ObjParams.parse(req.params);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      const obj = await getKnowledgeObject(tx, knowledgeId);
      if (!obj) throw new ApiHttpError(404, "NOT_FOUND", "Knowledge object not found.");
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "knowledge.read", resource: { kind: "KNOWLEDGE_OBJECT", id: obj.id, workspaceId: obj.workspaceId, ownerUserId: obj.ownerUserId, privacyClass: obj.privacyClass }, purpose: "view", modelVersionId: null, informationPrivacyClass: null });
      const provenance = await provenanceFor(tx, "KNOWLEDGE_OBJECT", obj.id);
      return { knowledge: obj, provenance };
    });
  });

  app.patch("/v1/workspaces/:workspaceId/knowledge/:knowledgeId", async (req) => {
    const p = principalOf(req);
    const { workspaceId, knowledgeId } = ObjParams.parse(req.params);
    const patch = UpdateKnowledgeInput.parse(req.body);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      const obj = await getKnowledgeObject(tx, knowledgeId);
      if (!obj) throw new ApiHttpError(404, "NOT_FOUND", "Knowledge object not found.");
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "knowledge.update", resource: { kind: "KNOWLEDGE_OBJECT", id: obj.id, workspaceId: obj.workspaceId, ownerUserId: obj.ownerUserId, privacyClass: patch.privacyClass ?? obj.privacyClass }, purpose: "update", modelVersionId: null, informationPrivacyClass: null }, { ipAddress: req.ip });
      const updated = await updateKnowledgeObject(tx, obj.id, patch);
      if (patch.privacyClass && patch.privacyClass !== obj.privacyClass) {
        await recordProvenance(tx, { workspaceId, subjectKind: "KNOWLEDGE_OBJECT", subjectId: obj.id, event: "PRIVACY_CHANGED", actorIdentityId: p.actingIdentity.id, details: { from: obj.privacyClass, to: patch.privacyClass } });
        await recordAudit(tx, { workspaceId, actorIdentityId: p.actingIdentity.id, actorUserId: p.user.id, eventType: "knowledge.privacy_changed", resourceKind: "KNOWLEDGE_OBJECT", resourceId: obj.id, outcome: "SUCCESS", details: { from: obj.privacyClass, to: patch.privacyClass }, ...clientMeta(req) });
      }
      return updated;
    });
  });

  app.delete("/v1/workspaces/:workspaceId/knowledge/:knowledgeId", async (req, reply) => {
    const p = principalOf(req);
    const { workspaceId, knowledgeId } = ObjParams.parse(req.params);
    await withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      const obj = await getKnowledgeObject(tx, knowledgeId);
      if (!obj) throw new ApiHttpError(404, "NOT_FOUND", "Knowledge object not found.");
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "knowledge.delete", resource: { kind: "KNOWLEDGE_OBJECT", id: obj.id, workspaceId: obj.workspaceId, ownerUserId: obj.ownerUserId }, purpose: "delete", modelVersionId: null, informationPrivacyClass: null }, { ipAddress: req.ip });
      await softDeleteKnowledgeObject(tx, obj.id);
      await recordProvenance(tx, { workspaceId, subjectKind: "KNOWLEDGE_OBJECT", subjectId: obj.id, event: "DELETED", actorIdentityId: p.actingIdentity.id });
      await recordAudit(tx, { workspaceId, actorIdentityId: p.actingIdentity.id, actorUserId: p.user.id, eventType: "knowledge.deleted", resourceKind: "KNOWLEDGE_OBJECT", resourceId: obj.id, outcome: "SUCCESS", ...clientMeta(req) });
    });
    return reply.status(204).send();
  });

  /** Direct search over the governed library (same filters the model path uses). */
  app.post("/v1/workspaces/:workspaceId/knowledge/search", async (req) => {
    const p = principalOf(req);
    const { workspaceId } = WsParams.parse(req.params);
    const input = KnowledgeSearchInput.parse(req.body);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "knowledge.read", resource: { kind: "KNOWLEDGE_OBJECT", id: null, workspaceId }, purpose: "search", modelVersionId: null, informationPrivacyClass: null });
      const ws = await getWorkspace(tx, workspaceId);
      let queryEmbedding: number[] | null = null;
      if (ctx.embeddingModelVersionId) {
        try {
          const emb = await ctx.gateway.embed({ modelVersionId: ctx.embeddingModelVersionId, inputs: [input.query], workspaceId, actingIdentityId: p.actingIdentity.id, informationPrivacyClass: input.maxPrivacyClass ?? ws?.settings.maxPrivacyClass ?? "INTERNAL" });
          queryEmbedding = emb.vectors[0] ?? null;
        } catch (err) {
          req.log.warn({ err }, "embedding unavailable for search; lexical only");
        }
      }
      const hits = await hybridSearch(tx, { workspaceId, query: input.query, queryEmbedding, maxPrivacyClass: input.maxPrivacyClass ?? ws?.settings.maxPrivacyClass ?? "INTERNAL", projectId: input.projectId ?? null, limit: input.limit });
      return { items: hits, method: queryEmbedding ? "hybrid" : "lexical" };
    });
  });
}
