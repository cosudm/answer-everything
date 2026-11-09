import type { Database } from "@ae/database";
import { withTenant } from "@ae/database";
import type {
  AnswerDisposition,
  AnswerLimitation,
  AnswerPathStep,
  AnswerStrategy,
  AskInput,
  AskStreamEvent,
  Attachment,
  Conversation,
  Message,
  ModelRun,
  ModelVersion,
  PrivacyClass,
  Principal,
  Provider,
  ProviderCitation,
  ProviderError,
  ProviderRefusal,
  TokenUsage,
  Workspace,
} from "@ae/domain";
import { DISPOSITION_STATEMENT, highestPrivacyClass } from "@ae/domain";
import { AuthorizationDeniedError, type AuthorizationService } from "@ae/authorization";
import type { EventBus } from "@ae/events";
import { getProject, getWorkspace } from "@ae/identity";
import { getKnowledgeObject } from "@ae/knowledge";
import { GatewayError, estimateCostUsd, hashText, looksLikeTextRefusal, type ModelGateway } from "@ae/model-gateway";
import { classifyQuestion, listModels, routeModels, type RoutingCandidate } from "@ae/model-registry";
import type { Logger } from "@ae/observability";
import { evidenceConfidence, extractClaims, insertAnswerRecord, recordAudit, recordProvenance, referencedLabels, type NewCitation } from "@ae/provenance";
import { appendMessage, finalizeMessage, getConversation, getMessage, listMessages, updateConversation } from "./conversations.js";
import { buildContext, type BuiltContext } from "./context.js";
import { finishModelRun, startModelRun } from "./model-runs.js";

export interface AskDependencies {
  db: Database;
  gateway: ModelGateway;
  authz: AuthorizationService;
  logger: Logger;
  embeddingModelVersionId: string | null;
  events?: EventBus;
  /** Maximum models tried per turn on transient failure. */
  maxAttempts?: number;
}

export interface AskParams {
  principal: Principal;
  workspaceId: string;
  conversationId: string;
  input: AskInput;
  ipAddress?: string | null;
  signal?: AbortSignal;
}

export class AskError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "AUTHORIZATION_DENIED" | "INVALID",
    message: string,
    public readonly reasonCodes: string[] = [],
  ) {
    super(message);
  }
}

interface Turn {
  conversation: Conversation;
  workspace: Workspace;
  projectInstructions: string | null;
  userMessage: Message;
  assistantMessage: Message;
  history: Message[];
  informationPrivacyClass: PrivacyClass;
  attachments: Attachment[];
  path: AnswerPathStep[];
}

interface LaneOutcome {
  text: string;
  usage: TokenUsage | null;
  refusal: ProviderRefusal | null;
  error: ProviderError | null;
  finishReason: string;
  providerRequestId: string | null;
  ttft: number | null;
  latencyMs: number;
  citations: ProviderCitation[];
  run: ModelRun;
  model: ModelVersion;
  provider: Provider;
  attempt: number;
}

const tenant = (p: Principal, workspaceId: string) => ({ userId: p.user.id, workspaceId, identityId: p.actingIdentity.id });
const nowIso = () => new Date().toISOString();

/* ------------------------------------------------------------------------ */
/* Step 1: authorize, persist the question, create the answer placeholder    */
/* ------------------------------------------------------------------------ */

