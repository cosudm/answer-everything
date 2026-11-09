import { createHmac, randomBytes } from "node:crypto";
import type { Database, Queryable, Tx } from "@ae/database";
import { iso, isoRequired, withTransaction } from "@ae/database";
import type {
  ActingIdentity,
  LoginInput,
  Principal,
  RegisterInput,
  Session,
  User,
  Workspace,
} from "@ae/domain";
import { WorkspaceSettings } from "@ae/domain";
import type { Logger } from "@ae/observability";
import { recordAudit } from "@ae/provenance";
import { hashPassword, passwordPolicyViolation, verifyPassword } from "./passwords.js";

export class IdentityError extends Error {
  constructor(
    public readonly code:
      | "EMAIL_TAKEN"
      | "WEAK_PASSWORD"
      | "INVALID_CREDENTIALS"
      | "ACCOUNT_LOCKED"
      | "ACCOUNT_INACTIVE"
      | "SESSION_INVALID",
    message: string,
  ) {
    super(message);
  }
}

export interface IdentityConfig {
  sessionSecret: string;
  sessionTtlMinutes: number;
  refreshTtlDays: number;
  /** Failed attempts within the window that lock the account. */
  lockoutThreshold?: number;
  lockoutWindowMinutes?: number;
  defaultWorkspaceBudgetUsd?: number;
}

export interface RequestMeta {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  session: Session;
}

export interface RegistrationResult {
  principal: Principal;
  workspace: Workspace;
  tokens: IssuedTokens;
}

/**
 * Local identity provider. Runs on the ae_identity pool because registration
 * and login happen before a tenant context exists. Everything it writes is
 * limited to identity tables plus the user's personal workspace.
 *
 * OIDC federation (Entra External ID / Auth0 / Clerk) plugs in behind the same
 * `Principal` shape; see docs/SECURITY.md for the status of that work.
 */
export class IdentityService {
  constructor(
    private readonly db: Database,
    private readonly config: IdentityConfig,
    private readonly log: Logger,
  ) {
    if (!config.sessionSecret || config.sessionSecret.length < 32) {
      throw new Error("AE_SESSION_SECRET must be at least 32 characters");
    }
  }

  /* ---------------------------------------------------------------- tokens */

  private hashToken(token: string): string {
    return createHmac("sha256", this.config.sessionSecret).update(token).digest("base64url");
  }

  private newToken(): string {
    return randomBytes(32).toString("base64url");
  }

  /* ---------------------------------------------------------- registration */

  async register(input: RegisterInput, meta: RequestMeta = {}): Promise<RegistrationResult> {
    const violation = passwordPolicyViolation(input.password, input.email);
    if (violation) throw new IdentityError("WEAK_PASSWORD", violation);
    const emailNormalized = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);

    return withTransaction(this.db.identity, async (tx) => {
      const existing = await tx.query(
        "SELECT 1 FROM users WHERE email_normalized = $1 AND deleted_at IS NULL",
        [emailNormalized],
      );
      if (existing.rowCount)
        throw new IdentityError("EMAIL_TAKEN", "An account with this email already exists.");

      const userRes = await tx.query(
        `INSERT INTO users (email, email_normalized, password_hash, display_name)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [input.email.trim(), emailNormalized, passwordHash, input.displayName.trim()],
      );
      const user = toUser(userRes.rows[0]);

      const identityRes = await tx.query(
        `INSERT INTO acting_identities (kind, user_id, display_name) VALUES ('USER', $1, $2) RETURNING *`,
        [user.id, user.displayName],
      );
      const identity = toIdentity(identityRes.rows[0]);

      const settings = WorkspaceSettings.parse({
        monthlyBudgetUsd: this.config.defaultWorkspaceBudgetUsd ?? 25,
      });
      const wsRes = await tx.query(
        `INSERT INTO workspaces (slug, name, kind, owner_user_id, settings)
         VALUES ($1, $2, 'PERSONAL', $3, $4) RETURNING *`,
        [
          await uniqueSlug(tx, slugify(user.displayName)),
          `${user.displayName}'s workspace`,
          user.id,
          JSON.stringify(settings),
        ],
      );
      const workspace = toWorkspace(wsRes.rows[0]);
      await tx.query(
        `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'OWNER')`,
        [workspace.id, user.id],
      );

      const tokens = await this.issueSession(tx, user, identity, meta);
      await recordAudit(tx, {
        workspaceId: workspace.id,
        actorIdentityId: identity.id,
        actorUserId: user.id,
        eventType: "auth.register",
        outcome: "SUCCESS",
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      await recordAudit(tx, {
        workspaceId: workspace.id,
        actorIdentityId: identity.id,
        actorUserId: user.id,
        eventType: "workspace.created",
        resourceKind: "WORKSPACE",
        resourceId: workspace.id,
        outcome: "SUCCESS",
      });
      this.log.info({ userId: user.id, workspaceId: workspace.id }, "user registered");
      return {
        principal: { user, actingIdentity: identity, sessionId: tokens.session.id },
        workspace,
        tokens,
      };
    });
  }

