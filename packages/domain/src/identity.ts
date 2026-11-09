import { z } from "zod";
import { Id, Metadata, Timestamp } from "./common.js";

/**
 * A human account. Authentication (how the account proves itself) is handled by
 * the identity package; this is the durable record.
 */
export const UserStatus = z.enum(["ACTIVE", "SUSPENDED", "PENDING_DELETION", "DELETED"]);
export type UserStatus = z.infer<typeof UserStatus>;

export const User = z.object({
  id: Id,
  email: z.string().email(),
  emailVerifiedAt: Timestamp.nullable(),
  displayName: z.string().min(1).max(120),
  status: UserStatus,
  mfaEnabled: z.boolean(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  deletedAt: Timestamp.nullable(),
});
export type User = z.infer<typeof User>;

/**
 * Identity Governed Logic separates WHO is acting from AS WHOM they act.
 * An ActingIdentity is the principal a request runs as. A user acting as
 * themselves has a USER identity. Background work runs as a SERVICE identity.
 * Model-driven agents run as AGENT identities bound to the delegating user so
 * authority can never exceed the delegator's.
 */
export const IdentityKind = z.enum(["USER", "SERVICE", "AGENT"]);
export type IdentityKind = z.infer<typeof IdentityKind>;

export const ActingIdentity = z.object({
  id: Id,
  kind: IdentityKind,
  /** The human this identity ultimately belongs to (null for platform services). */
  userId: Id.nullable(),
  /** For AGENT identities: the user whose authority is delegated. */
  delegatedByUserId: Id.nullable(),
  displayName: z.string(),
  /** For AGENT identities: the model version that drives it, if any. */
  modelVersionId: Id.nullable(),
  createdAt: Timestamp,
  revokedAt: Timestamp.nullable(),
});
export type ActingIdentity = z.infer<typeof ActingIdentity>;

/**
 * Sessions are opaque, server-side records. The browser only ever holds the
 * random token (httpOnly cookie); the database stores an HMAC of it.
 */
export const Session = z.object({
  id: Id,
  userId: Id,
  actingIdentityId: Id,
  expiresAt: Timestamp,
  refreshExpiresAt: Timestamp,
  createdAt: Timestamp,
  lastSeenAt: Timestamp,
  revokedAt: Timestamp.nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export type Session = z.infer<typeof Session>;

/** The resolved caller of a request, after authentication. */
export const Principal = z.object({
  user: User,
  actingIdentity: ActingIdentity,
  sessionId: Id,
});
export type Principal = z.infer<typeof Principal>;

export const RegisterInput = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(256),
  displayName: z.string().min(1).max(120),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const LoginInput = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const IdentityProviderKind = z.enum(["LOCAL_PASSWORD", "OIDC"]);
export type IdentityProviderKind = z.infer<typeof IdentityProviderKind>;

export const IdentityProviderConfig = z.object({
  kind: IdentityProviderKind,
  issuer: z.string().url().optional(),
  clientId: z.string().optional(),
  metadata: Metadata.default({}),
});
export type IdentityProviderConfig = z.infer<typeof IdentityProviderConfig>;