async function prepareTurn(deps: AskDependencies, params: AskParams, lanes: number): Promise<{ turn: Turn; assistants: Message[] }> {
  const { principal, workspaceId, conversationId, input } = params;
  return withTenant(deps.db.app, tenant(principal, workspaceId), async (tx) => {
    const conversation = await getConversation(tx, conversationId);
    if (!conversation) throw new AskError("NOT_FOUND", "Conversation not found.");
    const decision = await deps.authz.authorize(
      tx,
      {
        userId: principal.user.id,
        actingIdentityId: principal.actingIdentity.id,
        workspaceId,
        action: "conversation.append",
        resource: { kind: "CONVERSATION", id: conversation.id, workspaceId: conversation.workspaceId, ownerUserId: conversation.createdByUserId },
        purpose: "ask",
        modelVersionId: null,
        informationPrivacyClass: null,
      },
      { ipAddress: params.ipAddress },
    );
    if (decision.outcome !== "ALLOW") throw new AskError("AUTHORIZATION_DENIED", DISPOSITION_STATEMENT.AUTHORIZATION_DENIED, decision.reasonCodes);

    const workspace = await getWorkspace(tx, workspaceId);
    if (!workspace) throw new AskError("NOT_FOUND", "Workspace not found.");
    const project = conversation.projectId ? await getProject(tx, conversation.projectId) : null;

    // Attachments: must be readable here; their privacy raises the conversation's class.
    const attachments: Attachment[] = [];
    const classes: PrivacyClass[] = [conversation.privacyClass];
    if (project) classes.push(project.privacyClass);
    for (const id of input.attachmentIds ?? []) {
      const obj = await getKnowledgeObject(tx, id);
      if (!obj) throw new AskError("INVALID", `Attachment ${id} is not available in this workspace.`);
      await deps.authz.require(tx, {
        userId: principal.user.id,
        actingIdentityId: principal.actingIdentity.id,
        workspaceId,
        action: "knowledge.read",
        resource: { kind: "KNOWLEDGE_OBJECT", id: obj.id, workspaceId: obj.workspaceId, ownerUserId: obj.ownerUserId, privacyClass: obj.privacyClass },
        purpose: "attach to question",
        modelVersionId: null,
        informationPrivacyClass: null,
      });
      attachments.push({ knowledgeObjectId: obj.id, title: obj.title, mimeType: obj.mimeType ?? "text/plain", byteSize: obj.byteSize ?? 0 });
      classes.push(obj.privacyClass);
    }
    const informationPrivacyClass = highestPrivacyClass(classes);
    if (informationPrivacyClass !== conversation.privacyClass || (input.modelMode && input.modelMode !== conversation.modelMode)) {
      await updateConversation(tx, conversation.id, { privacyClass: informationPrivacyClass, modelMode: input.modelMode });
    }

    let userMessage: Message;
    if (input.regenerateOfMessageId) {
      const existing = await getMessage(tx, input.regenerateOfMessageId);
      if (!existing || existing.conversationId !== conversation.id || existing.role !== "USER") throw new AskError("INVALID", "Message to regenerate was not found.");
      userMessage = existing;
    } else {
      userMessage = await appendMessage(tx, {
        conversationId: conversation.id,
        workspaceId,
        role: "USER",
        content: input.content,
        actingIdentityId: principal.actingIdentity.id,
        parentMessageId: null,
        status: "COMPLETE",
        attachments,
      });
      await recordAudit(tx, {
        workspaceId,
        actorIdentityId: principal.actingIdentity.id,
        actorUserId: principal.user.id,
        eventType: "message.created",
        resourceKind: "MESSAGE",
        resourceId: userMessage.id,
        outcome: "SUCCESS",
        ipAddress: params.ipAddress,
        details: { role: "USER", attachments: attachments.length },
      });
    }
    const assistants: Message[] = [];
    for (let lane = 0; lane < lanes; lane++) {
      assistants.push(
        await appendMessage(tx, {
          conversationId: conversation.id,
          workspaceId,
          role: "ASSISTANT",
          content: "",
          actingIdentityId: principal.actingIdentity.id,
          parentMessageId: userMessage.id,
          status: "STREAMING",
          metadata: lanes > 1 ? { lane } : {},
        }),
      );
    }
    const history = await listMessages(tx, conversation.id, { limit: 60 });
    return {
      turn: {
        conversation: { ...conversation, privacyClass: informationPrivacyClass, modelMode: input.modelMode ?? conversation.modelMode },
        workspace,
        projectInstructions: project?.instructions ?? null,
        userMessage,
        assistantMessage: assistants[0]!,
        history,
        informationPrivacyClass,
        attachments,
        path: [{ step: "Question received", detail: null, at: nowIso(), durationMs: null }],
      },
      assistants,
    };
  });
}

/* ------------------------------------------------------------------------ */
/* Step 2: routing                                                           */
/* ------------------------------------------------------------------------ */

