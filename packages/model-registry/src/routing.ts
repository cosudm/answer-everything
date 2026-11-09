import type { ModelCapability, ModelMode, ModelVersion, PrivacyClass, Provider, WorkspaceSettings } from "@ae/domain";

export interface RoutingCandidate {
  model: ModelVersion;
  provider: Provider;
}

export interface RoutingConstraints {
  mode: ModelMode;
  informationPrivacyClass: PrivacyClass;
  workspaceSettings: WorkspaceSettings;
  requiredCapabilities?: ModelCapability[];
  /** Approximate prompt tokens; models with smaller windows are excluded. */
  estimatedInputTokens?: number;
  /** Prefer cheaper models when true (trivial questions). */
  preferEconomy?: boolean;
  /** Exclude models that already failed this turn. */
  excludeModelIds?: string[];
  /** Remaining monthly budget in USD; null when unlimited/unknown. */
  remainingBudgetUsd?: number | null;
}

export interface RoutingResult {
  /** Ordered best-first. The orchestrator tries them in order on transient failure. */
  ranked: RoutingCandidate[];
  /** Why the top candidate was chosen (shown in the Answer Path). */
  reason: string;
  /** Candidates excluded and why; useful when nothing is selectable. */
  excluded: Array<{ modelId: string; displayName: string; reason: string }>;
}

const MODE_PROFILES: Record<ModelMode, string[]> = {
  AUTO: ["STANDARD", "PROFESSIONAL", "RESEARCH"],
  FRONTIER: ["STANDARD", "PROFESSIONAL"],
  RESEARCH: ["RESEARCH"],
  PRIVATE: ["STANDARD", "PROFESSIONAL", "RESEARCH", "HIGH_LATITUDE"],
  HIGH_LATITUDE: ["HIGH_LATITUDE"],
  EXPERIMENTAL: ["EXPERIMENTAL", "HIGH_LATITUDE"],
};

/**
 * Deterministic routing. Eligibility first (hard constraints: enabled,
 * approved, privacy clearance, capability, context, budget), then a stable
 * ranking per mode. This is policy-shaped data, not a model call, so it is
 * cheap, explainable and testable. Centralized authorization re-checks the
 * final choice; routing never widens authority.
 */
