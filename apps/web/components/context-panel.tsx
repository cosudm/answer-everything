"use client";

import type { AnswerRecord, ContextManifest, ModelRun, ModelSummary } from "@ae/domain";
import { useState } from "react";
import { cx, formatUsd, Pill } from "./ui";

type Tab = "sources" | "models" | "evidence" | "knowledge" | "path" | "details";

export interface PanelData {
  record: AnswerRecord | null;
  manifest: ContextManifest | null;
  runs: ModelRun[];
  models: ModelSummary[];
  selectedModelName: string | null;
  pathSteps: Array<{ step: string; detail: string | null }>;
  privacyClass: string | null;
}

/**
 * The right panel is what separates Answer Everything from a chatbot: it
 * shows what supported the answer, which intelligence produced it, how the
 * claims were classified, and the operational path. Nothing here is
 * chain-of-thought; it is provenance.
 */
export function ContextPanel({
  data,
  activeCitation,
  onSelectCitation,
}: {
  data: PanelData;
  activeCitation: string | null;
  onSelectCitation(label: string | null): void;
}) {
  const [tab, setTab] = useState<Tab>("sources");
  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "sources", label: "Sources", count: data.record?.citations.length },
    { id: "models", label: "Models" },
    { id: "evidence", label: "Evidence", count: data.record?.claims.length },
    { id: "knowledge", label: "Knowledge" },
    { id: "path", label: "Answer path" },
    { id: "details", label: "Details" },
  ];
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap gap-0.5 border-b border-line px-3 py-2" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cx(
              "rounded-md px-2 py-1 text-[12.5px] transition-colors",
              tab === t.id
                ? "bg-surface text-ink shadow-[var(--shadow-soft)]"
                : "text-ink-3 hover:text-ink-2",
            )}
          >
            {t.label}
            {t.count ? <span className="ml-1 text-ink-3">{t.count}</span> : null}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 text-[13.5px] leading-5 text-ink-2 scroll-quiet">
        {tab === "sources" ? (
          <SourcesTab data={data} activeCitation={activeCitation} onSelect={onSelectCitation} />
        ) : null}
        {tab === "models" ? <ModelsTab data={data} /> : null}
        {tab === "evidence" ? <EvidenceTab data={data} /> : null}
        {tab === "knowledge" ? <KnowledgeTab data={data} /> : null}
        {tab === "path" ? <PathTab data={data} /> : null}
        {tab === "details" ? <DetailsTab data={data} /> : null}
      </div>
    </div>
  );
}

/** Excerpts are raw chunk text; drop markdown heading lines for display. */
function plainExcerpt(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s{0,3}#{1,6}\s/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="text-[13px] text-ink-3">{children}</p>;
}

