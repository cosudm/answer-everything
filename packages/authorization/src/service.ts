import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withTenant, type Queryable } from "@ae/database";
import type {
  AuthorizationDecision,
  AuthorizationDecisionRecord,
  AuthorizationRequest,
  WorkspaceSettings,
} from "@ae/domain";
import { WorkspaceSettings as WorkspaceSettingsSchema } from "@ae/domain";
import { metrics, type Logger } from "@ae/observability";
import { recordAudit } from "@ae/provenance";
import { evaluate, type PolicyFacts } from "./policy.js";

export class AuthorizationDeniedError extends Error {
  constructor(
    public readonly decision: AuthorizationDecision,
    public readonly request: AuthorizationRequest,
  ) {
    super(`Authorization denied: ${decision.reasonCodes.join(", ")}`);
  }
}

export interface FactsLoader {
  load(q: Queryable, req: AuthorizationRequest): Promise<PolicyFacts>;
}

/**
 * Loads policy facts from the database. Runs inside the caller's tenant
 * transaction, so RLS already constrains what can be seen; the loader only
 * assembles facts, it does not decide.
 */
export class DatabaseFactsLoader implements FactsLoader {
  async load(q: Queryable, req: AuthorizationRequest): Promise<PolicyFacts> {
    const [identity, user, membership, workspace, model] = await Promise.all([
      q
        .query(`SELECT kind, revoked_at, user_id FROM acting_identities WHERE id = $1`, [
          req.actingIdentityId,
        ])
        .then((r) =>
          r.rows[0]
            ? {
                kind: r.rows[0].kind,
                revoked: Boolean(r.rows[0].revoked_at),
                userId: r.rows[0].user_id ?? null,
              }
            : null,
        ),
      req.userId
        ? q
            .query(`SELECT platform_role, status FROM users WHERE id = $1`, [req.userId])
            .then((r) =>
              r.rows[0]
                ? { platformRole: r.rows[0].platform_role, status: r.rows[0].status }
                : null,
            )
        : Promise.resolve(null),
      req.userId && req.workspaceId
        ? q
            .query(
              `SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`,
              [req.workspaceId, req.userId],
            )
            .then((r) => (r.rows[0] ? { role: r.rows[0].role } : null))
        : Promise.resolve(null),
      req.workspaceId
        ? q
            .query(`SELECT settings FROM workspaces WHERE id = $1 AND deleted_at IS NULL`, [
              req.workspaceId,
            ])
            .then((r) =>
              r.rows[0]
                ? {
                    settings: WorkspaceSettingsSchema.parse(
                      r.rows[0].settings ?? {},
                    ) as WorkspaceSettings,
                  }
                : null,
            )
        : Promise.resolve(null),
      req.modelVersionId
        ? q
            .query(
              `SELECT m.enabled, m.evaluation_status, m.deployment_type, m.behavioral_profile,
                      m.privacy_classes_allowed, p.enabled AS provider_enabled
               FROM model_versions m JOIN providers p ON p.id = m.provider_id WHERE m.id = $1`,
              [req.modelVersionId],
            )
            .then((r) =>
              r.rows[0]
                ? {
                    enabled: r.rows[0].enabled,
                    evaluationStatus: r.rows[0].evaluation_status,
                    deploymentType: r.rows[0].deployment_type,
                    behavioralProfile: r.rows[0].behavioral_profile,
                    privacyClassesAllowed: r.rows[0].privacy_classes_allowed,
                    providerEnabled: r.rows[0].provider_enabled,
                  }
                : null,
            )
        : Promise.resolve(null),
    ]);
    return { identity, user, membership, workspace, model };
  }
}

export interface AuthorizeOptions {
  /** Persist the decision even when allowed (used for model use and retrieval so the Answer Path can show it). */
  record?: boolean;
  ipAddress?: string | null;
}

/**
 * The single entry point for authorization. Every protected operation calls
 * `authorize` (or `require`) before touching data, assembling context, or
 * invoking a model. Denials are persisted and audited.
 */
export class AuthorizationService {
  /**
   * @param recordPool ae_app pool used to persist decisions and denial audit
   *   events in their OWN transaction. Callers typically throw on DENY inside
   *   their transaction, which would roll back anything written through it;
   *   denials must survive that.
   */
  constructor(
    private readonly loader: FactsLoader,
    private readonly log: Logger,
    private readonly recordPool: pg.Pool | null = null,
  ) {}

  async authorize(
    q: Queryable,
    req: AuthorizationRequest,
    opts: AuthorizeOptions = {},
  ): Promise<AuthorizationDecisionRecord> {
    const facts = await this.loader.load(q, req);
    const decision = evaluate(req, facts);
    metrics.authzDecisions.inc({ outcome: decision.outcome, action: req.action });

    const shouldRecord =
      opts.record || decision.outcome !== "ALLOW" || decision.obligations?.recordAudit;
    let id = "00000000-0000-0000-0000-000000000000";
    const createdAt = new Date().toISOString();
    if (shouldRecord) {
      // No RETURNING: a denied non-member may insert the decision row but
      // cannot read it back under RLS, so the id is generated here.
      id = randomUUID();
      const persist = async (w: Queryable) => {
        await w.query(
          `INSERT INTO authorization_decisions
           (id, workspace_id, acting_identity_id, action, resource_kind, resource_id, outcome, policy_ids, reason_codes, obligations, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            id,
            req.workspaceId,
            req.actingIdentityId,
            req.action,
            req.resource.kind,
            req.resource.id,
            decision.outcome,
            decision.policyIds,
            decision.reasonCodes,
            decision.obligations ? JSON.stringify(decision.obligations) : null,
            createdAt,
          ],
        );
        if (decision.outcome !== "ALLOW") {
          await recordAudit(w, {
            workspaceId: req.workspaceId,
            actorIdentityId: req.actingIdentityId,
            actorUserId: req.userId,
            eventType:
              decision.outcome === "DENY"
                ? "authorization.denied"
                : "authorization.requires_approval",
            resourceKind: req.resource.kind,
            resourceId: req.resource.id,
            outcome: "DENIED",
            ipAddress: opts.ipAddress,
            details: {
              action: req.action,
              reasonCodes: decision.reasonCodes,
              policyIds: decision.policyIds,
            },
          });
        }
      };
      if (this.recordPool) {
        await withTenant(
          this.recordPool,
          { userId: req.userId, workspaceId: req.workspaceId, identityId: req.actingIdentityId },
          persist,
        );
      } else {
        await persist(q);
      }
    }
    if (decision.outcome !== "ALLOW") {
      this.log.info(
        {
          action: req.action,
          resource: req.resource.kind,
          outcome: decision.outcome,
          reasons: decision.reasonCodes,
        },
        "authorization not allowed",
      );
    }
    return {
      ...decision,
      id,
      workspaceId: req.workspaceId,
      actingIdentityId: req.actingIdentityId,
      action: req.action,
      resourceKind: req.resource.kind,
      resourceId: req.resource.id,
      createdAt,
    };
  }

  /** Authorize or throw. */
  async require(
    q: Queryable,
    req: AuthorizationRequest,
    opts: AuthorizeOptions = {},
  ): Promise<AuthorizationDecisionRecord> {
    const decision = await this.authorize(q, req, opts);
    if (decision.outcome !== "ALLOW") throw new AuthorizationDeniedError(decision, req);
    return decision;
  }
}
