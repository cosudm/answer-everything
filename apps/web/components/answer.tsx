"use client";

import type { AnswerRecord, Message, ModelRun } from "@ae/domain";
import { DISPOSITION_STATEMENT } from "@ae/domain";
import { Copy, RefreshCw, Shuffle } from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button, cx, Pill } from "./ui";

export interface LiveAnswer {
  messageId: string;
  text: string;
  streaming: boolean;
  modelName: string | null;
  notices: string[];
  record: AnswerRecord | null;
  runs: ModelRun[];
  error: string | null;
}

export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Converts [S1] markers into links the markdown renderer turns into chips. */
function withCitationLinks(text: string): string {
  return text.replace(/\[((?:S\d{1,3})(?:\s*,\s*S\d{1,3})*)\]/g, (_m, labels: string) =>
    labels
      .split(",")
      .map((l) => l.trim())
      .map((l) => `[${l}](#cite-${l})`)
      .join(""),
  );
}

export function AnswerBody({
  text,
  streaming,
  activeCitation,
  onCite,
}: {
  text: string;
  streaming?: boolean;
  activeCitation?: string | null;
  onCite?(label: string): void;
}) {
  const prepared = useMemo(() => withCitationLinks(text), [text]);
  return (
    <div className={cx("prose-answer", streaming && "caret")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...props }) => {
            if (href?.startsWith("#cite-")) {
              const label = href.slice(6);
              return (
                <a
                  href={href}
                  className="cite"
                  data-active={activeCitation === label}
                  onClick={(e) => {
                    e.preventDefault();
                    onCite?.(label);
                  }}
                  title={`Source ${label}`}
                >
                  {label}
                </a>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener" {...props}>
                {children}
              </a>
            );
          },
        }}
      >
        {prepared}
      </ReactMarkdown>
    </div>
  );
}

/**
 * The outcome statement. Not every non-answer is a refusal: each
 * disposition gets its own plain sentence, and the only coloured treatment is
 * reserved for provider restrictions and failures.
 */
export function DispositionLine({
  record,
  onTryAnother,
}: {
  record: AnswerRecord;
  onTryAnother?(): void;
}) {
  if (record.disposition === "ANSWERED") return null;
  const tone =
    record.disposition === "PROVIDER_RESTRICTED" || record.disposition === "FAILED"
      ? "caution"
      : "neutral";
  const detail = record.limitations.find((l) => l.kind !== "CLAIMS_NOT_VERIFIED")?.message;
  return (
    <div
      className={cx(
        "mb-3 rounded-[var(--radius-md)] border px-3.5 py-2.5 text-[14px]",
        tone === "caution"
          ? "border-transparent bg-caution-soft text-caution"
          : "border-line bg-surface-2 text-ink-2",
      )}
    >
      <p className="font-medium">{DISPOSITION_STATEMENT[record.disposition]}</p>
      {detail && detail !== DISPOSITION_STATEMENT[record.disposition] ? (
        <p className="mt-0.5 text-[13px] opacity-90">{detail}</p>
      ) : null}
      {record.disposition === "PROVIDER_RESTRICTED" && onTryAnother ? (
        <Button size="sm" variant="secondary" className="mt-2" onClick={onTryAnother}>
          <Shuffle size={13} /> Try another approved model
        </Button>
      ) : null}
    </div>
  );
}

export function AssistantTurn({
  message,
  live,
  record,
  runs,
  activeCitation,
  onCite,
  onRegenerate,
  onTryAnother,
  lane,
}: {
  message: Message | null;
  live: LiveAnswer | null;
  record: AnswerRecord | null;
  runs: ModelRun[];
  activeCitation: string | null;
  onCite(label: string): void;
  onRegenerate?(): void;
  onTryAnother?(): void;
  lane?: number;
}) {
  const [copied, setCopied] = useState(false);
  const text = live?.text ?? record?.content ?? message?.content ?? "";
  const streaming = Boolean(live?.streaming);
  const rec = record ?? live?.record ?? null;
  const modelName =
    (message?.metadata?.modelDisplayName as string | undefined) ?? live?.modelName ?? null;
  const confidence = rec?.confidence;
  const lastRun = runs.at(-1) ?? live?.runs.at(-1) ?? null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <article className="group" aria-busy={streaming}>
      <header className="mb-2 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        <span className="font-medium text-ink-2">
          {lane !== undefined ? `Lane ${lane + 1}` : "Answer"}
        </span>
        {modelName ? <span>· {modelName}</span> : null}
        {streaming ? <span>· writing</span> : null}
        {rec && confidence != null ? (
          <Pill
            tone={confidence >= 0.7 ? "accent" : "neutral"}
            title={rec.confidenceBasis ?? undefined}
          >
            evidence coverage {Math.round(confidence * 100)}%
          </Pill>
        ) : null}
        {rec && rec.citations.filter((c) => c.referenced).length ? (
          <Pill tone="neutral">
            {plural(rec.citations.filter((c) => c.referenced).length, "source")} cited
          </Pill>
        ) : null}
        {lastRun?.estimatedCostUsd != null && lastRun.estimatedCostUsd > 0 ? (
          <span>· ${lastRun.estimatedCostUsd.toFixed(4)}</span>
        ) : null}
      </header>
      {live?.notices.map((n, i) => (
        <p
          key={i}
          className="mb-2 rounded-[var(--radius-md)] bg-caution-soft px-3 py-2 text-[13px] text-caution"
        >
          {n}
        </p>
      ))}
      {rec ? <DispositionLine record={rec} onTryAnother={onTryAnother} /> : null}
      {live?.error ? (
        <p className="mb-2 rounded-[var(--radius-md)] bg-danger-soft px-3 py-2 text-[13px] text-danger">
          {live.error}
        </p>
      ) : null}
      {text &&
      (!rec || rec.disposition === "ANSWERED" || rec.disposition === "PARTIALLY_ANSWERED") ? (
        <AnswerBody
          text={text}
          streaming={streaming}
          activeCitation={activeCitation}
          onCite={onCite}
        />
      ) : null}
      {!streaming && text ? (
        <footer className="mt-3 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button variant="ghost" size="sm" onClick={copy} aria-label="Copy answer">
            <Copy size={13} /> {copied ? "Copied" : "Copy"}
          </Button>
          {onRegenerate ? (
            <Button variant="ghost" size="sm" onClick={onRegenerate} aria-label="Regenerate answer">
              <RefreshCw size={13} /> Regenerate
            </Button>
          ) : null}
        </footer>
      ) : null}
    </article>
  );
}

export function UserTurn({ message }: { message: Message }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-[var(--radius-lg)] rounded-br-[4px] bg-surface-2 px-4 py-2.5 font-serif text-[16.5px] leading-[1.5] text-ink">
        {message.content}
        {message.attachments.length ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {message.attachments.map((a) => (
              <Pill key={a.knowledgeObjectId}>{a.title}</Pill>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
