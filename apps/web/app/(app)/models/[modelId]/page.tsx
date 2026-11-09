"use client";

import type { EvaluationRun, ModelHealth, ModelVersion, Provider } from "@ae/domain";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/shell";
import { Button, Notice, Pill, Spinner } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";

type Detail = {
  model: ModelVersion;
  provider: Omit<Provider, "credentialRef">;
  evaluationRuns: Array<EvaluationRun & { suiteSlug: string; suiteName: string; category: string }>;
  statusHistory: Array<{
    from_status: string | null;
    to_status: string;
    reason: string | null;
    created_at: string;
  }>;
};

/**
 * Model Lab view. Scores shown here come from recorded evaluation runs and
 * nowhere else; a model without runs shows exactly that.
 */
export default function ModelDetailPage() {
  const { modelId } = useParams<{ modelId: string }>();
  const { workspace: ws } = useSession();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [health, setHealth] = useState<ModelHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!ws) return;
    api<Detail>(`/v1/workspaces/${ws.id}/models/${modelId}`)
      .then(setDetail)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Could not load the model."));
  }, [ws, modelId]);

  const checkHealth = async () => {
    if (!ws) return;
    setChecking(true);
    try {
      setHealth(await api<ModelHealth>(`/v1/workspaces/${ws.id}/models/${modelId}/health`));
    } finally {
      setChecking(false);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[900px] px-5 py-8 sm:px-8">
        <Link
          href="/models"
          className="inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink"
        >
          <ArrowLeft size={14} /> All models
        </Link>
        {error ? (
          <div className="mt-4">
            <Notice tone="danger">{error}</Notice>
          </div>
        ) : null}
        {!detail && !error ? (
          <div className="mt-6">
            <Spinner label="Loading model" />
          </div>
        ) : null}
        {detail ? (
          <>
            <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="font-serif text-[28px] font-semibold tracking-tight text-ink">
                  {detail.model.displayName}
                </h1>
                <p className="text-[14px] text-ink-2">
                  {detail.provider.displayName} · {detail.model.providerModelName}
                  {detail.model.version ? ` · v${detail.model.version}` : ""}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Pill
                    tone={
                      detail.model.evaluationStatus === "APPROVED"
                        ? "accent"
                        : detail.model.evaluationStatus === "REJECTED"
                          ? "danger"
                          : "caution"
                    }
                  >
                    {detail.model.evaluationStatus.toLowerCase()}
                  </Pill>
                  <Pill>{detail.model.deploymentType.toLowerCase().replace("_", " ")}</Pill>
                  <Pill>{detail.model.behavioralProfile.toLowerCase().replace("_", " ")}</Pill>
                  {!detail.model.enabled ? <Pill tone="danger">disabled</Pill> : null}
                </div>
              </div>
              <div className="text-right">
                <Button size="sm" onClick={checkHealth} disabled={checking}>
                  {checking ? "Checking" : "Check health"}
                </Button>
                {health ? (
                  <p className="mt-1.5 text-[12.5px] text-ink-3">
                    {health.status.toLowerCase()}
                    {health.latencyMs != null ? ` · ${health.latencyMs} ms` : ""}
                    {health.detail ? ` · ${health.detail}` : ""}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="mt-8 grid gap-8 md:grid-cols-2">
              <section>
                <h2 className="mb-2 font-serif text-[18px] text-ink">Identity</h2>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13.5px]">
                  <Row k="Base model" v={detail.model.baseModel ?? "same as provider model"} />
                  <Row
                    k="Weights hash"
                    v={detail.model.weightsHash ?? "not recorded (hosted API)"}
                    mono
                  />
                  <Row k="Quantization" v={detail.model.quantization ?? "n/a"} />
                  <Row
                    k="Context window"
                    v={Intl.NumberFormat().format(detail.model.contextWindow)}
                  />
                  <Row
                    k="Max output"
                    v={
                      detail.model.maxOutputTokens
                        ? Intl.NumberFormat().format(detail.model.maxOutputTokens)
                        : "provider default"
                    }
                  />
                  <Row k="Capabilities" v={detail.model.capabilities.join(", ")} />
                  <Row
                    k="Privacy classes"
                    v={detail.model.privacyClassesAllowed.map((p) => p.toLowerCase()).join(", ")}
                  />
                  <Row
                    k="Pricing"
                    v={
                      detail.model.inputCostPerMillion != null
                        ? `$${detail.model.inputCostPerMillion} in · $${detail.model.outputCostPerMillion} out per M tokens`
                        : "unknown (cost not estimated)"
                    }
                  />
                  <Row k="License" v={detail.model.license ?? "not recorded"} />
                  <Row
                    k="Data handling"
                    v={`${detail.provider.dataHandling.trainsOnData ? "trains on data" : "no training"} · retention ${detail.provider.dataHandling.retentionDays ?? "unspecified"} days · ${detail.provider.dataHandling.region ?? "region unspecified"}`}
                  />
                </dl>
                {detail.model.intendedUses.length ? (
                  <p className="mt-3 text-[13.5px] text-ink-2">
                    <span className="text-ink-3">Intended: </span>
                    {detail.model.intendedUses.join("; ")}
                  </p>
                ) : null}
                {detail.model.prohibitedUses.length ? (
                  <p className="mt-1 text-[13.5px] text-ink-2">
                    <span className="text-ink-3">Prohibited: </span>
                    {detail.model.prohibitedUses.join("; ")}
                  </p>
                ) : null}
                {detail.model.modificationHistory.length ? (
                  <div className="mt-3">
                    <p className="text-[13px] font-medium text-ink-2">Modification history</p>
                    <ul className="mt-1 space-y-1 text-[13px] text-ink-2">
                      {detail.model.modificationHistory.map((m, i) => (
                        <li key={i}>
                          {m.method}
                          {m.version ? ` v${m.version}` : ""}{" "}
                          {m.performedAt ? `· ${new Date(m.performedAt).toLocaleDateString()}` : ""}{" "}
                          {m.notes ? `· ${m.notes}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>

              <section>
                <h2 className="mb-2 font-serif text-[18px] text-ink">Evaluation</h2>
                {detail.evaluationRuns.length ? (
                  <ul className="space-y-2">
                    {detail.evaluationRuns.map((r) => (
                      <li
                        key={r.id}
                        className="rounded-[var(--radius-md)] border border-line bg-surface p-3 text-[13px]"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-ink">{r.suiteName}</span>
                          <Pill>{r.category.toLowerCase().replace("_", " ")}</Pill>
                        </div>
                        <p className="text-[12.5px] text-ink-3">
                          {r.status.toLowerCase()} · suite v{r.suiteVersion} ·{" "}
                          {new Date(r.startedAt).toLocaleString()}
                        </p>
                        {r.summary ? (
                          <dl className="mt-2 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                            <Stat
                              label="Score"
                              value={`${Math.round(r.summary.weightedScore * 100)}`}
                            />
                            <Stat label="Passed" value={`${r.summary.passed}/${r.summary.cases}`} />
                            <Stat
                              label="Over-refusal"
                              value={
                                r.summary.excessiveRefusalRate == null
                                  ? "n/a"
                                  : `${Math.round(r.summary.excessiveRefusalRate * 100)}%`
                              }
                            />
                            <Stat
                              label="Missed refusal"
                              value={
                                r.summary.missedRefusalRate == null
                                  ? "n/a"
                                  : `${Math.round(r.summary.missedRefusalRate * 100)}%`
                              }
                            />
                          </dl>
                        ) : null}
                        {r.error ? (
                          <p className="mt-1 text-[12.5px] text-danger">{r.error}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Notice>
                    No evaluation runs recorded for this version. Scores appear only after the
                    harness has run; nothing here is estimated.
                  </Notice>
                )}
                {detail.statusHistory.length ? (
                  <div className="mt-4">
                    <p className="text-[13px] font-medium text-ink-2">Status history</p>
                    <ul className="mt-1 space-y-1 text-[13px] text-ink-2">
                      {detail.statusHistory.map((s, i) => (
                        <li key={i}>
                          {s.from_status?.toLowerCase() ?? "new"} → {s.to_status.toLowerCase()} ·{" "}
                          {new Date(s.created_at).toLocaleString()}
                          {s.reason ? ` · ${s.reason}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            </div>
          </>
        ) : null}
      </div>
    </AppShell>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-ink-3">{k}</dt>
      <dd className={mono ? "break-all font-mono text-[12px] text-ink" : "text-ink"}>{v}</dd>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-sm)] bg-canvas px-2 py-1.5">
      <dt className="text-[11px] text-ink-3">{label}</dt>
      <dd className="font-serif text-[18px] text-ink">{value}</dd>
    </div>
  );
}
