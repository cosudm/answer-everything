import { readFile } from "node:fs/promises";
import type { Queryable } from "@ae/database";
import type { ModelVersion, Provider, RegisterModelInput } from "@ae/domain";
import { z } from "zod";
import { registerModel, upsertProvider } from "./repository.js";

const SeedModel = z.object({
  providerModelName: z.string(),
  displayName: z.string(),
  baseModel: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  deploymentType: z.enum(["COMMERCIAL_API", "DEDICATED_ENDPOINT", "OPEN_WEIGHT", "LOCAL"]),
  behavioralProfile: z.enum(["STANDARD", "PROFESSIONAL", "RESEARCH", "HIGH_LATITUDE", "EXPERIMENTAL"]),
  capabilities: z.array(z.string()),
  privacyClassesAllowed: z.array(z.enum(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"])),
  evaluationStatus: z.enum(["UNTESTED", "TESTING", "APPROVED", "REJECTED"]),
  contextWindow: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive().nullable().optional(),
  inputCostPerMillion: z.number().nullable().optional(),
  outputCostPerMillion: z.number().nullable().optional(),
  embeddingDimensions: z.number().int().positive().nullable().optional(),
  weightsHash: z.string().nullable().optional(),
  quantization: z.string().nullable().optional(),
  license: z.string().nullable().optional(),
  intendedUses: z.array(z.string()).optional(),
  prohibitedUses: z.array(z.string()).optional(),
  modificationHistory: z.array(z.any()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const SeedProvider = z.object({
  slug: z.string(),
  kind: z.string(),
  adapter: z.enum(["anthropic", "openai-compatible"]),
  displayName: z.string(),
  baseUrl: z.string().nullable(),
  credentialRef: z.string().nullable(),
  dataHandling: z.object({
    trainsOnData: z.boolean(),
    retentionDays: z.number().nullable(),
    region: z.string().nullable(),
  }),
  enabled: z.boolean().default(true),
  devOnly: z.boolean().default(false),
  models: z.array(SeedModel),
});

const SeedFile = z.object({ providers: z.array(SeedProvider) });

export interface SeedOptions {
  env: NodeJS.ProcessEnv;
  /** "dev" | "uat" | "prod": devOnly providers are skipped outside dev. */
  aeEnv: string;
}

export interface SeedResult {
  providers: Provider[];
  models: ModelVersion[];
  skipped: string[];
}

/** Expands ${VAR} placeholders from the environment; unresolved -> null. */
function expand(value: string | null, env: NodeJS.ProcessEnv): string | null {
  if (value == null) return null;
  const out = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => env[name] ?? "");
  return out.trim() === "" ? null : out;
}

export async function seedRegistryFromFile(q: Queryable, path: string, opts: SeedOptions): Promise<SeedResult> {
  const raw = JSON.parse(await readFile(path, "utf8"));
  return seedRegistry(q, raw, opts);
}

export async function seedRegistry(q: Queryable, raw: unknown, opts: SeedOptions): Promise<SeedResult> {
  const seed = SeedFile.parse(raw);
  const result: SeedResult = { providers: [], models: [], skipped: [] };
  for (const p of seed.providers) {
    if (p.devOnly && opts.aeEnv === "prod") {
      result.skipped.push(`${p.slug} (devOnly)`);
      continue;
    }
    const baseUrl = expand(p.baseUrl, opts.env);
    if (p.baseUrl?.includes("${") && !baseUrl) {
      // Provider needs an endpoint that is not configured; register disabled.
      const provider = await upsertProvider(q, {
        slug: p.slug,
        kind: p.kind as Provider["kind"],
        adapter: p.adapter,
        displayName: p.displayName,
        baseUrl: null,
        credentialRef: p.credentialRef,
        dataHandling: p.dataHandling,
        enabled: false,
        metadata: { seeded: true, disabledReason: "endpoint not configured" },
      });
      result.providers.push(provider);
      result.skipped.push(`${p.slug} models (endpoint not configured)`);
      continue;
    }
    const provider = await upsertProvider(q, {
      slug: p.slug,
      kind: p.kind as Provider["kind"],
      adapter: p.adapter,
      displayName: p.displayName,
      baseUrl,
      credentialRef: p.credentialRef,
      dataHandling: p.dataHandling,
      enabled: p.enabled,
      metadata: { seeded: true, devOnly: p.devOnly },
    });
    result.providers.push(provider);
    for (const m of p.models) {
      const input: RegisterModelInput = {
        providerId: provider.id,
        providerModelName: m.providerModelName,
        displayName: m.displayName,
        baseModel: m.baseModel ?? null,
        version: m.version ?? null,
        deploymentType: m.deploymentType,
        behavioralProfile: m.behavioralProfile,
        capabilities: m.capabilities as ModelVersion["capabilities"],
        privacyClassesAllowed: m.privacyClassesAllowed,
        evaluationStatus: m.evaluationStatus,
        weightsHash: m.weightsHash ?? null,
        adapterIds: [],
        contextWindow: m.contextWindow,
        maxOutputTokens: m.maxOutputTokens ?? null,
        inputCostPerMillion: m.inputCostPerMillion ?? null,
        outputCostPerMillion: m.outputCostPerMillion ?? null,
        quantization: m.quantization ?? null,
        license: m.license ?? null,
        intendedUses: m.intendedUses ?? [],
        prohibitedUses: m.prohibitedUses ?? [],
        modificationHistory: (m.modificationHistory ?? []) as ModelVersion["modificationHistory"],
        embeddingDimensions: m.embeddingDimensions ?? null,
        enabled: true,
        metadata: { ...(m.metadata ?? {}), seeded: true },
      };
      result.models.push(await registerModel(q, input));
    }
  }
  return result;
}
