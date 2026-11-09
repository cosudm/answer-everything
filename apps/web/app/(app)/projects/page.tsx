"use client";

import type { Conversation, Project } from "@ae/domain";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AppShell } from "@/components/shell";
import {
  Button,
  Empty,
  Field,
  formatRelative,
  Input,
  Notice,
  Pill,
  Textarea,
} from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";

export default function ProjectsPage() {
  const { workspace: ws } = useSession();
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [conversations, setConversations] = useState<Record<string, Conversation[]>>({});
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!ws) return;
    try {
      const res = await api<{ items: Project[] }>(`/v1/workspaces/${ws.id}/projects`);
      setProjects(res.items);
      const convs: Record<string, Conversation[]> = {};
      await Promise.all(
        res.items.map(async (p) => {
          const c = await api<{ items: Conversation[] }>(
            `/v1/workspaces/${ws.id}/conversations?projectId=${p.id}&limit=5`,
          );
          convs[p.id] = c.items;
        }),
      );
      setConversations(convs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load projects.");
    }
  }, [ws]);
  useEffect(() => {
    void load();
  }, [load]);

  const askIn = async (project: Project) => {
    if (!ws) return;
    const conv = await api<Conversation>(`/v1/workspaces/${ws.id}/conversations`, {
      method: "POST",
      json: { projectId: project.id },
    });
    router.push(`/ask/${conv.id}`);
  };

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[900px] px-5 py-8 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-serif text-[28px] font-semibold tracking-tight text-ink">
              Projects
            </h1>
            <p className="mt-1 text-[14px] text-ink-2">
              Persistent context: standing instructions and attached knowledge that every question
              in the project can draw on. A project never widens what you are allowed to see.
            </p>
          </div>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus size={14} /> New project
          </Button>
        </div>
        {error ? (
          <div className="mt-4">
            <Notice tone="danger">{error}</Notice>
          </div>
        ) : null}
        {creating ? (
          <div className="mt-6">
            <CreateProject
              onDone={() => {
                setCreating(false);
                void load();
              }}
              onCancel={() => setCreating(false)}
            />
          </div>
        ) : null}
        <div className="mt-8 space-y-6">
          {!projects.length && !creating ? (
            <Empty title="No projects yet">
              Create one to give a line of work its own instructions and knowledge.
            </Empty>
          ) : null}
          {projects.map((p) => (
            <section
              key={p.id}
              className="rounded-[var(--radius-lg)] border border-line bg-surface p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="font-serif text-[20px] text-ink">{p.name}</h2>
                  {p.description ? (
                    <p className="mt-0.5 text-[14px] text-ink-2">{p.description}</p>
                  ) : null}
                  <div className="mt-2 flex gap-1.5">
                    <Pill>{p.privacyClass.toLowerCase()}</Pill>
                    {p.instructions ? <Pill tone="accent">has instructions</Pill> : null}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Link
                    href={`/knowledge`}
                    className="inline-flex h-8 items-center rounded-[var(--radius-sm)] border border-line px-2.5 text-[13px] text-ink-2 hover:bg-surface-2"
                  >
                    Knowledge
                  </Link>
                  <Button size="sm" variant="primary" onClick={() => void askIn(p)}>
                    Ask in project
                  </Button>
                </div>
              </div>
              {p.instructions ? (
                <p className="mt-3 line-clamp-3 whitespace-pre-wrap rounded-[var(--radius-md)] bg-canvas px-3 py-2 font-serif text-[14px] text-ink-2">
                  {p.instructions}
                </p>
              ) : null}
              {conversations[p.id]?.length ? (
                <ul className="mt-3 divide-y divide-line">
                  {conversations[p.id]!.map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/ask/${c.id}`}
                        className="flex items-center justify-between py-2 text-[14px] hover:text-accent"
                      >
                        <span className="truncate">{c.title ?? "Untitled"}</span>
                        <span className="text-[12px] text-ink-3">
                          {formatRelative(c.lastMessageAt ?? c.createdAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
        </div>
      </div>
    </AppShell>
  );
}

function CreateProject({ onDone, onCancel }: { onDone(): void; onCancel(): void }) {
  const { workspace: ws } = useSession();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ws) return;
    setBusy(true);
    try {
      await api(`/v1/workspaces/${ws.id}/projects`, {
        method: "POST",
        json: {
          name,
          description: description || undefined,
          instructions: instructions || undefined,
        },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the project.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-[var(--radius-lg)] border border-line bg-canvas p-5"
    >
      <h2 className="font-serif text-[18px] text-ink">New project</h2>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} required />
      </Field>
      <Field label="Description">
        <Input value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="Instructions" hint="Prepended to every question asked inside the project.">
        <Textarea rows={4} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          Create project
        </Button>
      </div>
    </form>
  );
}
