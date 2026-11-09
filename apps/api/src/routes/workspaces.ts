import { withTenant } from "@ae/database";
import { CreateProjectInput, CreateWorkspaceInput, WorkspaceSettings } from "@ae/domain";
import { createProject, createWorkspace, getProject, getWorkspace, listProjects, listWorkspacesForUser, slugify, updateWorkspaceSettings } from "@ae/identity";
import { workspaceSpend } from "@ae/orchestration";
import { listAudit, recordAudit } from "@ae/provenance";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { clientMeta, principalOf, requireAuth } from "../plugins/auth.js";
import { ApiHttpError } from "../plugins/errors.js";

const Params = z.object({ workspaceId: z.string().uuid() });

export async function workspaceRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook("preHandler", requireAuth);

  app.get("/v1/workspaces", async (req) => {
    const p = principalOf(req);
    const items = await withTenant(ctx.db.app, { userId: p.user.id, workspaceId: null, identityId: p.actingIdentity.id }, (tx) => listWorkspacesForUser(tx, p.user.id));
    return { items };
  });

  app.post("/v1/workspaces", async (req, reply) => {
    const p = principalOf(req);
    const input = CreateWorkspaceInput.parse(req.body);
    const ws = await withTenant(ctx.db.app, { userId: p.user.id, workspaceId: null, identityId: p.actingIdentity.id }, async (tx) => {
      const slug = `${slugify(input.name)}-${Math.random().toString(36).slice(2, 6)}`;
      const created = await createWorkspace(tx, {
        name: input.name,
        kind: input.kind,
        ownerUserId: p.user.id,
        slug,
        settings: { monthlyBudgetUsd: ctx.config.AE_DEFAULT_WORKSPACE_MONTHLY_BUDGET_USD, allowExperimentalModels: ctx.config.AE_DEFAULT_ALLOW_EXPERIMENTAL && !ctx.config.isProd },
      });
      await recordAudit(tx, { workspaceId: created.id, actorIdentityId: p.actingIdentity.id, actorUserId: p.user.id, eventType: "workspace.created", resourceKind: "WORKSPACE", resourceId: created.id, outcome: "SUCCESS", ...clientMeta(req) });
      return created;
    });
    return reply.status(201).send(ws);
  });

  app.get("/v1/workspaces/:workspaceId", async (req) => {
    const p = principalOf(req);
    const { workspaceId } = Params.parse(req.params);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      await ctx.authz.require(tx, {
        userId: p.user.id,
        actingIdentityId: p.actingIdentity.id,
        workspaceId,
        action: "workspace.read",
        resource: { kind: "WORKSPACE", id: workspaceId, workspaceId },
        purpose: "view workspace",
        modelVersionId: null,
        informationPrivacyClass: null,
      });
      const ws = await getWorkspace(tx, workspaceId);
      if (!ws) throw new ApiHttpError(404, "NOT_FOUND", "Workspace not found.");
      const spend = await workspaceSpend(tx, workspaceId);
      return { ...ws, spend };
    });
  });

  app.patch("/v1/workspaces/:workspaceId/settings", async (req) => {
    const p = principalOf(req);
    const { workspaceId } = Params.parse(req.params);
    const patch = WorkspaceSettings.partial().parse(req.body);
    if (ctx.config.isProd && patch.allowExperimentalModels) {
      // Allowed, but recorded: enabling experimental models in prod is a governance event.
      ctx.logger.warn({ workspaceId, userId: p.user.id }, "experimental models enabled in production workspace");
    }
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      await ctx.authz.require(tx, {
        userId: p.user.id,
        actingIdentityId: p.actingIdentity.id,
        workspaceId,
        action: "workspace.settings.update",
        resource: { kind: "WORKSPACE", id: workspaceId, workspaceId },
        purpose: "update settings",
        modelVersionId: null,
        informationPrivacyClass: null,
      }, { ipAddress: req.ip });
      const ws = await updateWorkspaceSettings(tx, workspaceId, patch);
      if (!ws) throw new ApiHttpError(404, "NOT_FOUND", "Workspace not found.");
      await recordAudit(tx, { workspaceId, actorIdentityId: p.actingIdentity.id, actorUserId: p.user.id, eventType: "workspace.settings_updated", resourceKind: "WORKSPACE", resourceId: workspaceId, outcome: "SUCCESS", details: { changed: Object.keys(patch) }, ...clientMeta(req) });
      return ws;
    });
  });

  app.get("/v1/workspaces/:workspaceId/usage", async (req) => {
    const p = principalOf(req);
    const { workspaceId } = Params.parse(req.params);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "workspace.read", resource: { kind: "WORKSPACE", id: workspaceId, workspaceId }, purpose: "usage", modelVersionId: null, informationPrivacyClass: null });
      return workspaceSpend(tx, workspaceId);
    });
  });

  app.get("/v1/workspaces/:workspaceId/audit", async (req) => {
    const p = principalOf(req);
    const { workspaceId } = Params.parse(req.params);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), before: z.string().datetime().optional() }).parse(req.query);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "audit.read", resource: { kind: "AUDIT_LOG", id: null, workspaceId }, purpose: "review audit", modelVersionId: null, informationPrivacyClass: null });
      return { items: await listAudit(tx, { workspaceId, limit: q.limit, before: q.before }) };
    });
  });

  /* --------------------------------------------------------------- projects */

  app.get("/v1/workspaces/:workspaceId/projects", async (req) => {
    const p = principalOf(req);
    const { workspaceId } = Params.parse(req.params);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "project.read", resource: { kind: "PROJECT", id: null, workspaceId }, purpose: "list projects", modelVersionId: null, informationPrivacyClass: null });
      return { items: await listProjects(tx, workspaceId) };
    });
  });

  app.post("/v1/workspaces/:workspaceId/projects", async (req, reply) => {
    const p = principalOf(req);
    const { workspaceId } = Params.parse(req.params);
    const input = CreateProjectInput.parse(req.body);
    const project = await withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      const ws = await getWorkspace(tx, workspaceId);
      if (!ws) throw new ApiHttpError(404, "NOT_FOUND", "Workspace not found.");
      const privacyClass = input.privacyClass ?? ws.settings.defaultPrivacyClass;
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "project.create", resource: { kind: "PROJECT", id: null, workspaceId, privacyClass }, purpose: "create project", modelVersionId: null, informationPrivacyClass: null });
      return createProject(tx, { workspaceId, name: input.name, description: input.description ?? null, instructions: input.instructions ?? null, privacyClass, createdByUserId: p.user.id });
    });
    return reply.status(201).send(project);
  });

  app.get("/v1/workspaces/:workspaceId/projects/:projectId", async (req) => {
    const p = principalOf(req);
    const { workspaceId, projectId } = Params.extend({ projectId: z.string().uuid() }).parse(req.params);
    return withTenant(ctx.db.app, { userId: p.user.id, workspaceId, identityId: p.actingIdentity.id }, async (tx) => {
      const project = await getProject(tx, projectId);
      if (!project) throw new ApiHttpError(404, "NOT_FOUND", "Project not found.");
      await ctx.authz.require(tx, { userId: p.user.id, actingIdentityId: p.actingIdentity.id, workspaceId, action: "project.read", resource: { kind: "PROJECT", id: project.id, workspaceId: project.workspaceId }, purpose: "view project", modelVersionId: null, informationPrivacyClass: null });
      return project;
    });
  });
}
