"use client";

import type { Conversation, KnowledgeObject, Project } from "@ae/domain";
import { BookOpen, FolderKanban, GitCompare, Lightbulb, Microscope } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Composer, type ComposerSelection } from "@/components/composer";
import { AppShell } from "@/components/shell";
import { formatRelative, Notice } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";
import { PENDING_KEY, useModels } from "@/lib/use-ask";

const ENTRY_POINTS = [
  { icon: Microscope, label: "Research something deeply", href: "/research" },
  { icon: BookOpen, label: "Analyze a document", href: "/knowledge" },
  { icon: GitCompare, label: "Compare models", href: "/?compare=1" },
  { icon: Lightbulb, label: "Ask my knowledge", href: "/knowledge" },
  { icon: FolderKanban, label: "Start a project", href: "/projects" },
];

export default function HomePage() {
  const session = useSession();
  const router = useRouter();
  const ws = session.workspace;
  const { models } = useModels(ws?.id ?? null);
  const [selection, setSelection] = useState<ComposerSelection>({
    mode: "AUTO",
    modelVersionId: null,
    useKnowledge: true,
  });
  const [recent, setRecent] = useState<Conversation[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeObject[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!ws) return;
    void Promise.all([
      api<{ items: Conversation[] }>(`/v1/workspaces/${ws.id}/conversations?limit=6`).then((r) =>
        setRecent(r.items),
      ),
      api<{ items: Project[] }>(`/v1/workspaces/${ws.id}/projects`).then((r) =>
        setProjects(r.items.slice(0, 4)),
      ),
      api<{ items: KnowledgeObject[] }>(`/v1/workspaces/${ws.id}/knowledge?limit=4`).then((r) =>
        setKnowledge(r.items),
      ),
    ]).catch(() => undefined);
  }, [ws]);

  const start = async (text: string) => {
    if (!ws) return;
    setBusy(true);
    setError(null);
    try {
      const conv = await api<Conversation>(`/v1/workspaces/${ws.id}/conversations`, {
        method: "POST",
        json: {
          modelMode: selection.mode,
          pinnedModelVersionId: selection.modelVersionId ?? undefined,
        },
      });
      try {
        sessionStorage.setItem(PENDING_KEY(conv.id), JSON.stringify({ content: text, selection }));
      } catch {
        /* storage unavailable: the ask page will show an empty conversation */
      }
      router.push(`/ask/${conv.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the conversation.");
      setBusy(false);
    }
  };

  return (
    <AppShell>
      <div className="mx-auto flex w-full max-w-[760px] flex-1 flex-col px-5 pb-16 pt-[12vh] sm:px-8">
        <h1 className="font-serif text-[34px] font-semibold leading-[1.15] tracking-tight text-ink sm:text-[40px]">
          What do you want to know?
        </h1>
        <p className="mt-2 max-w-[56ch] text-[15px] text-ink-2">
          Ask anything. The platform picks the strongest approved intelligence for the question,
          uses your workspace knowledge where it helps, and shows you what supports the answer.
        </p>
        <div className="mt-7">
          {error ? (
            <div className="mb-3">
              <Notice tone="danger">{error}</Notice>
            </div>
          ) : null}
          <Composer
            models={models}
            selection={selection}
            onSelectionChange={setSelection}
            onSubmit={start}
            busy={busy}
            large
            autoFocus
          />
        </div>
        <ul className="mt-5 flex flex-wrap gap-2">
          {ENTRY_POINTS.map((e) => (
            <li key={e.label}>
              <Link
                href={e.href}
                className="inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[13px] text-ink-2 transition-colors hover:border-line-2 hover:bg-surface-2 hover:text-ink"
              >
                <e.icon size={14} strokeWidth={1.75} aria-hidden /> {e.label}
              </Link>
            </li>
          ))}
        </ul>

        {recent.length || projects.length || knowledge.length ? (
          <div className="mt-14 grid gap-10 sm:grid-cols-2">
            {recent.length ? (
              <section>
                <h2 className="mb-3 text-[13px] font-medium text-ink-3">Continue</h2>
                <ul className="divide-y divide-line">
                  {recent.map((c) => (
                    <li key={c.id}>
                      <Link href={`/ask/${c.id}`} className="block py-2.5 hover:text-accent">
                        <span className="block truncate font-serif text-[15.5px] text-ink">
                          {c.title ?? "Untitled conversation"}
                        </span>
                        <span className="block text-[12.5px] text-ink-3">
                          {c.messageCount} messages ·{" "}
                          {formatRelative(c.lastMessageAt ?? c.createdAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <div className="space-y-10">
              {projects.length ? (
                <section>
                  <h2 className="mb-3 text-[13px] font-medium text-ink-3">Recent projects</h2>
                  <ul className="divide-y divide-line">
                    {projects.map((p) => (
                      <li key={p.id} className="py-2.5">
                        <Link
                          href="/projects"
                          className="font-serif text-[15.5px] text-ink hover:text-accent"
                        >
                          {p.name}
                        </Link>
                        {p.description ? (
                          <p className="truncate text-[12.5px] text-ink-3">{p.description}</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {knowledge.length ? (
                <section>
                  <h2 className="mb-3 text-[13px] font-medium text-ink-3">
                    Recently added knowledge
                  </h2>
                  <ul className="divide-y divide-line">
                    {knowledge.map((k) => (
                      <li key={k.id} className="py-2.5">
                        <Link
                          href="/knowledge"
                          className="font-serif text-[15.5px] text-ink hover:text-accent"
                        >
                          {k.title}
                        </Link>
                        <p className="text-[12.5px] text-ink-3">
                          {k.kind.toLowerCase()} · {k.status.toLowerCase()} ·{" "}
                          {k.privacyClass.toLowerCase()}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </AppShell>
  );
}
