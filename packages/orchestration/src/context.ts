import { randomUUID } from "node:crypto";
import type { Queryable } from "@ae/database";
import { isoRequired } from "@ae/database";
import type {
  AnswerStrategy,
  ChatMessage,
  ContextManifest,
  ContextManifestItem,
  Message,
  PrivacyClass,
  SearchHit,
} from "@ae/domain";
import { PRIVACY_RANK, highestPrivacyClass } from "@ae/domain";
import { hybridSearch } from "@ae/knowledge";
import type { ModelGateway } from "@ae/model-gateway";
import type { Logger } from "@ae/observability";
import { buildSystemPrompt, type SourceBlock } from "./prompts.js";

export interface BuildContextInput {
  workspaceId: string;
  conversationId: string;
  userMessage: Message;
  history: Message[];
  projectId: string | null;
  projectInstructions: string | null;
  actingIdentityId: string;
  strategy: AnswerStrategy;
  /** Retrieval ceiling: the information class the chosen model path is cleared for. */
  maxPrivacyClass: PrivacyClass;
  /** Knowledge objects explicitly attached to this turn. */
  attachmentIds: string[];
  useKnowledge: boolean;
  tokenBudget: number;
  embeddingModelVersionId: string | null;
  gateway: ModelGateway;
  authorizationDecisionId: string | null;
  logger: Logger;
}

export interface BuiltContext {
  manifest: ContextManifest;
  system: string;
  messages: ChatMessage[];
  sources: SourceBlock[];
  /** Number of READY objects in scope that were excluded by the privacy ceiling. */
  filteredByPrivacy: number;
}

const estimate = (s: string) => Math.ceil(s.length / 4);

/**
 * Assembles the model context and the immutable manifest describing it.
 * Order: system + project instructions, then retrieved sources (authorized
 * and ranked), then conversation history newest-first until the budget is
 * spent, then the current question. Everything considered is recorded,
 * including items dropped for budget, so the Answer Path is complete.
 */
