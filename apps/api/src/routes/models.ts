import { evaluate } from "@ae/authorization";
import { withTenant } from "@ae/database";
import { EvaluationStatus, RegisterModelInput, type ModelSummary } from "@ae/domain";
import { listRunsForModel } from "@ae/evaluation";
import { getWorkspace } from "@ae/identity";
import { getModel, listModels, registerModel, setEvaluationStatus, setModelEnabled } from "@ae/model-registry";
import { recordAudit } from "@ae/provenance";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { clientMeta, principalOf, requireAuth } from "../plugins/auth.js";
import { ApiHttpError } from "../plugins/errors.js";

const WsParams = z.object({ workspaceId: z.string().uuid() });
const ModelParams = WsParams.extend({ modelId: z.string().uuid() });

export async function modelRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook("preHandler", requireAuth);

  /** Models visible to a workspace, each flagged selectable or not (with the reason). */
  app.get("/v1/workspaces/:workspaceId/models", async (req) => {
    const p = principalOf(req);
    const { workspaceId } = WsParams.parse(req.params);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "workspace.read", resource: { kind: "WORKSPACE", id: workspaceId, workspaceId }, purpose: "list models", modelVersionId: null, informationPrivacyClass: null });
      const ws = await getWorkspace(tx, workspaceId);
      if (!ws) throw new ApiHttpError(404, "NOT_FOUND", "Workspace not found.");
      const membership = (await tx.query("SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2", [workspaceId, p.user.id])).rows[0];
      const all = await listModels(tx, { includeDisabled: true });
      const configured = new Map(await Promise.all(all.map(async ({ model }) => [model.id, await ctx.gateway.isConfigured(model.id)] as const)));
      const items: ModelSummary[] = all.map(({ model, provider }) => {
        // Same policy the orchestrator applies, evaluated in memory for display.
        const decision = evaluate(
          {
            userId: p.user.id,
            actingIdentityId: p.actingIdentity.id,
            workspaceId,
            action: "model.use",
            resource: { kind: "MODEL_VERSION", id: model.id, workspaceId: null },
            purpose: "display",
            modelVersionId: model.id,
            informationPrivacyClass: ws.settings.defaultPrivacyClass,
          },
          {
            identity: { kind: p.actingIdentity.kind, revoked: Boolean(p.actingIdentity.revokedAt), userId: p.user.id },
            user: { platformRole: "USER", status: p.user.status },
            membership: membership ? { role: membership.role } : null,
            workspace: { settings: ws.settings },
            model: {
              enabled: model.enabled,
              evaluationStatus: model.evaluationStatus,
              deploymentType: model.deploymentType,
              behavioralProfile: model.behavioralProfile,
              privacyClassesAllowed: model.privacyClassesAllowed,
              providerEnabled: provider.enabled,
            },
          },
        );
        const chat = model.capabilities.includes("chat");
        const cfg = configured.get(model.id) ?? { configured: false, reason: "unknown" };
        return {
          id: model.id,
          displayName: model.displayName,
          providerModelName: model.providerModelName,
          baseModel: model.baseModel,
          deploymentType: model.deploymentType,
          behavioralProfile: model.behavioralProfile,
          capabilities: model.capabilities,
          privacyClassesAllowed: model.privacyClassesAllowed,
          evaluationStatus: model.evaluationStatus,
          contextWindow: model.contextWindow,
          inputCostPerMillion: model.inputCostPerMillion,
          outputCostPerMillion: model.outputCostPerMillion,
          enabled: model.enabled,
          provider: { slug: provider.slug, displayName: provider.displayName, kind: provider.kind },
          configured: cfg.configured,
          selectable: chat && cfg.configured && decision.outcome === "ALLOW",
          selectableReason: !chat ? "not a chat model" : !cfg.configured ? cfg.reason : decision.outcome === "ALLOW" ? null : decision.reasonCodes.join(", "),
        };
      });
      return { items };
    });
  });

  app.get("/v1/workspaces/:workspaceId/models/:modelId", async (req) => {
    const p = principalOf(req);
    const { workspaceId, modelId } = ModelParams.parse(req.params);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "workspace.read", resource: { kind: "WORKSPACE", id: workspaceId, workspaceId }, purpose: "model detail", modelVersionId: null, informationPrivacyClass: null });
      const found = await getModel(tx, modelId);
      if (!found) throw new ApiHttpError(404, "NOT_FOUND", "Model not found.");
      const { credentialRef: _omit, ...provider } = found.provider; // never expose where the secret lives
      const statusHistory = (await tx.query("SELECT from_status, to_status, reason, created_at FROM model_status_changes WHERE model_version_id = $1 ORDER BY created_at DESC", [modelId])).rows;
      return { model: found.model, provider, evaluationRuns: await listRunsForModel(tx, modelId), statusHistory };
    });
  });

  app.get("/v1/workspaces/:workspaceId/models/:modelId/health", async (req) => {
    const p = principalOf(req);
    const { workspaceId, modelId } = ModelParams.parse(req.params);
    await withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, (tx) =>
      ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "workspace.read", resource: { kind: "WORKSPACE", id: workspaceId, workspaceId }, purpose: "model health", modelVersionId: null, informationPrivacyClass: null }),
    );
    return ctx.gateway.health(modelId);
  });

  /* ------------------------------------------------ platform administration */

  app.post("/v1/workspaces/:workspaceId/models", async (req, reply) => {
    const p = principalOf(req);
    const { workspaceId } = WsParams.parse(req.params);
    const input = RegisterModelInput.parse(req.body);
    const model = await withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "model.register", resource: { kind: "MODEL_VERSION", id: null }, purpose: "register model", modelVersionId: null, informationPrivacyClass: null }, { ipAddress: req.ip });
      // New registrations always start untested, whatever the caller claims.
      const created = await registerModel(tx, { ...input, evaluationStatus: "UNTESTED" });
      await recordAudit(tx, { workspaceId: null, actorIdentityId: p.actingIdentity.id, actorUserId: p.user.id, eventType: "model.registered", resourceKind: "MODEL_VERSION", resourceId: created.id, outcome: "SUCCESS", details: { providerModelName: created.providerModelName, baseModel: created.baseModel, weightsHash: created.weightsHash }, ...clientMeta(req) });
      return created;
    });
    return reply.status(201).send(model);
  });

  app.post("/v1/workspaces/:workspaceId/models/:modelId/status", async (req) => {
    const p = principalOf(req);
    const { workspaceId, modelId } = ModelParams.parse(req.params);
    const body = z.object({ status: EvaluationStatus, reason: z.string().max(2000).optional(), evaluationRunId: z.string().uuid().optional() }).parse(req.body);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "model.approve", resource: { kind: "MODEL_VERSION", id: modelId }, purpose: "change status", modelVersionId: null, informationPrivacyClass: null }, { ipAddress: req.ip });
      if (body.status === "APPROVED") {
        // Approval requires at least one completed evaluation run on record.
        const runs = await listRunsForModel(tx, modelId);
        if (!runs.some((r) => r.status === "COMPLETED")) {
          throw new ApiHttpError(409, "EVALUATION_REQUIRED", "A model cannot be approved without at least one completed evaluation run.");
        }
      }
      const model = await setEvaluationStatus(tx, modelId, body.status, p.actingIdentity.id, body.reason ?? null, body.evaluationRunId ?? null);
      await recordAudit(tx, { workspaceId: null, actorIdentityId: p.actingIdentity.id, actorUserId: p.user.id, eventType: "model.status_changed", resourceKind: "MODEL_VERSION", resourceId: modelId, outcome: "SUCCESS", details: { to: body.status, reason: body.reason }, ...clientMeta(req) });
      return model;
    });
  });

  app.post("/v1/workspaces/:workspaceId/models/:modelId/enabled", async (req) => {
    const p = principalOf(req);
    const { workspaceId, modelId } = ModelParams.parse(req.params);
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "model.disable", resource: { kind: "MODEL_VERSION", id: modelId }, purpose: "toggle model", modelVersionId: null, informationPrivacyClass: null }, { ipAddress: req.ip });
      await setModelEnabled(tx, modelId, body.enabled);
      return { id: modelId, enabled: body.enabled };
    });
  });

  app.post("/v1/workspaces/:workspaceId/models/:modelId/evaluate", async (req, reply) => {
    const p = principalOf(req);
    const { workspaceId, modelId } = ModelParams.parse(req.params);
    const body = z.object({ suiteSlug: z.string(), baselineModelVersionId: z.string().uuid().optional() }).parse(req.body);
    const job = await withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "model.evaluate", resource: { kind: "MODEL_VERSION", id: modelId }, purpose: "run evaluation", modelVersionId: null, informationPrivacyClass: null }, { ipAddress: req.ip });
      return ctx.queue.enqueue(tx, {
        type: "evaluation.run_suite",
        workspaceId,
        actingIdentityId: p.actingIdentity.id,
        payload: { suiteSlug: body.suiteSlug, modelVersionId: modelId, baselineModelVersionId: body.baselineModelVersionId ?? null, workspaceId, userId: p.user.id },
      });
    });
    if (ctx.config.AE_INLINE_JOBS) await ctx.jobRunner.runOnce();
    return reply.status(202).send({ job });
  });
}
