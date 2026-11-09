"use client";

import type {
  AnswerRecord,
  AskInput,
  AskStreamEvent,
  ContextManifest,
  Conversation,
  Message,
  ModelRun,
  ModelSummary,
} from "@ae/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveAnswer } from "@/components/answer";
import { api, ApiError, streamAsk } from "./api";

export interface AnswerBundle {
  record: AnswerRecord;
  modelRuns: ModelRun[];
}

export interface ConversationState {
  conversation: Conversation | null;
  messages: Message[];
  answers: Record<string, AnswerBundle>;
  live: Record<string, LiveAnswer>;
  /** Manifest + path for the most recent turn (shown in the panel while streaming). */
  lastManifest: ContextManifest | null;
  lastPath: Array<{ step: string; detail: string | null }>;
  lastSelectedModel: string | null;
  loading: boolean;
  error: string | null;
}

export const PENDING_KEY = (conversationId: string) => `ae.pending.${conversationId}`;

export function useConversation(workspaceId: string | null, conversationId: string | null) {
  const [state, setState] = useState<ConversationState>({
    conversation: null,
    messages: [],
    answers: {},
    live: {},
    lastManifest: null,
    lastPath: [],
    lastSelectedModel: null,
    loading: Boolean(conversationId),
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId || !conversationId) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api<{
        conversation: Conversation;
        messages: Message[];
        answers: Record<string, AnswerRecord & { modelRuns: ModelRun[] }>;
      }>(`/v1/workspaces/${workspaceId}/conversations/${conversationId}`);
      const answers: Record<string, AnswerBundle> = {};
      for (const [id, a] of Object.entries(data.answers)) {
        const { modelRuns, ...record } = a;
        answers[id] = { record, modelRuns };
      }
      setState((s) => ({
        ...s,
        conversation: data.conversation,
        messages: data.messages,
        answers,
        // Compare lanes stream under temporary ids; once persisted messages are loaded they take over.
        live: Object.fromEntries(Object.entries(s.live).filter(([k]) => !k.startsWith("lane-"))),
        loading: false,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof ApiError ? err.message : "Could not load this conversation.",
      }));
    }
  }, [workspaceId, conversationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const ask = useCallback(
    async (input: AskInput & { compareModelIds?: string[] }) => {
      if (!workspaceId || !conversationId) return;
      const controller = new AbortController();
      abortRef.current = controller;
      const path = input.compareModelIds
        ? `/v1/workspaces/${workspaceId}/conversations/${conversationId}/compare`
        : `/v1/workspaces/${workspaceId}/conversations/${conversationId}/messages`;
      const body = input.compareModelIds
        ? {
            content: input.content,
            modelVersionIds: input.compareModelIds,
            useKnowledge: input.useKnowledge,
          }
        : input;
      const laneIds: Record<number, string> = {};
      let primaryId: string | null = null;
      setState((s) => ({
        ...s,
        lastManifest: null,
        lastPath: [],
        lastSelectedModel: null,
        error: null,
      }));
      try {
        for await (const ev of streamAsk(path, body, controller.signal)) {
          handle(ev);
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          setState((s) => {
            const live = { ...s.live };
            for (const id of Object.keys(live))
              if (live[id]!.streaming)
                live[id] = {
                  ...live[id]!,
                  streaming: false,
                  notices: [...live[id]!.notices, "Stopped."],
                };
            return { ...s, live };
          });
        } else {
          setState((s) => ({
            ...s,
            error:
              err instanceof ApiError ? err.message : "The connection to the API was interrupted.",
          }));
        }
      } finally {
        abortRef.current = null;
        // Reload the persisted state so the view reflects exactly what was recorded.
        void load();
      }

      function laneMessageId(lane: number | undefined): string | null {
        if (lane === undefined) return primaryId;
        return laneIds[lane] ?? null;
      }

      function handle(ev: AskStreamEvent) {
        setState((s) => {
          const next = { ...s, live: { ...s.live } };
          switch (ev.type) {
            case "accepted": {
              primaryId = ev.assistantMessageId;
              next.messages = [
                ...s.messages.filter((m) => m.id !== ev.userMessage.id),
                ev.userMessage,
              ];
              if (!input.compareModelIds) {
                next.live[ev.assistantMessageId] = {
                  messageId: ev.assistantMessageId,
                  text: "",
                  streaming: true,
                  modelName: null,
                  notices: [],
                  record: null,
                  runs: [],
                  error: null,
                };
              }
              break;
            }
            case "path":
              next.lastPath = [...s.lastPath, { step: ev.step, detail: ev.detail }];
              break;
            case "context":
              next.lastManifest = ev.manifest;
              break;
            case "model_selected": {
              next.lastSelectedModel = ev.displayName;
              if (ev.lane !== undefined && !laneIds[ev.lane]) {
                const id = `lane-${ev.lane}`;
                laneIds[ev.lane] = id;
                next.live[id] = {
                  messageId: id,
                  text: "",
                  streaming: true,
                  modelName: ev.displayName,
                  notices: [],
                  record: null,
                  runs: [],
                  error: null,
                };
              } else {
                const id = laneMessageId(ev.lane);
                if (id && next.live[id])
                  next.live[id] = { ...next.live[id]!, modelName: ev.displayName, text: "" };
              }
              break;
            }
            case "delta": {
              const id = laneMessageId(ev.lane);
              if (id && next.live[id])
                next.live[id] = { ...next.live[id]!, text: next.live[id]!.text + ev.text };
              break;
            }
            case "notice": {
              const id = laneMessageId(ev.lane);
              if (id && next.live[id])
                next.live[id] = {
                  ...next.live[id]!,
                  notices: [...next.live[id]!.notices, ev.message],
                };
              break;
            }
            case "complete": {
              const id = laneMessageId(ev.lane);
              if (id && next.live[id]) {
                next.live[id] = {
                  ...next.live[id]!,
                  streaming: false,
                  text: ev.answerRecord.content || next.live[id]!.text,
                  record: ev.answerRecord,
                  runs: ev.modelRuns,
                };
              }
              next.answers = {
                ...s.answers,
                [ev.answerRecord.id]: { record: ev.answerRecord, modelRuns: ev.modelRuns },
              };
              break;
            }
            case "error": {
              const id = laneMessageId(ev.lane);
              if (id && next.live[id])
                next.live[id] = { ...next.live[id]!, streaming: false, error: ev.message };
              else next.error = ev.message;
              break;
            }
          }
          return next;
        });
      }
    },
    [workspaceId, conversationId, load],
  );

  return { state, ask, stop, reload: load };
}

export function useModels(workspaceId: string | null) {
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await api<{ items: ModelSummary[] }>(`/v1/workspaces/${workspaceId}/models`);
      setModels(res.items);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load models.");
    }
  }, [workspaceId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { models, error, reload };
}
