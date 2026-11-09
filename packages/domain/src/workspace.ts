import { z } from "zod";
import { Id, Metadata, PrivacyClass, Timestamp } from "./common.js";

export const WorkspaceKind = z.enum(["PERSONAL", "ORGANIZATION"]);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;

export const WorkspaceRole = z.enum(["OWNER", "ADMIN", "MEMBER", "VIEWER"]);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

export const ROLE_RANK: Record<WorkspaceRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export const WorkspaceSettings = z.object({
  /** Highest privacy class members may assign to knowledge in this workspace. */
  maxPrivacyClass: PrivacyClass.default("CONFIDENTIAL"),
  /** Default class for newly created knowledge and conversations. */
  defaultPrivacyClass: PrivacyClass.default("INTERNAL"),
  /** Whether EXPERIMENTAL / TESTING models may be selected here. */
  allowExperimentalModels: z.boolean().default(false),
  /** Whether models hosted on commercial APIs may be used at all. */
  allowCommercialProviders: z.boolean().default(true),
  /** Monthly model-spend ceiling. Enforced by the gateway before each run. */
  monthlyBudgetUsd: z.number().nonnegative().default(25),
  /** Retention for conversations in days; null = keep until deleted. */
  conversationRetentionDays: z.number().int().positive().nullable().default(null),
  /** Memory (confirmed facts about the user) is opt-in. */
  memoryEnabled: z.boolean().default(false),
  /** Web access for research strategies. */
  webAccessEnabled: z.boolean().default(false),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

export const Workspace = z.object({
  id: Id,
  slug: z.string().min(2).max(64),
  name: z.string().min(1).max(120),
  kind: WorkspaceKind,
  ownerUserId: Id,
  settings: WorkspaceSettings,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  deletedAt: Timestamp.nullable(),
});
export type Workspace = z.infer<typeof Workspace>;

export const WorkspaceMembership = z.object({
  workspaceId: Id,
  userId: Id,
  role: WorkspaceRole,
  createdAt: Timestamp,
});
export type WorkspaceMembership = z.infer<typeof WorkspaceMembership>;

/**
 * Projects give persistent context: instructions, attached knowledge, and
 * conversations. Entering a project never widens the user's authority; it
 * only scopes retrieval.
 */
export const Project = z.object({
  id: Id,
  workspaceId: Id,
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable(),
  /** Standing instructions prepended (as SYSTEM context) to every ask in the project. */
  instructions: z.string().max(20_000).nullable(),
  privacyClass: PrivacyClass,
  createdByUserId: Id,
  metadata: Metadata,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  archivedAt: Timestamp.nullable(),
});
export type Project = z.infer<typeof Project>;

export const CreateWorkspaceInput = z.object({
  name: z.string().min(1).max(120),
  kind: WorkspaceKind.default("ORGANIZATION"),
});

export const CreateProjectInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  instructions: z.string().max(20_000).optional(),
  privacyClass: PrivacyClass.optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;