async function route(deps: AskDependencies, params: AskParams, turn: Turn, pinnedModelId: string | null) {
  const candidates = await withTenant(deps.db.app, tenant(params.principal, params.workspaceId), (tx) => listModels(tx));
  const q = classifyQuestion(turn.userMessage.content);
  const scoped: RoutingCandidate[] = pinnedModelId ? candidates.filter((c) => c.model.id === pinnedModelId) : candidates;
  // Providers without a credential or endpoint are excluded before routing so
  // they never consume a fallback attempt; the exclusion is recorded.
  const unconfigured: Array<{ modelId: string; displayName: string; reason: string }> = [];
  const pool: RoutingCandidate[] = [];
  for (const c of scoped) {
    if (!c.model.capabilities.includes("chat")) continue;
    const cfg = await deps.gateway.isConfigured(c.model.id);
    if (cfg.configured) pool.push(c);
    else unconfigured.push({ modelId: c.model.id, displayName: c.model.displayName, reason: cfg.reason ?? "not configured" });
  }
  const result = routeModels(pool, {
    mode: pinnedModelId ? "AUTO" : turn.conversation.modelMode,
    informationPrivacyClass: turn.informationPrivacyClass,
    workspaceSettings: turn.workspace.settings,
    preferEconomy: q.preferEconomy,
    estimatedInputTokens: q.estimatedTokens + 2000,
  });
  result.excluded.push(...unconfigured);
  if (pinnedModelId && pool.length === 0) {
    result.reason = unconfigured[0] ? `${unconfigured[0].displayName}: ${unconfigured[0].reason}` : "The requested model is not registered or not enabled.";
  } else if (result.ranked.length === 0 && unconfigured.length) {
    result.reason = `No configured model is eligible. Not configured: ${unconfigured.map((u) => u.displayName).join(", ")}.`;
  }
  const strategy: AnswerStrategy = turn.attachments.length ? "DOCUMENT_ANALYSIS" : params.input.useKnowledge ? "RETRIEVAL_AUGMENTED" : "DIRECT";
  return { result, strategy, configuredChatModels: pool.length };
}

/* ------------------------------------------------------------------------ */
/* Step 4: one model attempt                                                 */
/* ------------------------------------------------------------------------ */

