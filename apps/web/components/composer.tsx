"use client";

import type { ModelMode, ModelSummary } from "@ae/domain";
import { ArrowUp, Check, ChevronDown, Paperclip, Square } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, cx } from "./ui";

export interface ComposerSelection {
  mode: ModelMode;
  modelVersionId: string | null;
  useKnowledge: boolean;
}

const MODES: Array<{ id: ModelMode; label: string; blurb: string }> = [
  { id: "AUTO", label: "Auto", blurb: "Best available intelligence for the question" },
  { id: "FRONTIER", label: "Frontier", blurb: "Strongest commercial reasoning models" },
  { id: "RESEARCH", label: "Research", blurb: "Evidence, citations and long context" },
  { id: "PRIVATE", label: "Private", blurb: "Open-weight or privately deployed only" },
  { id: "HIGH_LATITUDE", label: "High latitude", blurb: "Broader intellectual exploration" },
  {
    id: "EXPERIMENTAL",
    label: "Experimental",
    blurb: "Research-stage configurations, where permitted",
  },
];

export function Composer({
  models,
  selection,
  onSelectionChange,
  onSubmit,
  onStop,
  busy,
  large,
  autoFocus,
  placeholder = "Ask anything...",
  onAttach,
  attachmentCount = 0,
}: {
  models: ModelSummary[];
  selection: ComposerSelection;
  onSelectionChange(s: ComposerSelection): void;
  onSubmit(text: string): void;
  onStop?(): void;
  busy: boolean;
  large?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  onAttach?(): void;
  attachmentCount?: number;
}) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    onSubmit(t);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className={cx(
        "composer rounded-[var(--radius-lg)] border border-line bg-surface shadow-[var(--shadow-soft)] focus-within:border-accent",
        large ? "p-3" : "p-2",
      )}
    >
      <textarea
        ref={ref}
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        rows={large ? 3 : 1}
        placeholder={placeholder}
        aria-label="Your question"
        className={cx(
          "block w-full resize-none bg-transparent px-2 py-1.5 text-ink placeholder:text-ink-3 focus:outline-none",
          large ? "font-serif text-[19px] leading-[1.45]" : "text-[15.5px] leading-[1.5]",
        )}
      />
      <div className="mt-1 flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-1">
          <ModelPicker models={models} selection={selection} onChange={onSelectionChange} />
          <button
            type="button"
            onClick={() =>
              onSelectionChange({ ...selection, useKnowledge: !selection.useKnowledge })
            }
            className={cx(
              "rounded-full px-2.5 py-1 text-[12.5px] transition-colors",
              selection.useKnowledge
                ? "bg-accent-soft text-accent-2"
                : "text-ink-3 hover:bg-surface-2 hover:text-ink-2",
            )}
            aria-pressed={selection.useKnowledge}
            title="Use workspace knowledge as sources"
          >
            Knowledge {selection.useKnowledge ? "on" : "off"}
          </button>
          {onAttach ? (
            <button
              type="button"
              onClick={onAttach}
              className="rounded-full p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink-2"
              aria-label="Attach knowledge"
            >
              <Paperclip size={15} />
              {attachmentCount ? <span className="ml-1 text-[12px]">{attachmentCount}</span> : null}
            </button>
          ) : null}
        </div>
        {busy && onStop ? (
          <Button variant="secondary" size="sm" onClick={onStop} aria-label="Stop generating">
            <Square size={12} /> Stop
          </Button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!text.trim() || busy}
            aria-label="Send"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-white transition-colors hover:bg-accent-2 disabled:bg-line-2 disabled:text-ink-3"
          >
            <ArrowUp size={16} strokeWidth={2.25} />
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Picking a capability, not infrastructure: modes first, then specific
 * models grouped by deployment. Unselectable models show the reason instead
 * of disappearing, so the user learns what the workspace permits.
 */
export function ModelPicker({
  models,
  selection,
  onChange,
}: {
  models: ModelSummary[];
  selection: ComposerSelection;
  onChange(s: ComposerSelection): void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const pinned = selection.modelVersionId
    ? models.find((m) => m.id === selection.modelVersionId)
    : null;
  const label = pinned
    ? pinned.displayName
    : (MODES.find((m) => m.id === selection.mode)?.label ?? "Auto");
  const chat = models.filter((m) => m.capabilities.includes("chat"));
  const groups: Array<{ title: string; items: ModelSummary[] }> = [
    { title: "Frontier", items: chat.filter((m) => m.deploymentType === "COMMERCIAL_API") },
    {
      title: "Private",
      items: chat.filter(
        (m) => m.deploymentType === "DEDICATED_ENDPOINT" || m.deploymentType === "OPEN_WEIGHT",
      ),
    },
    { title: "Local", items: chat.filter((m) => m.deploymentType === "LOCAL") },
  ].filter((g) => g.items.length);

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[12.5px] text-ink-2 hover:bg-surface-2 hover:text-ink"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="text-ink-3">Model</span>
        <span className="font-medium text-ink">{label}</span>
        <ChevronDown size={13} aria-hidden />
      </button>
      {open ? (
        <div
          className="absolute bottom-full left-0 z-20 mb-2 w-[320px] rounded-[var(--radius-md)] border border-line bg-surface p-1.5 shadow-[var(--shadow-soft)]"
          role="listbox"
        >
          <div className="px-2 pb-1 pt-1.5 text-[11.5px] text-ink-3">Modes</div>
          {MODES.map((m) => (
            <button
              key={m.id}
              role="option"
              aria-selected={!pinned && selection.mode === m.id}
              onClick={() => {
                onChange({ ...selection, mode: m.id, modelVersionId: null });
                setOpen(false);
              }}
              className="flex w-full items-start gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left hover:bg-surface-2"
            >
              <span className="mt-[3px] w-3.5 shrink-0 text-accent">
                {!pinned && selection.mode === m.id ? <Check size={14} /> : null}
              </span>
              <span>
                <span className="block text-[13.5px] text-ink">{m.label}</span>
                <span className="block text-[12px] text-ink-3">{m.blurb}</span>
              </span>
            </button>
          ))}
          {groups.map((g) => (
            <div key={g.title}>
              <div className="mt-1 border-t border-line px-2 pb-1 pt-2 text-[11.5px] text-ink-3">
                {g.title}
              </div>
              {g.items.map((m) => (
                <button
                  key={m.id}
                  role="option"
                  aria-selected={pinned?.id === m.id}
                  disabled={!m.selectable}
                  title={m.selectableReason ?? undefined}
                  onClick={() => {
                    onChange({ ...selection, modelVersionId: m.id });
                    setOpen(false);
                  }}
                  className="flex w-full items-start gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-left hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="mt-[3px] w-3.5 shrink-0 text-accent">
                    {pinned?.id === m.id ? <Check size={14} /> : null}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13.5px] text-ink">{m.displayName}</span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {m.provider.displayName}
                      {m.evaluationStatus !== "APPROVED"
                        ? ` · ${m.evaluationStatus.toLowerCase()}`
                        : ""}
                      {!m.selectable && m.selectableReason
                        ? ` · ${humanizeReason(m.selectableReason)}`
                        : ""}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function humanizeReason(reason: string): string {
  return reason
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/credential ([A-Z0-9_]+) is not configured/i, "credential not configured")
    .replace(/experimental not allowed/, "experimental models not enabled in this workspace")
    .replace(/privacy class exceeds model/, "not cleared for this workspace's data")
    .replace(/no membership/, "not a member");
}
