"use client";

import type { Message, ModelSummary } from "@ae/domain";
import { GitCompare, X } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { AssistantTurn, UserTurn, type LiveAnswer } from "@/components/answer";
import { Composer, type ComposerSelection } from "@/components/composer";
import { ContextPanel, type PanelData } from "@/components/context-panel";
import { AppShell } from "@/components/shell";
import { Button, cx, Notice, Pill, Spinner } from "@/components/ui";
import { useSession } from "@/lib/session";
import { PENDING_KEY, useConversation, useModels } from "@/lib/use-ask";

export default function AskPage() {
  const params = useParams<{ conversationId: string }>();
  const conversationId = params.conversationId;
  const session = useSession();
  const ws = session.workspace;
  const { models } = useModels(ws?.id ?? null);
  const { state, ask, stop } = useConversation(ws?.id ?? null, conversationId);
  const [selection, setSelection] = useState<ComposerSelection>({
    mode: "AUTO",
    modelVersionId: null,
    useKnowledge: true,
  });
  const [focusAnswerId, setFocusAnswerId] = useState<string | null>(null);
  const [activeCitation, setActiveCitation] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[] | null>(null);
  const started = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);

  const busy = Object.values(state.live).some((l) => l.streaming);

  // Adopt the conversation's mode/pinned model once loaded.
  useEffect(() => {
    if (state.conversation) {
      setSelection((s) => ({
        ...s,
        mode: state.conversation!.modelMode,
        modelVersionId: state.conversation!.pinnedModelVersionId,
      }));
    }
  }, [state.conversation]);

  // A question handed over from the home page is sent once, after the conversation loads.
  useEffect(() => {
    if (!ws || started.current || state.loading) return;
    let pending: { content: string; selection: ComposerSelection } | null = null;
    try {
      const raw = sessionStorage.getItem(PENDING_KEY(conversationId));
      if (raw) {
        pending = JSON.parse(raw);
        sessionStorage.removeItem(PENDING_KEY(conversationId));
      }
    } catch {
      /* ignore */
    }
    if (pending) {
      started.current = true;
      setSelection(pending.selection);
      void ask({
        content: pending.content,
        modelMode: pending.selection.mode,
        modelVersionId: pending.selection.modelVersionId ?? undefined,
        useKnowledge: pending.selection.useKnowledge,
      });
    }
  }, [ws, state.loading, conversationId, ask]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [
    state.messages.length,
    Object.values(state.live)
      .map((l) => l.text.length)
      .join(","),
  ]);

  const turns = useMemo(() => groupTurns(state.messages), [state.messages]);

  // Which answer the panel describes: the focused one, else the latest.
  const latestAssistant = [...state.messages].reverse().find((m) => m.role === "ASSISTANT");
  const focusMessage =
    state.messages.find((m) => m.id === focusAnswerId) ?? latestAssistant ?? null;
  const focusLive = focusMessage ? state.live[focusMessage.id] : Object.values(state.live).at(-1);
  const focusBundle = focusMessage?.answerRecordId
    ? state.answers[focusMessage.answerRecordId]
    : focusLive?.record
      ? { record: focusLive.record, modelRuns: focusLive.runs }
      : undefined;
  const panelData: PanelData = {
    record: focusBundle?.record ?? null,
    manifest: state.lastManifest,
    runs: focusBundle?.modelRuns ?? focusLive?.runs ?? [],
    models,
    selectedModelName: state.lastSelectedModel,
    pathSteps: state.lastPath,
    privacyClass: state.conversation?.privacyClass ?? null,
  };

  const submit = (text: string) => {
    setFocusAnswerId(null); // the panel follows the newest answer
    setActiveCitation(null);
    if (compare && compare.length >= 2) {
      void ask({ content: text, useKnowledge: selection.useKnowledge, compareModelIds: compare });
      setCompare(null);
      return;
    }
    void ask({
      content: text,
      modelMode: selection.mode,
      modelVersionId: selection.modelVersionId ?? undefined,
      useKnowledge: selection.useKnowledge,
    });
  };

  const regenerate = (userMessage: Message, modelVersionId?: string) => {
    void ask({
      content: userMessage.content,
      regenerateOfMessageId: userMessage.id,
      modelMode: selection.mode,
      modelVersionId: modelVersionId ?? selection.modelVersionId ?? undefined,
      useKnowledge: selection.useKnowledge,
    });
  };

  const tryAnother = (userMessage: Message, refusedModelId: string | null) => {
    const alternative = models.find((m) => m.selectable && m.id !== refusedModelId);
    if (alternative) regenerate(userMessage, alternative.id);
  };

  return (
    <AppShell
      panel={
        <ContextPanel
          data={panelData}
          activeCitation={activeCitation}
          onSelectCitation={setActiveCitation}
        />
      }
      panelTitle="Context"
    >
      <div className="flex h-full flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-2.5 sm:px-8">
          <div className="min-w-0">
            <h1 className="truncate font-serif text-[16px] text-ink">
              {state.conversation?.title ?? "New conversation"}
            </h1>
            <p className="text-[12px] text-ink-3">
              {state.conversation
                ? `${state.conversation.privacyClass.toLowerCase()} · ${state.conversation.modelMode.toLowerCase().replace("_", " ")} mode`
                : ""}
            </p>
          </div>
          <Button
            variant={compare ? "primary" : "ghost"}
            size="sm"
            onClick={() => setCompare(compare ? null : [])}
            aria-pressed={Boolean(compare)}
          >
            <GitCompare size={14} /> Compare models
          </Button>
        </header>

        <div className="flex-1 overflow-y-auto scroll-quiet">
          <div className="mx-auto w-full max-w-[760px] px-5 py-8 sm:px-8">
            {state.loading ? <Spinner label="Loading conversation" /> : null}
            {state.error ? <Notice tone="danger">{state.error}</Notice> : null}
            <div className="space-y-10">
              {turns.map((turn) => (
                <div key={turn.user.id} className="space-y-6">
                  <UserTurn message={turn.user} />
                  <div className={cx(turn.assistants.length > 1 && "grid gap-6 lg:grid-cols-2")}>
                    {turn.assistants.map((a, i) => {
                      const bundle = a.answerRecordId ? state.answers[a.answerRecordId] : undefined;
                      const live = state.live[a.id] ?? null;
                      const refusedModel =
                        (a.metadata?.modelVersionId as string | undefined) ?? null;
                      return (
                        <div
                          key={a.id}
                          onClick={() => setFocusAnswerId(a.id)}
                          className={cx(
                            "rounded-[var(--radius-lg)] p-1 -m-1 transition-colors",
                            focusMessage?.id === a.id && turns.length > 1 ? "bg-canvas/60" : "",
                          )}
                        >
                          <AssistantTurn
                            message={a}
                            live={live}
                            record={bundle?.record ?? null}
                            runs={bundle?.modelRuns ?? []}
                            activeCitation={focusMessage?.id === a.id ? activeCitation : null}
                            onCite={(l) => {
                              setFocusAnswerId(a.id);
                              setActiveCitation(l);
                            }}
                            onRegenerate={!busy ? () => regenerate(turn.user) : undefined}
                            onTryAnother={
                              !busy ? () => tryAnother(turn.user, refusedModel) : undefined
                            }
                            lane={turn.assistants.length > 1 ? i : undefined}
                          />
                        </div>
                      );
                    })}
                    {/* Compare lanes streaming before their messages are persisted locally */}
                    {turn === turns.at(-1)
                      ? Object.values(state.live)
                          .filter((l) => l.messageId.startsWith("lane-"))
                          .map((l, i) => <LiveLane key={l.messageId} live={l} lane={i} />)
                      : null}
                  </div>
                </div>
              ))}
              {!state.loading && !turns.length ? (
                <p className="font-serif text-[18px] text-ink-3">Ask your first question below.</p>
              ) : null}
            </div>
            <div ref={bottom} />
          </div>
        </div>

        <div className="border-t border-line bg-surface px-5 py-3 sm:px-8">
          <div className="mx-auto w-full max-w-[760px]">
            {compare ? (
              <CompareBar
                models={models}
                selected={compare}
                onChange={setCompare}
                onClose={() => setCompare(null)}
              />
            ) : null}
            <Composer
              models={models}
              selection={selection}
              onSelectionChange={setSelection}
              onSubmit={submit}
              onStop={stop}
              busy={busy}
              placeholder={
                compare
                  ? compare.length >= 2
                    ? "Ask once; every selected model answers"
                    : "Select two to four models above, then ask"
                  : "Ask a follow-up..."
              }
            />
            {state.conversation?.privacyClass === "RESTRICTED" ||
            state.conversation?.privacyClass === "CONFIDENTIAL" ? (
              <p className="mt-1.5 text-[12px] text-ink-3">
                This conversation holds {state.conversation.privacyClass.toLowerCase()} information.
                Only models cleared for it can answer.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function LiveLane({ live, lane }: { live: LiveAnswer; lane: number }) {
  return (
    <div>
      <AssistantTurn
        message={null}
        live={live}
        record={live.record}
        runs={live.runs}
        activeCitation={null}
        onCite={() => undefined}
        lane={lane}
      />
    </div>
  );
}

function CompareBar({
  models,
  selected,
  onChange,
  onClose,
}: {
  models: ModelSummary[];
  selected: string[];
  onChange(ids: string[]): void;
  onClose(): void;
}) {
  const selectable = models.filter((m) => m.selectable);
  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else if (selected.length < 4) onChange([...selected, id]);
  };
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-[var(--radius-md)] border border-line bg-canvas px-3 py-2">
      <span className="mr-1 text-[12.5px] text-ink-2">Compare</span>
      {selectable.map((m) => (
        <button
          key={m.id}
          onClick={() => toggle(m.id)}
          aria-pressed={selected.includes(m.id)}
          className={cx(
            "rounded-full border px-2.5 py-1 text-[12.5px] transition-colors",
            selected.includes(m.id)
              ? "border-accent bg-accent-soft text-accent-2"
              : "border-line bg-surface text-ink-2 hover:border-line-2",
          )}
        >
          {m.displayName}
        </button>
      ))}
      {!selectable.length ? <Pill tone="caution">No selectable models</Pill> : null}
      <button
        onClick={onClose}
        className="ml-auto rounded-md p-1 text-ink-3 hover:text-ink"
        aria-label="Close compare"
      >
        <X size={14} />
      </button>
    </div>
  );
}

interface Turn {
  user: Message;
  assistants: Message[];
}

/** Pairs each user message with the assistant messages that answer it (one, or several lanes). */
function groupTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  const byId = new Map<string, Turn>();
  for (const m of messages) {
    if (m.role === "USER") {
      const t = { user: m, assistants: [] };
      turns.push(t);
      byId.set(m.id, t);
    } else if (m.role === "ASSISTANT") {
      const parent = (m.parentMessageId && byId.get(m.parentMessageId)) || turns.at(-1);
      parent?.assistants.push(m);
    }
  }
  return turns;
}