async function* executeCandidate(
  deps: AskDependencies,
  params: AskParams,
  turn: Turn,
  assistant: Message,
  built: BuiltContext,
  cand: RoutingCandidate,
  attempt: number,
  lane: number | undefined,
): AsyncGenerator<AskStreamEvent, LaneOutcome | { skipped: string }> {
  const { principal, workspaceId } = params;
  const ctx = tenant(principal, workspaceId);

  // Authorization for this exact model and information class, recorded for the Answer Path.
  const decision = await withTenant(deps.db.app, ctx, (tx) =>
    deps.authz.authorize(
      tx,
      {
        userId: principal.user.id,
        actingIdentityId: principal.actingIdentity.id,
        workspaceId,
        action: "model.use",
        resource: { kind: "MODEL_VERSION", id: cand.model.id, workspaceId: null },
        purpose: "answer",
        modelVersionId: cand.model.id,
        informationPrivacyClass: built.manifest.informationPrivacyClass,
      },
      { record: true, ipAddress: params.ipAddress },
    ),
  );
  if (decision.outcome !== "ALLOW") return { skipped: `${cand.model.displayName}: ${decision.reasonCodes.join(", ")}` };

  const run = await withTenant(deps.db.app, ctx, (tx) =>
    startModelRun(tx, {
      workspaceId,
      conversationId: turn.conversation.id,
      messageId: assistant.id,
      modelVersionId: cand.model.id,
      providerId: cand.provider.id,
      actingIdentityId: principal.actingIdentity.id,
      purpose: lane === undefined ? "ANSWER" : "COMPARE",
      snapshot: {
        messageCount: built.messages.length,
        systemPromptHash: hashText(built.system),
        temperature: 0.3,
        maxOutputTokens: Math.min(cand.model.maxOutputTokens ?? 4096, 4096),
        informationPrivacyClass: built.manifest.informationPrivacyClass,
        contextManifestId: built.manifest.id,
      },
    }),
  );
  yield {
    type: "model_selected",
    modelVersionId: cand.model.id,
    displayName: cand.model.displayName,
    providerSlug: cand.provider.slug,
    deploymentType: cand.model.deploymentType,
    reason: attempt > 1 ? `Fallback after a transient provider failure. ${cand.model.displayName}` : cand.model.displayName,
    ...(lane !== undefined ? { lane } : {}),
  };

  const started = Date.now();
  let text = "";
  let usage: TokenUsage | null = null;
  let refusal: ProviderRefusal | null = null;
  let error: ProviderError | null = null;
  let finishReason = "stop";
  let providerRequestId: string | null = null;
  let ttft: number | null = null;
  const citations: ProviderCitation[] = [];

  try {
    for await (const ev of deps.gateway.stream(
      {
        modelVersionId: cand.model.id,
        messages: built.messages,
        system: built.system,
        temperature: 0.3,
        maxOutputTokens: Math.min(cand.model.maxOutputTokens ?? 4096, 4096),
        informationPrivacyClass: built.manifest.informationPrivacyClass,
        modelRunId: run.id,
        workspaceId,
        actingIdentityId: principal.actingIdentity.id,
      },
      params.signal,
    )) {
      switch (ev.type) {
        case "start":
          providerRequestId = ev.providerRequestId;
          break;
        case "delta":
          if (ttft === null) ttft = Date.now() - started;
          text += ev.text;
          yield { type: "delta", text: ev.text, ...(lane !== undefined ? { lane } : {}) };
          break;
        case "citation":
          citations.push(ev.citation);
          break;
        case "usage":
          usage = ev.usage;
          break;
        case "refusal":
          refusal = ev.refusal;
          break;
        case "error":
          error = ev.error;
          break;
        case "end":
          finishReason = ev.finishReason;
          break;
        default:
          break;
      }
    }
  } catch (err) {
    if (err instanceof GatewayError) {
      error = {
        kind: err.code === "BUDGET_EXCEEDED" ? "QUOTA_EXCEEDED" : err.code === "PROVIDER_UNCONFIGURED" ? "PROVIDER_UNAVAILABLE" : "INVALID_REQUEST",
        message: err.message,
        httpStatus: null,
        retryable: err.code === "PROVIDER_UNCONFIGURED",
        providerRequestId: null,
      };
      finishReason = "error";
    } else {
      throw err;
    }
  }
  if (!refusal && finishReason === "stop" && looksLikeTextRefusal(text)) {
    refusal = { code: null, message: text.slice(0, 400), source: "response_text", rawCategory: null };
    finishReason = "refusal";
  }
  const latencyMs = Date.now() - started;
  const estimatedCost = usage ? estimateCostUsd(cand.model, usage) : null;
  const status: ModelRun["status"] = error ? "FAILED" : refusal ? "REFUSED" : finishReason === "cancelled" ? "CANCELLED" : "SUCCEEDED";
  const finished = await withTenant(deps.db.app, ctx, async (tx) => {
    const r = await finishModelRun(tx, run.id, {
      status,
      usage,
      estimatedCostUsd: estimatedCost,
      latencyMs,
      timeToFirstTokenMs: ttft,
      providerRequestId,
      refusal,
      error,
      finishReason,
    });
    await recordAudit(tx, {
      workspaceId,
      actorIdentityId: principal.actingIdentity.id,
      actorUserId: principal.user.id,
      eventType: status === "FAILED" ? "model_run.failed" : status === "REFUSED" ? "model_run.refused" : "model_run.finished",
      resourceKind: "MODEL_RUN",
      resourceId: run.id,
      outcome: status === "FAILED" ? "FAILURE" : "SUCCESS",
      details: { model: cand.model.providerModelName, provider: cand.provider.slug, latencyMs, costUsd: estimatedCost, errorKind: error?.kind ?? null },
    });
    return r;
  });
  return { text, usage, refusal, error, finishReason, providerRequestId, ttft, latencyMs, citations, run: finished, model: cand.model, provider: cand.provider, attempt };
}

/* ------------------------------------------------------------------------ */
/* Step 5: the answer record                                                 */
/* ------------------------------------------------------------------------ */