function SourcesTab({
  data,
  activeCitation,
  onSelect,
}: {
  data: PanelData;
  activeCitation: string | null;
  onSelect(l: string | null): void;
}) {
  const cits = data.record?.citations ?? [];
  if (!data.record)
    return (
      <Quiet>Sources supporting the current answer appear here once an answer is recorded.</Quiet>
    );
  if (!cits.length) {
    return (
      <div className="space-y-2">
        <Quiet>No sources were retrieved for this answer.</Quiet>
        <Quiet>
          {
            data.record.limitations.find(
              (l) =>
                l.kind === "NO_SOURCES_RETRIEVED" || l.kind === "AUTHORIZATION_FILTERED_SOURCES",
            )?.message
          }
        </Quiet>
      </div>
    );
  }
  return (
    <ul className="space-y-2.5">
      {cits.map((c) => (
        <li key={c.id}>
          <button
            onClick={() => onSelect(activeCitation === c.label ? null : c.label)}
            className={cx(
              "w-full rounded-[var(--radius-md)] border p-3 text-left transition-colors",
              activeCitation === c.label
                ? "border-accent bg-surface"
                : "border-line bg-surface hover:border-line-2",
            )}
          >
            <div className="flex items-center gap-2">
              <span className="cite">{c.label}</span>
              <span className="truncate font-medium text-ink">{c.title ?? c.uri ?? "Source"}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5 text-[11.5px] text-ink-3">
              <span>{c.sourceKind === "PROVIDER_NATIVE" ? "web" : "workspace knowledge"}</span>
              {c.referenced ? <span>· cited in answer</span> : <span>· retrieved, not cited</span>}
              {typeof c.locator?.heading === "string" ? <span>· {c.locator.heading}</span> : null}
            </div>
            {c.excerpt ? (
              <p className="mt-2 line-clamp-4 font-serif text-[13.5px] leading-[1.45] text-ink-2">
                {plainExcerpt(c.excerpt)}
              </p>
            ) : null}
            {c.uri ? (
              <a
                href={c.uri}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-1 block truncate text-[12px] text-accent"
              >
                {c.uri}
              </a>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ModelsTab({ data }: { data: PanelData }) {
  const runs = data.runs;
  if (!runs.length && !data.selectedModelName)
    return <Quiet>The intelligence used for the current answer is listed here.</Quiet>;
  return (
    <div className="space-y-3">
      {runs.map((r, i) => {
        const m = data.models.find((x) => x.id === r.modelVersionId);
        return (
          <div key={r.id} className="rounded-[var(--radius-md)] border border-line bg-surface p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-ink">
                {m?.displayName ?? r.modelVersionId.slice(0, 8)}
              </span>
              <Pill
                tone={
                  r.status === "SUCCEEDED"
                    ? "accent"
                    : r.status === "REFUSED"
                      ? "caution"
                      : r.status === "FAILED"
                        ? "danger"
                        : "neutral"
                }
              >
                {r.status.toLowerCase()}
              </Pill>
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12.5px]">
              <dt className="text-ink-3">Provider</dt>
              <dd>{m?.provider.displayName ?? "unknown"}</dd>
              <dt className="text-ink-3">Deployment</dt>
              <dd>{(m?.deploymentType ?? "").toLowerCase().replace(/_/g, " ")}</dd>
              <dt className="text-ink-3">Evaluation</dt>
              <dd>{(m?.evaluationStatus ?? "").toLowerCase()}</dd>
              <dt className="text-ink-3">Purpose</dt>
              <dd>
                {r.purpose.toLowerCase()}
                {runs.length > 1 && i === 0 ? " (first attempt)" : ""}
              </dd>
              {r.error ? (
                <>
                  <dt className="text-ink-3">Error</dt>
                  <dd className="text-danger">{r.error.message}</dd>
                </>
              ) : null}
              {r.refusal ? (
                <>
                  <dt className="text-ink-3">Declined</dt>
                  <dd className="text-caution">{r.refusal.code ?? r.refusal.source}</dd>
                </>
              ) : null}
            </dl>
          </div>
        );
      })}
      {!runs.length && data.selectedModelName ? (
        <Quiet>{data.selectedModelName} is answering.</Quiet>
      ) : null}
    </div>
  );
}

const CLAIM_LABEL: Record<string, { label: string; tone: "accent" | "neutral" | "caution" }> = {
  SOURCED_FACT: { label: "sourced", tone: "accent" },
  USER_PROVIDED_FACT: { label: "from you", tone: "neutral" },
  INFERENCE: { label: "inference", tone: "neutral" },
  RECOMMENDATION: { label: "recommendation", tone: "neutral" },
  UNCERTAIN: { label: "not traced to a source", tone: "caution" },
};

function EvidenceTab({ data }: { data: PanelData }) {
  const rec = data.record;
  if (!rec)
    return (
      <Quiet>
        Material claims in the answer are classified here as sourced, inferred, recommended or
        uncertain.
      </Quiet>
    );
  if (!rec.claims.length) {
    return (
      <div className="space-y-2">
        <Quiet>
          Claims are classified only when sources were available. This answer had none, so it
          reflects the model's general knowledge.
        </Quiet>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {rec.confidenceBasis ? (
        <p className="text-[12.5px] text-ink-3">{rec.confidenceBasis}</p>
      ) : null}
      <ul className="space-y-2">
        {rec.claims.map((c) => {
          const meta = CLAIM_LABEL[c.claimType] ?? CLAIM_LABEL.UNCERTAIN!;
          const labels = rec.citations
            .filter((cit) => c.citationIds.includes(cit.id))
            .map((cit) => cit.label);
          return (
            <li key={c.id} className="rounded-[var(--radius-md)] border border-line bg-surface p-3">
              <p className="font-serif text-[13.5px] leading-[1.45] text-ink">{c.text}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Pill tone={meta.tone}>{meta.label}</Pill>
                {labels.map((l) => (
                  <span key={l} className="cite">
                    {l}
                  </span>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function KnowledgeTab({ data }: { data: PanelData }) {
  const m = data.manifest;
  if (!m)
    return <Quiet>Private workspace material considered for the answer is listed here.</Quiet>;
  const knowledge = m.items.filter((i) => i.kind === "KNOWLEDGE_CHUNK" || i.kind === "ATTACHMENT");
  const limitation = data.record?.limitations.find(
    (l) => l.kind === "AUTHORIZATION_FILTERED_SOURCES",
  );
  return (
    <div className="space-y-3">
      {m.retrieval ? (
        <p className="text-[12.5px] text-ink-3">
          {m.retrieval.candidates} candidate{m.retrieval.candidates === 1 ? "" : "s"} via{" "}
          {m.retrieval.method} retrieval, {m.retrieval.used} included.
        </p>
      ) : (
        <Quiet>Knowledge retrieval was off for this turn.</Quiet>
      )}
      {limitation ? (
        <p className="rounded-[var(--radius-md)] bg-caution-soft px-3 py-2 text-[12.5px] text-caution">
          {limitation.message}
        </p>
      ) : null}
      <ul className="space-y-1.5">
        {knowledge.map((i) => (
          <li
            key={i.id}
            className={cx(
              "flex items-center justify-between rounded-[var(--radius-sm)] border border-line px-2.5 py-1.5 text-[12.5px]",
              !i.included && "opacity-60",
            )}
          >
            <span className="flex items-center gap-2">
              {i.label ? <span className="cite">{i.label}</span> : null}
              <span>{i.kind === "ATTACHMENT" ? "attachment" : "knowledge chunk"}</span>
            </span>
            <span className="text-ink-3">
              {i.privacyClass.toLowerCase()} · {i.tokens} tok{i.included ? "" : " · dropped"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PathTab({ data }: { data: PanelData }) {
  const steps =
    data.record?.answerPath.map((s) => ({ step: s.step, detail: s.detail })) ?? data.pathSteps;
  if (!steps.length)
    return (
      <Quiet>
        The operational path from question to answer is recorded here. It is provenance, not the
        model's private reasoning.
      </Quiet>
    );
  return (
    <ol className="relative ml-2 border-l border-line-2 pl-4">
      {steps.map((s, i) => (
        <li key={i} className="relative pb-3 last:pb-0">
          <span
            className="absolute -left-[21px] top-[5px] h-2.5 w-2.5 rounded-full border-2 border-accent bg-canvas"
            aria-hidden
          />
          <p className="text-[13.5px] font-medium text-ink">{s.step}</p>
          {s.detail ? <p className="text-[12.5px] text-ink-3">{s.detail}</p> : null}
        </li>
      ))}
    </ol>
  );
}

function DetailsTab({ data }: { data: PanelData }) {
  const run = data.runs.at(-1);
  const rec = data.record;
  const rows: Array<[string, string]> = [];
  if (run) {
    const m = data.models.find((x) => x.id === run.modelVersionId);
    rows.push(["Model version", m ? `${m.providerModelName}` : run.modelVersionId]);
    rows.push(["Latency", run.latencyMs != null ? `${run.latencyMs} ms` : "—"]);
    rows.push([
      "First token",
      run.timeToFirstTokenMs != null ? `${run.timeToFirstTokenMs} ms` : "—",
    ]);
    if (run.usage)
      rows.push([
        "Tokens",
        `${run.usage.inputTokens} in · ${run.usage.outputTokens} out${run.usage.reported ? "" : " (estimated)"}`,
      ]);
    rows.push(["Estimated cost", formatUsd(run.estimatedCostUsd)]);
    if (run.providerRequestId) rows.push(["Provider request", run.providerRequestId]);
    rows.push(["Started", new Date(run.startedAt).toLocaleString()]);
  }
  if (data.manifest) {
    rows.push(["Privacy class", data.manifest.informationPrivacyClass.toLowerCase()]);
    rows.push(["Context", `${data.manifest.tokensUsed} of ${data.manifest.tokenBudget} tokens`]);
    rows.push(["Strategy", data.manifest.strategy.toLowerCase().replace(/_/g, " ")]);
  } else if (data.privacyClass) rows.push(["Privacy class", data.privacyClass.toLowerCase()]);
  if (rec) rows.push(["Disposition", rec.disposition.toLowerCase().replace(/_/g, " ")]);
  if (!rows.length)
    return (
      <Quiet>
        Model version, latency, tokens, cost and privacy classification for the current answer.
      </Quiet>
    );
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-3">{k}</dt>
            <dd className="break-all text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      {rec?.limitations.length ? (
        <div>
          <p className="mb-1 text-[12.5px] font-medium text-ink-2">Limitations</p>
          <ul className="space-y-1">
            {rec.limitations.map((l, i) => (
              <li key={i} className="text-[12.5px] text-ink-3">
                {l.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