export async function buildContext(q: Queryable, input: BuildContextInput): Promise<BuiltContext> {
  const items: ContextManifestItem[] = [];
  let used = 0;

  // 1. Sources
  const sources: SourceBlock[] = [];
  let retrieval: ContextManifest["retrieval"] = null;
  let filteredByPrivacy = 0;
  if (input.useKnowledge || input.attachmentIds.length) {
    let queryEmbedding: number[] | null = null;
    let method: "hybrid" | "lexical" = "lexical";
    if (input.embeddingModelVersionId) {
      try {
        const emb = await input.gateway.embed({
          modelVersionId: input.embeddingModelVersionId,
          inputs: [input.userMessage.content.slice(0, 8000)],
          workspaceId: input.workspaceId,
          actingIdentityId: input.actingIdentityId,
          informationPrivacyClass: input.maxPrivacyClass,
        });
        queryEmbedding = emb.vectors[0] ?? null;
        method = "hybrid";
      } catch (err) {
        input.logger.warn(
          { err: (err as Error).message },
          "query embedding failed; falling back to lexical retrieval",
        );
      }
    }
    const hits: SearchHit[] = [];
    if (input.attachmentIds.length) {
      hits.push(
        ...(await hybridSearch(q, {
          workspaceId: input.workspaceId,
          query: input.userMessage.content,
          queryEmbedding,
          maxPrivacyClass: input.maxPrivacyClass,
          projectId: null,
          objectIds: input.attachmentIds,
          limit: 6,
        })),
      );
    }
    if (input.useKnowledge) {
      const more = await hybridSearch(q, {
        workspaceId: input.workspaceId,
        query: input.userMessage.content,
        queryEmbedding,
        maxPrivacyClass: input.maxPrivacyClass,
        projectId: input.projectId,
        limit: 8,
      });
      for (const h of more) if (!hits.some((x) => x.chunkId === h.chunkId)) hits.push(h);
    }
    // Count what the ceiling excluded, for transparency (never retrieved, only counted).
    const excluded = await q.query(
      `SELECT count(*)::int AS n FROM knowledge_objects o
       WHERE o.workspace_id = $1 AND o.deleted_at IS NULL AND o.status = 'READY' AND o.ai_use_permission = 'ALLOW'
         AND CASE o.privacy_class WHEN 'PUBLIC' THEN 0 WHEN 'INTERNAL' THEN 1 WHEN 'CONFIDENTIAL' THEN 2 ELSE 3 END > $2`,
      [input.workspaceId, PRIVACY_RANK[input.maxPrivacyClass]],
    );
    filteredByPrivacy = excluded.rows[0]?.n ?? 0;

    const sourceBudget = Math.floor(input.tokenBudget * 0.5);
    let sourceTokens = 0;
    let label = 1;
    for (const hit of hits) {
      const tokens = estimate(hit.content);
      const fits = sourceTokens + tokens <= sourceBudget;
      const item: ContextManifestItem = {
        id: randomUUID(),
        kind: input.attachmentIds.includes(hit.knowledgeObjectId)
          ? "ATTACHMENT"
          : "KNOWLEDGE_CHUNK",
        refId: hit.chunkId,
        knowledgeObjectId: hit.knowledgeObjectId,
        label: fits ? `S${label}` : null,
        privacyClass: hit.privacyClass,
        tokens,
        rank:
          items.filter((i) => i.kind === "KNOWLEDGE_CHUNK" || i.kind === "ATTACHMENT").length + 1,
        score: hit.score,
        included: fits,
        reason: fits
          ? `retrieved (${hit.lexicalRank != null ? `lexical #${hit.lexicalRank}` : ""}${hit.lexicalRank != null && hit.vectorRank != null ? ", " : ""}${hit.vectorRank != null ? `vector #${hit.vectorRank}` : ""})`
          : "dropped: source token budget exhausted",
        authorizationDecisionId: input.authorizationDecisionId,
      };
      items.push(item);
      if (fits) {
        sources.push({ label: `S${label}`, hit });
        sourceTokens += tokens;
        label++;
      }
    }
    used += sourceTokens;
    retrieval = {
      query: input.userMessage.content.slice(0, 500),
      candidates: hits.length,
      used: sources.length,
      method,
    };
  }

  // 2. System prompt
  const system = buildSystemPrompt({ projectInstructions: input.projectInstructions, sources });
  const systemTokens = estimate(system);
  items.unshift({
    id: randomUUID(),
    kind: "SYSTEM_INSTRUCTION",
    refId: null,
    knowledgeObjectId: null,
    label: null,
    privacyClass: "INTERNAL",
    tokens: systemTokens,
    rank: null,
    score: null,
    included: true,
    reason: "platform answering instructions",
    authorizationDecisionId: null,
  });
  if (input.projectInstructions?.trim()) {
    items.splice(1, 0, {
      id: randomUUID(),
      kind: "PROJECT_INSTRUCTION",
      refId: input.projectId,
      knowledgeObjectId: null,
      label: null,
      privacyClass: "INTERNAL",
      tokens: estimate(input.projectInstructions),
      rank: null,
      score: null,
      included: true,
      reason: "project instructions",
      authorizationDecisionId: null,
    });
  }
  used += systemTokens;

  // 3. History (newest first until budget), excluding the current message
  const questionTokens = estimate(input.userMessage.content);
  used += questionTokens;
  const historyBudget = Math.max(0, input.tokenBudget - used);
  const chosen: Message[] = [];
  let historyTokens = 0;
  const prior = input.history.filter(
    (m) =>
      m.id !== input.userMessage.id &&
      m.status === "COMPLETE" &&
      (m.role === "USER" || m.role === "ASSISTANT"),
  );
  for (const m of [...prior].reverse()) {
    const t = estimate(m.content);
    const fits = historyTokens + t <= historyBudget;
    items.push({
      id: randomUUID(),
      kind: "CONVERSATION_MESSAGE",
      refId: m.id,
      knowledgeObjectId: null,
      label: null,
      privacyClass: "INTERNAL",
      tokens: t,
      rank: null,
      score: null,
      included: fits,
      reason: fits
        ? `prior ${m.role.toLowerCase()} turn`
        : "dropped: history token budget exhausted",
      authorizationDecisionId: null,
    });
    if (fits) {
      chosen.unshift(m);
      historyTokens += t;
    }
  }
  used += historyTokens;
  items.push({
    id: randomUUID(),
    kind: "CONVERSATION_MESSAGE",
    refId: input.userMessage.id,
    knowledgeObjectId: null,
    label: null,
    privacyClass: "INTERNAL",
    tokens: questionTokens,
    rank: null,
    score: null,
    included: true,
    reason: "current question",
    authorizationDecisionId: null,
  });

  const includedClasses = items.filter((i) => i.included).map((i) => i.privacyClass);
  const manifestRow = await q.query(
    `INSERT INTO context_manifests
       (workspace_id, conversation_id, message_id, acting_identity_id, strategy, information_privacy_class, token_budget, tokens_used, items, retrieval)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, created_at`,
    [
      input.workspaceId,
      input.conversationId,
      input.userMessage.id,
      input.actingIdentityId,
      input.strategy,
      highestPrivacyClass(includedClasses),
      input.tokenBudget,
      used,
      JSON.stringify(items),
      retrieval ? JSON.stringify(retrieval) : null,
    ],
  );

  const manifest: ContextManifest = {
    id: manifestRow.rows[0].id,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    messageId: input.userMessage.id,
    actingIdentityId: input.actingIdentityId,
    strategy: input.strategy,
    informationPrivacyClass: highestPrivacyClass(includedClasses),
    tokenBudget: input.tokenBudget,
    tokensUsed: used,
    items,
    retrieval,
    createdAt: isoRequired(manifestRow.rows[0].created_at),
  };

  const messages: ChatMessage[] = [
    ...chosen.map((m) => ({
      role: m.role === "USER" ? ("user" as const) : ("assistant" as const),
      content: m.content,
    })),
    { role: "user", content: input.userMessage.content },
  ];
  return { manifest, system, messages, sources, filteredByPrivacy };
}