async function finalizeTurn(
  deps: AskDependencies,
  params: AskParams,
  turn: Turn,
  assistant: Message,
  built: BuiltContext | null,
  outcome: LaneOutcome | null,
  allRuns: ModelRun[],
  failure: { disposition: AnswerDisposition; message: string; details?: Record<string, unknown> } | null,
  extraLimitations: AnswerLimitation[],
  path: AnswerPathStep[],
): Promise<Extract<AskStreamEvent, { type: "complete" }>> {
  const { principal, workspaceId } = params;
  return withTenant(deps.db.app, tenant(principal, workspaceId), async (tx) => {
    const limitations: AnswerLimitation[] = [...extraLimitations];
    let disposition: AnswerDisposition;
    let content = "";
    let confidence: number | null = null;
    let confidenceBasis: string | null = null;
    const citations: NewCitation[] = [];
    let claims: ReturnType<typeof extractClaims> = [];

    if (failure) {
      disposition = failure.disposition;
      limitations.push({ kind: "OTHER", message: failure.message, details: failure.details ?? null });
    } else if (outcome?.refusal) {
      disposition = "PROVIDER_RESTRICTED";
      limitations.push({
        kind: "PROVIDER_REFUSED",
        message: `${outcome.provider.displayName} declined this request (${outcome.refusal.source}${outcome.refusal.code ? `: ${outcome.refusal.code}` : ""}).`,
        details: { providerMessage: outcome.refusal.message },
      });
    } else if (outcome?.error) {
      disposition = "FAILED";
      limitations.push({ kind: "OTHER", message: `${outcome.provider.displayName}: ${outcome.error.message}`, details: { kind: outcome.error.kind, httpStatus: outcome.error.httpStatus } });
    } else if (outcome) {
      content = outcome.text;
      disposition = outcome.finishReason === "length" ? "PARTIALLY_ANSWERED" : content.trim() ? "ANSWERED" : "FAILED";
      if (outcome.finishReason === "length") limitations.push({ kind: "OUTPUT_TRUNCATED", message: "The model reached its output limit before finishing.", details: null });
      const sources = built?.sources ?? [];
      const referenced = new Set(referencedLabels(content));
      for (const s of sources) {
        citations.push({
          label: s.label,
          sourceKind: built?.manifest.items.find((i) => i.refId === s.hit.chunkId)?.kind === "ATTACHMENT" ? "KNOWLEDGE_CHUNK" : "KNOWLEDGE_CHUNK",
          sourceId: s.hit.chunkId,
          knowledgeObjectId: s.hit.knowledgeObjectId,
          title: s.hit.title,
          excerpt: s.hit.content.slice(0, 600),
          locator: s.hit.locator,
          relevanceScore: s.hit.score,
          referenced: referenced.has(s.label),
        });
      }
      let webLabel = sources.length + 1;
      for (const c of outcome.citations) {
        citations.push({ label: `S${webLabel++}`, sourceKind: "PROVIDER_NATIVE", uri: c.uri, title: c.title, excerpt: c.excerpt, referenced: true });
      }
      if (sources.length) {
        claims = extractClaims(content, sources.map((s) => s.label));
        const conf = evidenceConfidence(claims, true);
        confidence = conf.confidence;
        confidenceBasis = conf.basis;
        limitations.push({ kind: "CLAIMS_NOT_VERIFIED", message: "Claims are classified by citation coverage; the independent verification pass has not run.", details: null });
        if (!claims.some((c) => c.claimType === "SOURCED_FACT")) {
          limitations.push({ kind: "SOURCES_PARTIALLY_RELEVANT", message: "Sources were retrieved but the answer did not cite any of them.", details: null });
        }
      } else if (params.input.useKnowledge) {
        limitations.push({ kind: "NO_SOURCES_RETRIEVED", message: "No workspace sources matched this question; the answer reflects the model's general knowledge.", details: null });
      }
      if (built && built.filteredByPrivacy > 0) {
        limitations.push({
          kind: "AUTHORIZATION_FILTERED_SOURCES",
          message: `${built.filteredByPrivacy} knowledge item(s) were excluded because their privacy class exceeds what this answer path is cleared for.`,
          details: { excluded: built.filteredByPrivacy, ceiling: turn.informationPrivacyClass },
        });
      }
      if (outcome.attempt > 1) limitations.push({ kind: "FALLBACK_MODEL_USED", message: "A different approved model answered after the first choice failed.", details: null });
    } else {
      disposition = "FAILED";
    }

    const answerRecord = await insertAnswerRecord(tx, {
      workspaceId,
      conversationId: turn.conversation.id,
      messageId: assistant.id,
      actingIdentityId: principal.actingIdentity.id,
      modelRunIds: allRuns.map((r) => r.id),
      contextManifestId: built?.manifest.id ?? null,
      disposition,
      content,
      confidence,
      confidenceBasis,
      limitations,
      answerPath: [...path, { step: "Answer recorded", detail: disposition, at: nowIso(), durationMs: null }],
      citations,
      claims: claims.map((c) => ({ text: c.text, claimType: c.claimType, citationLabels: c.citationLabels, spanStart: c.spanStart, spanEnd: c.spanEnd })),
    });

    const finalMessage = await finalizeMessage(tx, assistant.id, {
      content: content || DISPOSITION_STATEMENT[disposition],
      status: disposition === "FAILED" ? "FAILED" : "COMPLETE",
      answerRecordId: answerRecord.id,
      metadata: { disposition, modelVersionId: outcome?.model.id ?? null, modelDisplayName: outcome?.model.displayName ?? null },
    });

    if (outcome) {
      await recordProvenance(tx, {
        workspaceId,
        subjectKind: "MESSAGE",
        subjectId: assistant.id,
        event: "GENERATED_BY_MODEL",
        actorIdentityId: principal.actingIdentity.id,
        sourceKind: "CONTEXT_MANIFEST",
        sourceId: built?.manifest.id ?? null,
        modelVersionId: outcome.model.id,
        details: { modelRunId: outcome.run.id, disposition },
      });
    }
    for (const c of answerRecord.citations) {
      if (c.sourceKind === "KNOWLEDGE_CHUNK" && c.sourceId && c.referenced) {
        await recordProvenance(tx, {
          workspaceId,
          subjectKind: "KNOWLEDGE_CHUNK",
          subjectId: c.sourceId,
          event: "CITED_BY",
          actorIdentityId: principal.actingIdentity.id,
          sourceKind: "ANSWER_RECORD",
          sourceId: answerRecord.id,
          modelVersionId: outcome?.model.id ?? null,
          details: { label: c.label },
        });
      }
    }
    await recordAudit(tx, {
      workspaceId,
      actorIdentityId: principal.actingIdentity.id,
      actorUserId: principal.user.id,
      eventType: "message.created",
      resourceKind: "MESSAGE",
      resourceId: assistant.id,
      outcome: disposition === "FAILED" ? "FAILURE" : "SUCCESS",
      details: { role: "ASSISTANT", disposition, modelRuns: allRuns.length },
    });
    void deps.events?.emit({ type: "answer.recorded", workspaceId, answerRecordId: answerRecord.id, disposition });
    return { type: "complete", assistantMessage: finalMessage, answerRecord, modelRuns: allRuns };
  });
}

