"use client";

import type { ModelSummary } from "@ae/domain";
import Link from "next/link";
import { humanizeReason } from "@/components/composer";
import { AppShell } from "@/components/shell";
import { cx, Empty, Notice, Pill } from "@/components/ui";
import { useSession } from "@/lib/session";
import { useModels } from "@/lib/use-ask";

const GROUPS: Array<{ title: string; blurb: string; match: (m: ModelSummary) => boolean }> = [
  {
    title: "Frontier",
    blurb: "Commercial API models with the strongest general reasoning.",
    match: (m) => m.deploymentType === "COMMERCIAL_API" && m.capabilities.includes("chat"),
  },
  {
    title: "Private",
    blurb: "Dedicated or open-weight deployments under your control.",
    match: (m) =>
      (m.deploymentType === "DEDICATED_ENDPOINT" || m.deploymentType === "OPEN_WEIGHT") &&
      m.capabilities.includes("chat"),
  },
  {
    title: "Local",
    blurb: "Development-only deployments on this machine.",
    match: (m) => m.deploymentType === "LOCAL" && m.capabilities.includes("chat"),
  },
  {
    title: "Embeddings",
    blurb: "Used to index knowledge; never answers questions.",
    match: (m) => m.capabilities.includes("embeddings"),
  },
];

export default function ModelsPage() {
  const { workspace: ws } = useSession();
  const { models, error } = useModels(ws?.id ?? null);
  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[900px] px-5 py-8 sm:px-8">
        <h1 className="font-serif text-[28px] font-semibold tracking-tight text-ink">Models</h1>
        <p className="mt-1 max-w-[62ch] text-[14px] text-ink-2">
          Every model is a versioned, evaluated identity. You pick a capability; the registry
          decides what is cleared for your workspace's data and which checkpoints have passed
          evaluation. Capability never grants authority.
        </p>
        {error ? (
          <div className="mt-4">
            <Notice tone="danger">{error}</Notice>
          </div>
        ) : null}
        <div className="mt-8 space-y-9">
          {GROUPS.map((g) => {
            const items = models.filter(g.match);
            if (!items.length) return null;
            return (
              <section key={g.title}>
                <h2 className="font-serif text-[19px] text-ink">{g.title}</h2>
                <p className="mb-3 text-[13px] text-ink-3">{g.blurb}</p>
                <ul className="overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface">
                  {items.map((m) => (
                    <li key={m.id} className="border-b border-line last:border-b-0">
                      <Link
                        href={`/models/${m.id}`}
                        className={cx(
                          "flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-canvas/60",
                          !m.selectable && "opacity-80",
                        )}
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[15px] font-medium text-ink">
                            {m.displayName}
                          </p>
                          <p className="truncate text-[12.5px] text-ink-3">
                            {m.provider.displayName} · {m.providerModelName} ·{" "}
                            {Intl.NumberFormat().format(m.contextWindow)} context
                            {m.inputCostPerMillion != null
                              ? ` · $${m.inputCostPerMillion}/$${m.outputCostPerMillion} per M tokens`
                              : " · pricing unknown"}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <Pill
                            tone={
                              m.evaluationStatus === "APPROVED"
                                ? "accent"
                                : m.evaluationStatus === "REJECTED"
                                  ? "danger"
                                  : "caution"
                            }
                          >
                            {m.evaluationStatus.toLowerCase()}
                          </Pill>
                          <Pill>{m.behavioralProfile.toLowerCase().replace("_", " ")}</Pill>
                          <Pill>
                            {m.privacyClassesAllowed.at(-1)?.toLowerCase() ?? "public"} max
                          </Pill>
                          {!m.configured ? <Pill tone="caution">not configured</Pill> : null}
                          {m.configured && !m.selectable && m.selectableReason ? (
                            <Pill tone="neutral">{humanizeReason(m.selectableReason)}</Pill>
                          ) : null}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
          {!models.length && !error ? (
            <Empty title="No models registered">
              Seed the registry with `pnpm db:seed` or register models through the API.
            </Empty>
          ) : null}
        </div>
      </div>
    </AppShell>
  );
}