export function routeModels(candidates: RoutingCandidate[], c: RoutingConstraints): RoutingResult {
  const excluded: RoutingResult["excluded"] = [];
  const eligible: RoutingCandidate[] = [];
  const exclude = new Set(c.excludeModelIds ?? []);
  const allowExperimental = c.workspaceSettings.allowExperimentalModels;

  for (const cand of candidates) {
    const { model, provider } = cand;
    const out = (reason: string) => excluded.push({ modelId: model.id, displayName: model.displayName, reason });
    if (exclude.has(model.id)) { out("already attempted this turn"); continue; }
    if (!model.enabled || !provider.enabled) { out("disabled"); continue; }
    if (!model.capabilities.includes("chat")) { out("not a chat model"); continue; }
    if (model.evaluationStatus === "REJECTED") { out("rejected by evaluation"); continue; }
    const needsOptIn = model.evaluationStatus !== "APPROVED" || model.behavioralProfile === "EXPERIMENTAL";
    if (needsOptIn && !allowExperimental) { out("not approved; workspace has not enabled experimental models"); continue; }
    if (model.deploymentType === "COMMERCIAL_API" && !c.workspaceSettings.allowCommercialProviders) { out("commercial providers disabled in workspace"); continue; }
    if (!model.privacyClassesAllowed.includes(c.informationPrivacyClass)) { out(`not cleared for ${c.informationPrivacyClass} information`); continue; }
    if (c.mode === "PRIVATE" && model.deploymentType === "COMMERCIAL_API") { out("Private mode excludes commercial APIs"); continue; }
    if (!MODE_PROFILES[c.mode].includes(model.behavioralProfile)) { out(`profile ${model.behavioralProfile} not in ${c.mode} mode`); continue; }
    for (const cap of c.requiredCapabilities ?? []) {
      if (!model.capabilities.includes(cap)) { out(`missing capability ${cap}`); break; }
    }
    if (excluded.at(-1)?.modelId === model.id) continue;
    if (c.estimatedInputTokens && model.contextWindow < c.estimatedInputTokens * 1.2) { out("context window too small"); continue; }
    if (c.remainingBudgetUsd != null && c.remainingBudgetUsd <= 0 && (model.inputCostPerMillion ?? 0) > 0) { out("workspace budget exhausted"); continue; }
    eligible.push(cand);
  }

  const score = (cand: RoutingCandidate): number => {
    const m = cand.model;
    let s = 0;
    // Approved models first.
    if (m.evaluationStatus === "APPROVED") s += 1000;
    // Mode affinity.
    if (c.mode === "RESEARCH") {
      if (m.capabilities.includes("citations")) s += 300;
      if (m.capabilities.includes("web_search")) s += 200;
      if (m.capabilities.includes("long_context")) s += 100;
    }
    if (c.mode === "FRONTIER" || c.mode === "AUTO") {
      if (m.capabilities.includes("reasoning")) s += 150;
      if (m.deploymentType === "COMMERCIAL_API") s += 50; // frontier capability lives there today
    }
    if (c.mode === "PRIVATE") {
      if (m.deploymentType === "DEDICATED_ENDPOINT") s += 200;
      if (m.deploymentType === "OPEN_WEIGHT") s += 150;
      if (m.deploymentType === "LOCAL") s += 50;
    }
    // Cost: economy preference inverts the weight of price.
    const price = (m.inputCostPerMillion ?? 0) + 3 * (m.outputCostPerMillion ?? 0);
    s += c.preferEconomy ? -price * 4 : -price * 0.5;
    // Explicit priority hint from the seed/registry.
    const priority = Number((m.metadata as { routingPriority?: number }).routingPriority ?? 0);
    s += priority;
    return s;
  };

  const ranked = [...eligible].sort((a, b) => score(b) - score(a) || a.model.displayName.localeCompare(b.model.displayName));
  const top = ranked[0];
  const reason = top
    ? describeChoice(top, c)
    : excluded.length
      ? `No eligible model: ${excluded.map((e) => `${e.displayName} (${e.reason})`).join("; ")}`
      : "No models are registered.";
  return { ranked, reason, excluded };
}

function describeChoice(cand: RoutingCandidate, c: RoutingConstraints): string {
  const m = cand.model;
  const bits = [`${c.mode} mode`, `cleared for ${c.informationPrivacyClass}`];
  if (m.evaluationStatus !== "APPROVED") bits.push(`${m.evaluationStatus.toLowerCase()} (workspace allows experimental)`);
  if (c.preferEconomy) bits.push("economy preferred for a short question");
  if (m.capabilities.includes("reasoning") && (c.mode === "AUTO" || c.mode === "FRONTIER")) bits.push("reasoning capability");
  return `${m.displayName}: ${bits.join(", ")}.`;
}

/**
 * Cheap heuristics for Auto mode: is this a trivial question where an
 * economy model is appropriate, or does it warrant retrieval / a stronger
 * model? Deliberately simple; the classifier model run is a roadmap item.
 */
export function classifyQuestion(text: string): { preferEconomy: boolean; wantsResearch: boolean; estimatedTokens: number } {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).length;
  const wantsResearch = /\b(research|compare|evidence|sources?|cite|latest|study|studies|according to|verify)\b/i.test(trimmed);
  const preferEconomy = words < 12 && !wantsResearch && !/\b(why|explain|analy[sz]e|design|plan|write)\b/i.test(trimmed);
  return { preferEconomy, wantsResearch, estimatedTokens: Math.ceil(trimmed.length / 4) };
}