  /* ----------------------------------------------------------------- login */

  async login(
    input: LoginInput,
    meta: RequestMeta = {},
  ): Promise<{ principal: Principal; tokens: IssuedTokens }> {
    const emailNormalized = normalizeEmail(input.email);
    const threshold = this.config.lockoutThreshold ?? 10;
    const windowMin = this.config.lockoutWindowMinutes ?? 15;

    return withTransaction(this.db.identity, async (tx) => {
      const recentFailures = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM login_attempts
         WHERE email_normalized = $1 AND succeeded = false AND created_at > now() - ($2 * interval '1 minute')`,
        [emailNormalized, windowMin],
      );
      if ((recentFailures.rows[0]?.n ?? 0) >= threshold) {
        await this.recordAttempt(tx, emailNormalized, meta, false);
        await recordAudit(tx, {
          eventType: "auth.login_failed",
          outcome: "DENIED",
          details: { reason: "locked" },
        });
        throw new IdentityError("ACCOUNT_LOCKED", "Too many failed attempts. Try again later.");
      }

      const res = await tx.query(
        `SELECT * FROM users WHERE email_normalized = $1 AND deleted_at IS NULL`,
        [emailNormalized],
      );
      const row = res.rows[0];
      // Constant-ish time: verify against a dummy hash when the user does not exist.
      const ok = row?.password_hash
        ? await verifyPassword(input.password, row.password_hash)
        : await verifyPassword(input.password, DUMMY_HASH).then(() => false);
      if (!row || !ok) {
        await this.recordAttempt(tx, emailNormalized, meta, false);
        await recordAudit(tx, {
          actorUserId: row?.id ?? null,
          eventType: "auth.login_failed",
          outcome: "FAILURE",
          ipAddress: meta.ipAddress,
          userAgent: meta.userAgent,
        });
        throw new IdentityError("INVALID_CREDENTIALS", "Email or password is incorrect.");
      }
      const user = toUser(row);
      if (user.status !== "ACTIVE") {
        throw new IdentityError("ACCOUNT_INACTIVE", "This account is not active.");
      }
      const idRes = await tx.query(
        `SELECT * FROM acting_identities WHERE kind = 'USER' AND user_id = $1 AND revoked_at IS NULL`,
        [user.id],
      );
      const identity = toIdentity(idRes.rows[0]);
      const tokens = await this.issueSession(tx, user, identity, meta);
      await this.recordAttempt(tx, emailNormalized, meta, true);
      await recordAudit(tx, {
        actorIdentityId: identity.id,
        actorUserId: user.id,
        eventType: "auth.login",
        outcome: "SUCCESS",
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      return {
        principal: { user, actingIdentity: identity, sessionId: tokens.session.id },
        tokens,
      };
    });
  }

  private async recordAttempt(
    tx: Tx,
    emailNormalized: string,
    meta: RequestMeta,
    succeeded: boolean,
  ) {
    await tx.query(
      `INSERT INTO login_attempts (email_normalized, ip_address, succeeded) VALUES ($1, $2, $3)`,
      [emailNormalized, meta.ipAddress ?? null, succeeded],
    );
  }

  /* -------------------------------------------------------------- sessions */

  private async issueSession(
    tx: Tx,
    user: User,
    identity: ActingIdentity,
    meta: RequestMeta,
    rotatedFromId: string | null = null,
  ): Promise<IssuedTokens> {
    const accessToken = this.newToken();
    const refreshToken = this.newToken();
    const res = await tx.query(
      `INSERT INTO sessions
         (user_id, acting_identity_id, token_hash, refresh_token_hash, expires_at, refresh_expires_at,
          rotated_from_id, ip_address, user_agent)
       VALUES ($1,$2,$3,$4, now() + ($5 * interval '1 minute'), now() + ($6 * interval '1 day'), $7, $8, $9)
       RETURNING *`,
      [
        user.id,
        identity.id,
        this.hashToken(accessToken),
        this.hashToken(refreshToken),
        this.config.sessionTtlMinutes,
        this.config.refreshTtlDays,
        rotatedFromId,
        meta.ipAddress ?? null,
        meta.userAgent ? meta.userAgent.slice(0, 512) : null,
      ],
    );
    return { accessToken, refreshToken, session: toSession(res.rows[0]) };
  }

  /** Resolves an access token to a Principal, or null when invalid/expired. */
  async resolveSession(accessToken: string | undefined | null): Promise<Principal | null> {
    if (!accessToken) return null;
    const tokenHash = this.hashToken(accessToken);
    const res = await this.db.identity.query(
      `SELECT s.id AS session_id, s.expires_at, s.revoked_at,
              row_to_json(u.*) AS user_row, row_to_json(i.*) AS identity_row
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN acting_identities i ON i.id = s.acting_identity_id
       WHERE s.token_hash = $1`,
      [tokenHash],
    );
    const row = res.rows[0];
    if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) return null;
    const user = toUser(row.user_row);
    if (user.status !== "ACTIVE" || user.deletedAt) return null;
    const identity = toIdentity(row.identity_row);
    if (identity.revokedAt) return null;
    // Fire-and-forget last_seen update; failures are logged, never surfaced.
    this.db.identity
      .query(
        "UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'",
        [row.session_id],
      )
      .catch((err) => this.log.warn({ err }, "last_seen update failed"));
    return { user, actingIdentity: identity, sessionId: row.session_id };
  }

  /** Rotating refresh: the old session is revoked and a new pair is issued. */
  async refresh(
    refreshToken: string,
    meta: RequestMeta = {},
  ): Promise<{ principal: Principal; tokens: IssuedTokens }> {
    const hash = this.hashToken(refreshToken);
    type Outcome =
      | { kind: "ok"; principal: Principal; tokens: IssuedTokens }
      | { kind: "expired" }
      | { kind: "reused"; userId: string };
    const outcome = await withTransaction(this.db.identity, async (tx): Promise<Outcome> => {
      const res = await tx.query(
        `SELECT s.*, row_to_json(u.*) AS user_row, row_to_json(i.*) AS identity_row
         FROM sessions s JOIN users u ON u.id = s.user_id JOIN acting_identities i ON i.id = s.acting_identity_id
         WHERE s.refresh_token_hash = $1 FOR UPDATE OF s`,
        [hash],
      );
      const row = res.rows[0];
      if (!row || new Date(row.refresh_expires_at) < new Date()) return { kind: "expired" };
      if (row.revoked_at) {
        // Reuse of a rotated refresh token is a theft signal: revoke the whole
        // chain. This write must COMMIT, so the error is thrown after the
        // transaction, not inside it.
        await tx.query(
          `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
          [row.user_id],
        );
        await recordAudit(tx, {
          actorUserId: row.user_id,
          eventType: "auth.session_revoked",
          outcome: "DENIED",
          details: { reason: "refresh_token_reuse" },
        });
        return { kind: "reused", userId: row.user_id };
      }
      await tx.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [row.id]);
      const user = toUser(row.user_row);
      const identity = toIdentity(row.identity_row);
      const tokens = await this.issueSession(tx, user, identity, meta, row.id);
      await recordAudit(tx, {
        actorIdentityId: identity.id,
        actorUserId: user.id,
        eventType: "auth.session_refreshed",
        outcome: "SUCCESS",
      });
      return {
        kind: "ok",
        principal: { user, actingIdentity: identity, sessionId: tokens.session.id },
        tokens,
      };
    });
    if (outcome.kind === "expired")
      throw new IdentityError("SESSION_INVALID", "Session expired. Sign in again.");
    if (outcome.kind === "reused") {
      this.log.warn(
        { userId: outcome.userId },
        "refresh token reuse detected; all sessions revoked",
      );
      throw new IdentityError("SESSION_INVALID", "Session invalidated. Sign in again.");
    }
    return { principal: outcome.principal, tokens: outcome.tokens };
  }

  async logout(accessToken: string | undefined | null): Promise<void> {
    if (!accessToken) return;
    const res = await this.db.identity.query(
      `UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL RETURNING user_id, acting_identity_id`,
      [this.hashToken(accessToken)],
    );
    const row = res.rows[0];
    if (row) {
      await recordAudit(this.db.identity, {
        actorIdentityId: row.acting_identity_id,
        actorUserId: row.user_id,
        eventType: "auth.logout",
        outcome: "SUCCESS",
      });
    }
  }

  /** Revokes every session of a user (password change, account deletion, admin action). */
  async revokeAllSessions(userId: string): Promise<number> {
    const res = await this.db.identity.query(
      `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    return res.rowCount ?? 0;
  }
}

const DUMMY_HASH =
  "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/* -------------------------------------------------------------- mapping */

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base.length >= 2 ? base : "workspace";
}

async function uniqueSlug(q: Queryable, base: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}-${randomBytes(2).toString("hex")}`;
    const r = await q.query("SELECT 1 FROM workspaces WHERE slug = $1 AND deleted_at IS NULL", [
      candidate,
    ]);
    if (!r.rowCount) return candidate;
  }
  return `${base}-${randomBytes(4).toString("hex")}`;
}

