import { describe, expect, it } from "vitest";
import type { ModelVersion, Provider } from "@ae/domain";
import { WorkspaceSettings } from "@ae/domain";
import { classifyQuestion, routeModels, type RoutingCandidate } from "./routing.js";

const now = new Date().toISOString();
const provider = (slug: string, enabled = true): Provider => ({
  id: `p-${slug}`,
  slug,
  kind: "OPENAI_COMPATIBLE",
  adapter: "openai-compatible",
  displayName: slug,
  baseUrl: "http://x",
  credentialRef: null,
  dataHandling: { trainsOnData: false, retentionDays: 0, region: null },
  enabled,
  metadata: {},
  createdAt: now,
  updatedAt: now,
});
const model = (id: string, overrides: Partial<ModelVersion> = {}): ModelVersion => ({
  id,
  providerId: "p-a",
  providerModelName: id,
  displayName: id,
  baseModel: null,
  version: null,
  deploymentType: "COMMERCIAL_API",
  behavioralProfile: "STANDARD",
  capabilities: ["chat", "streaming"],
  privacyClassesAllowed: ["PUBLIC", "INTERNAL"],
  evaluationStatus: "APPROVED",
  weightsHash: null,
  adapterIds: [],
  contextWindow: 128000,
  maxOutputTokens: 4096,
  inputCostPerMillion: 1,
  outputCostPerMillion: 5,
  quantization: null,
  license: null,
  intendedUses: [],
  prohibitedUses: [],
  modificationHistory: [],
  embeddingDimensions: null,
  enabled: true,
  metadata: {},
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

const settings = WorkspaceSettings.parse({});
const base = {
  mode: "AUTO" as const,
  informationPrivacyClass: "INTERNAL" as const,
  workspaceSettings: settings,
};

describe("routeModels", () => {
  const frontier = {
    model: model("frontier", {
      capabilities: ["chat", "streaming", "reasoning"],
      inputCostPerMillion: 10,
      outputCostPerMillion: 50,
    }),
    provider: provider("a"),
  };
  const cheap = {
    model: model("cheap", { inputCostPerMillion: 0.1, outputCostPerMillion: 0.4 }),
    provider: provider("a"),
  };
  const privateModel = {
    model: model("private", {
      deploymentType: "DEDICATED_ENDPOINT",
      privacyClassesAllowed: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
    }),
    provider: provider("b"),
  };
  const experimental = {
    model: model("abliterated-x", {
      behavioralProfile: "EXPERIMENTAL",
      evaluationStatus: "TESTING",
      deploymentType: "DEDICATED_ENDPOINT",
      privacyClassesAllowed: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
    }),
    provider: provider("b"),
  };
  const all: RoutingCandidate[] = [frontier, cheap, privateModel, experimental];

  it("prefers reasoning models in AUTO for substantive questions", () => {
    const r = routeModels(all, base);
    expect(r.ranked[0]!.model.id).toBe("frontier");
    expect(r.reason).toContain("frontier");
  });
  it("prefers economy for trivial questions", () => {
    const r = routeModels(all, { ...base, preferEconomy: true });
    expect(r.ranked[0]!.model.id).toBe("cheap");
  });
  it("excludes models not cleared for the information class", () => {
    const r = routeModels(all, { ...base, informationPrivacyClass: "CONFIDENTIAL" });
    expect(r.ranked.map((c) => c.model.id)).toEqual(["private"]);
    expect(r.excluded.find((e) => e.modelId === "frontier")?.reason).toContain("not cleared");
  });
  it("hides experimental models unless the workspace opted in", () => {
    expect(routeModels(all, { ...base, mode: "EXPERIMENTAL" }).ranked).toHaveLength(0);
    const opted = WorkspaceSettings.parse({ allowExperimentalModels: true });
    const r = routeModels(all, { ...base, mode: "EXPERIMENTAL", workspaceSettings: opted });
    expect(r.ranked.map((c) => c.model.id)).toEqual(["abliterated-x"]);
    expect(r.reason).toContain("testing");
  });
  it("PRIVATE mode never routes to commercial APIs", () => {
    const r = routeModels(all, { ...base, mode: "PRIVATE" });
    expect(r.ranked.every((c) => c.model.deploymentType !== "COMMERCIAL_API")).toBe(true);
  });
  it("skips disabled providers and exhausted budgets", () => {
    const disabled = { model: model("d"), provider: provider("dead", false) };
    expect(routeModels([disabled], base).ranked).toHaveLength(0);
    const r = routeModels(
      [
        frontier,
        {
          model: model("free", { inputCostPerMillion: 0, outputCostPerMillion: 0 }),
          provider: provider("a"),
        },
      ],
      { ...base, remainingBudgetUsd: 0 },
    );
    expect(r.ranked.map((c) => c.model.id)).toEqual(["free"]);
  });
  it("excludes models already attempted this turn", () => {
    const r = routeModels(all, { ...base, excludeModelIds: ["frontier"] });
    expect(r.ranked[0]!.model.id).not.toBe("frontier");
  });
  it("explains when nothing is eligible", () => {
    const r = routeModels([frontier], { ...base, informationPrivacyClass: "RESTRICTED" });
    expect(r.ranked).toHaveLength(0);
    expect(r.reason).toContain("No eligible model");
  });
});

describe("classifyQuestion", () => {
  it("flags short factual questions as economy", () => {
    expect(classifyQuestion("What is the capital of France?").preferEconomy).toBe(true);
  });
  it("keeps analytical or research questions on stronger models", () => {
    expect(classifyQuestion("Explain why the policy changed").preferEconomy).toBe(false);
    expect(classifyQuestion("Compare the evidence on X").wantsResearch).toBe(true);
  });
});