/* ------------------------------------------------------------------------ */
/* Public pipeline                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Ask -> Answer. Yields SSE-ready events. Authorization happens before the
 * question is persisted, before retrieval, and again per model attempt.
 * Transient provider failures fall through to the next approved model;
 * refusals and authorization decisions never do.
 */
export async function* runAsk(deps: AskDependencies, params: AskParams): AsyncGenerator<AskStreamEvent> {
  const maxAttempts = deps.maxAttempts ?? 3;
  const { turn } = await prepareTurn(deps, params, 1);
  const assistant = turn.assistantMessage;
  yield { type: "accepted", userMessage: turn.userMessage, assistantMessageId: assistant.id };
  const path = turn.path;
  const step = (s: string, detail: string | null = null): AskStreamEvent => {
    path.push({ step: s, detail, at: nowIso(), durationMs: null });
    return { type: "path", step: s, detail };
  };

  const pinned = params.input.modelVersionId ?? turn.conversation.pinnedModelVersionId ?? null;
  const { result: routing, strategy, configuredChatModels } = await route(deps, params, turn, pinned);
  yield step(`Classified: ${strategy.replace(/_/g, " ").toLowerCase()}`, `${turn.conversation.modelMode} mode, ${turn.informationPrivacyClass} information`);

  if (routing.ranked.length === 0) {
    yield step("No eligible model", routing.reason);
    // Nothing configured at all is a capability gap (UNSUPPORTED); configured
    // models excluded by workspace policy is an authorization outcome.
    const complete = await finalizeTurn(deps, params, turn, assistant, null, null, [], {
      disposition: configuredChatModels > 0 ? "AUTHORIZATION_DENIED" : "UNSUPPORTED",
      message: routing.reason,
      details: { excluded: routing.excluded },
    }, [], path);
    yield complete;
    return;
  }

  const topWindow = routing.ranked[0]!.model.contextWindow;
  const built = await withTenant(deps.db.app, tenant(params.principal, params.workspaceId), async (tx) => {
    const retrievalDecision = params.input.useKnowledge || (params.input.attachmentIds?.length ?? 0) > 0
      ? await deps.authz.authorize(
          tx,
          {
            userId: params.principal.user.id,
            actingIdentityId: params.principal.actingIdentity.id,
            workspaceId: params.workspaceId,
            action: "knowledge.retrieve_for_model",
            resource: { kind: "KNOWLEDGE_OBJECT", id: null, workspaceId: params.workspaceId, privacyClass: turn.informationPrivacyClass },
            purpose: "retrieval for answer",
            modelVersionId: routing.ranked[0]!.model.id,
            informationPrivacyClass: turn.informationPrivacyClass,
          },
          { record: true, ipAddress: params.ipAddress },
        )
      : null;
    return buildContext(tx, {
      workspaceId: params.workspaceId,
      conversationId: turn.conversation.id,
      userMessage: turn.userMessage,
      history: turn.history,
      projectId: turn.conversation.projectId,
      projectInstructions: turn.projectInstructions,
      actingIdentityId: params.principal.actingIdentity.id,
      strategy,
      maxPrivacyClass: retrievalDecision?.outcome === "ALLOW" ? (retrievalDecision.obligations?.maxPrivacyClass ?? turn.informationPrivacyClass) : "PUBLIC",
      attachmentIds: retrievalDecision?.outcome === "ALLOW" ? (params.input.attachmentIds ?? []) : [],
      useKnowledge: retrievalDecision?.outcome === "ALLOW" && params.input.useKnowledge,
      tokenBudget: Math.min(Math.floor(topWindow * 0.6), 24_000),
      embeddingModelVersionId: deps.embeddingModelVersionId,
      gateway: deps.gateway,
      authorizationDecisionId: retrievalDecision?.id ?? null,
      logger: deps.logger,
    });
  });
  if (built.manifest.retrieval) {
    yield step(`${built.manifest.retrieval.candidates} sources retrieved`, `${built.manifest.retrieval.used} used (${built.manifest.retrieval.method})`);
  }
  yield { type: "context", manifest: built.manifest };

  const runs: ModelRun[] = [];
  let outcome: LaneOutcome | null = null;
  const skipped: string[] = [];
  let attempt = 0;
  for (const cand of routing.ranked) {
    if (attempt >= maxAttempts) break;
    attempt++;
    yield step(attempt === 1 ? "Model selected" : "Fallback model selected", `${cand.model.displayName} (${cand.provider.displayName}). ${attempt === 1 ? routing.reason : ""}`.trim());
    const gen = executeCandidate(deps, params, turn, assistant, built, cand, attempt, undefined);
    let next = await gen.next();
    while (!next.done) {
      yield next.value;
      next = await gen.next();
    }
    const res = next.value;
    if ("skipped" in res) {
      skipped.push(res.skipped);
      yield step("Model not authorized", res.skipped);
      attempt--; // an authorization skip does not count as a provider attempt
      continue;
    }
    runs.push(res.run);
    if (res.error && res.error.retryable && !res.text) {
      yield { type: "notice", level: "warning", message: `${res.provider.displayName} is unavailable (${res.error.kind.toLowerCase().replace(/_/g, " ")}). Trying another approved model.` };
      yield step("Provider failure", `${res.model.displayName}: ${res.error.message}`);
      outcome = res;
      continue;
    }
    outcome = res;
    break;
  }

  if (outcome?.refusal) yield step("Provider declined", `${outcome.provider.displayName} (${outcome.refusal.source})`);
  else if (outcome?.error) yield step("Model run failed", outcome.error.message);
  else if (outcome) yield step("Answer generated", `${outcome.usage?.outputTokens ?? 0} output tokens in ${outcome.latencyMs} ms`);
  if (built.sources.length && outcome && !outcome.refusal && !outcome.error) yield step("Claims classified", `${built.sources.length} sources available`);

  const failure = !outcome && skipped.length ? { disposition: "AUTHORIZATION_DENIED" as const, message: `No model could be authorized: ${skipped.join("; ")}` } : null;
  const complete = await finalizeTurn(deps, params, turn, assistant, built, outcome, runs, failure, [], path);
  yield complete;
}