export function toUser(r: Record<string, unknown>): User {
  return {
    id: r.id as string,
    email: r.email as string,
    emailVerifiedAt: iso(r.email_verified_at as string | null),
    displayName: r.display_name as string,
    status: r.status as User["status"],
    mfaEnabled: Boolean(r.mfa_enabled),
    createdAt: isoRequired(r.created_at as string),
    updatedAt: isoRequired(r.updated_at as string),
    deletedAt: iso(r.deleted_at as string | null),
  };
}

export function toIdentity(r: Record<string, unknown>): ActingIdentity {
  return {
    id: r.id as string,
    kind: r.kind as ActingIdentity["kind"],
    userId: (r.user_id as string | null) ?? null,
    delegatedByUserId: (r.delegated_by_user_id as string | null) ?? null,
    displayName: r.display_name as string,
    modelVersionId: (r.model_version_id as string | null) ?? null,
    createdAt: isoRequired(r.created_at as string),
    revokedAt: iso(r.revoked_at as string | null),
  };
}

export function toSession(r: Record<string, unknown>): Session {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    actingIdentityId: r.acting_identity_id as string,
    expiresAt: isoRequired(r.expires_at as string),
    refreshExpiresAt: isoRequired(r.refresh_expires_at as string),
    createdAt: isoRequired(r.created_at as string),
    lastSeenAt: isoRequired(r.last_seen_at as string),
    revokedAt: iso(r.revoked_at as string | null),
    ipAddress: (r.ip_address as string | null) ?? null,
    userAgent: (r.user_agent as string | null) ?? null,
  };
}

export function toWorkspace(r: Record<string, unknown>): Workspace {
  return {
    id: r.id as string,
    slug: r.slug as string,
    name: r.name as string,
    kind: r.kind as Workspace["kind"],
    ownerUserId: r.owner_user_id as string,
    settings: WorkspaceSettings.parse(r.settings ?? {}),
    createdAt: isoRequired(r.created_at as string),
    updatedAt: isoRequired(r.updated_at as string),
    deletedAt: iso(r.deleted_at as string | null),
  };
}
