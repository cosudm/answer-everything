import { createHash } from "node:crypto";
import type { ModelVersion, ProviderError, ProviderErrorKind, TokenUsage } from "@ae/domain";
import type { CredentialBroker } from "./types.js";

/** Reads secrets from the process environment by name. */
export class EnvCredentialBroker implements CredentialBroker {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async resolve(credentialRef: string | null): Promise<string | null> {
    if (!credentialRef) return null;
    const v = this.env[credentialRef];
    return v && v.trim() !== "" ? v : null;
  }
}

/** In-memory broker for tests. */
export class StaticCredentialBroker implements CredentialBroker {
  constructor(private readonly secrets: Record<string, string>) {}
  async resolve(credentialRef: string | null): Promise<string | null> {
    return credentialRef ? (this.secrets[credentialRef] ?? null) : null;
  }
}

/**
 * Rough token estimate when the provider reports none: ~4 characters per
 * token for English text. Always flagged `reported: false`.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateCostUsd(model: ModelVersion, usage: TokenUsage): number | null {
  if (model.inputCostPerMillion == null || model.outputCostPerMillion == null) return null;
  const cost =
    (usage.inputTokens / 1_000_000) * model.inputCostPerMillion +
    (usage.outputTokens / 1_000_000) * model.outputCostPerMillion;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function classifyHttpError(status: number, body: string, requestId: string | null): ProviderError {
  let kind: ProviderErrorKind = "UNKNOWN";
  let retryable = false;
  if (status === 401 || status === 403) kind = "AUTHENTICATION";
  else if (status === 429) {
    kind = /quota|billing|insufficient/i.test(body) ? "QUOTA_EXCEEDED" : "RATE_LIMITED";
    retryable = kind === "RATE_LIMITED";
  } else if (status === 400 || status === 404 || status === 422) {
    kind = /context|too long|maximum.*tokens|token limit/i.test(body) ? "CONTEXT_TOO_LONG" : "INVALID_REQUEST";
  } else if (status === 408 || status === 504) {
    kind = "TIMEOUT";
    retryable = true;
  } else if (status >= 500) {
    kind = "PROVIDER_UNAVAILABLE";
    retryable = true;
  }
  return {
    kind,
    message: summarizeBody(body) || `HTTP ${status}`,
    httpStatus: status,
    retryable,
    providerRequestId: requestId,
  };
}

export function networkError(err: unknown): ProviderError {
  const e = err as Error & { name?: string; code?: string };
  const timeout = e?.name === "AbortError" || e?.name === "TimeoutError" || /timeout/i.test(e?.message ?? "");
  return {
    kind: timeout ? "TIMEOUT" : "NETWORK",
    message: e?.message ?? "network error",
    httpStatus: null,
    retryable: true,
    providerRequestId: null,
  };
}

function summarizeBody(body: string): string {
  try {
    const j = JSON.parse(body);
    const msg = j?.error?.message ?? j?.message ?? j?.error;
    if (typeof msg === "string") return msg.slice(0, 500);
  } catch {
    /* not json */
  }
  return body.slice(0, 500);
}

/**
 * Looks for refusal-shaped replies in plain text when the provider gives no
 * structured signal. Deliberately conservative: it only fires on short
 * replies that are almost entirely a refusal template, so a long answer that
 * mentions "I can't" in passing is never misclassified.
 */
export function looksLikeTextRefusal(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 400) return false;
  return /^(i('m| am) (sorry|unable)|i can(no|')t (help|assist|provide|comply)|i won'?t be able to|as an ai[, ]|i must decline|i'm not able to (help|assist|provide))/i.test(t);
}