/**
 * Compare: one question, 2-4 models in parallel lanes, each with its own
 * assistant message and answer record. Events carry a `lane` index.
 */
export async function* runCompare(
  deps: AskDependencies,
  params: AskParams & { modelVersionIds: string[] },
): AsyncGenerator<AskStreamEvent> {
  const lanes = params.modelVersionIds.length;
  const { turn, assistants } = await prepareTurn(deps, params, lanes);
  yield { type: "accepted", userMessage: turn.userMessage, assistantMessageId: assistants[0]!.id };
  const path = turn.path;
  path.push({ step: "Compare requested", detail: `${lanes} models`, at: nowIso(), durationMs: null });
  yield { type: "path", step: "Compare requested", detail: `${lanes} models` };

  const all = await withTenant(deps.db.app, tenant(params.principal, params.workspaceId), (tx) => listModels(tx));
  const window = Math.min(...params.modelVersionIds.map((id) => all.find((c) => c.model.id === id)?.model.contextWindow ?? 32_000));
  const built = await withTenant(deps.db.app, tenant(params.principal, params.workspaceId), (tx) =>
    buildContext(tx, {
      workspaceId: params.workspaceId,
      conversationId: turn.conversation.id,
      userMessage: turn.userMessage,
      history: turn.history,
      projectId: turn.conversation.projectId,
      projectInstructions: turn.projectInstructions,
      actingIdentityId: params.principal.actingIdentity.id,
      strategy: "MULTI_MODEL_COMPARISON",
      maxPrivacyClass: turn.informationPrivacyClass,
      attachmentIds: params.input.attachmentIds ?? [],
      useKnowledge: params.input.useKnowledge,
      tokenBudget: Math.min(Math.floor(window * 0.6), 24_000),
      embeddingModelVersionId: deps.embeddingModelVersionId,
      gateway: deps.gateway,
      authorizationDecisionId: null,
      logger: deps.logger,
    }),
  );
  yield { type: "context", manifest: built.manifest };

  const laneGens = params.modelVersionIds.map((id, lane) => {
    const cand = all.find((c) => c.model.id === id);
    return { lane, cand, assistant: assistants[lane]! };
  });

  // Multiplex lanes: run them concurrently and yield events as they arrive.
  type Item = { lane: number; value: AskStreamEvent } | { lane: number; done: LaneOutcome | { skipped: string } | null };
  const queue: Item[] = [];
  let pending = laneGens.length;
  let wake: (() => void) | null = null;
  const notify = () => {
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  for (const { lane, cand, assistant } of laneGens) {
    (async () => {
      if (!cand) {
        queue.push({ lane, done: { skipped: "model not registered" } });
        pending--;
        notify();
        return;
      }
      const gen = executeCandidate(deps, params, turn, assistant, built, cand, 1, lane);
      let next = await gen.next();
      while (!next.done) {
        queue.push({ lane, value: next.value });
        notify();
        next = await gen.next();
      }
      queue.push({ lane, done: next.value });
      pending--;
      notify();
    })().catch((err) => {
      deps.logger.error({ err, lane }, "compare lane crashed");
      queue.push({ lane, done: null });
      pending--;
      notify();
    });
  }
  while (pending > 0 || queue.length) {
    if (!queue.length) await new Promise<void>((r) => (wake = r));
    while (queue.length) {
      const item = queue.shift()!;
      if ("value" in item) {
        yield item.value;
      } else {
        const { lane, assistant } = laneGens[item.lane]!;
        const res = item.done;
        const failure = !res ? { disposition: "FAILED" as const, message: "Lane failed unexpectedly." } : "skipped" in res ? { disposition: "AUTHORIZATION_DENIED" as const, message: res.skipped } : null;
        const outcome = res && !("skipped" in res) ? res : null;
        const complete = await finalizeTurn(deps, params, turn, assistant, built, outcome, outcome ? [outcome.run] : [], failure, [], [...path]);
        yield { ...complete, lane };
      }
    }
  }
}

export { AuthorizationDeniedError };
