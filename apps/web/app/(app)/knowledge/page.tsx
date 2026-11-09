"use client";

import type {
  KnowledgeObject,
  PrivacyClass,
  Project,
  ProvenanceRecord,
  SearchHit,
} from "@ae/domain";
import { Plus, Search, Trash2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AppShell } from "@/components/shell";
import {
  Button,
  cx,
  Empty,
  Field,
  formatRelative,
  Input,
  Notice,
  Pill,
  Spinner,
  Textarea,
} from "@/components/ui";
import { api, API_URL, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";

const KINDS = ["All", "DOCUMENT", "NOTE", "SAVED_ANSWER", "RESEARCH", "SOURCE", "MEMORY"] as const;
const PRIVACY: PrivacyClass[] = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"];

export default function KnowledgePage() {
  const { workspace: ws } = useSession();
  const [items, setItems] = useState<KnowledgeObject[]>([]);
  const [kind, setKind] = useState<(typeof KINDS)[number]>("All");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<KnowledgeObject | null>(null);
  const [creating, setCreating] = useState<"note" | "upload" | null>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);

  const load = useCallback(async () => {
    if (!ws) return;
    setLoading(true);
    try {
      const q = new URLSearchParams();
      if (kind !== "All") q.set("kind", kind);
      if (search) q.set("search", search);
      const res = await api<{ items: KnowledgeObject[] }>(`/v1/workspaces/${ws.id}/knowledge?${q}`);
      setItems(res.items);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load knowledge.");
    } finally {
      setLoading(false);
    }
  }, [ws, kind, search]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (ws)
      void api<{ items: Project[] }>(`/v1/workspaces/${ws.id}/projects`)
        .then((r) => setProjects(r.items))
        .catch(() => undefined);
  }, [ws]);

  // Poll while anything is still being indexed.
  useEffect(() => {
    if (!items.some((i) => ["PENDING", "SCANNING", "EXTRACTING", "INDEXING"].includes(i.status)))
      return;
    const t = setTimeout(() => void load(), 1500);
    return () => clearTimeout(t);
  }, [items, load]);

  const semanticSearch = async (e: FormEvent) => {
    e.preventDefault();
    if (!ws || !search.trim()) return;
    const res = await api<{ items: SearchHit[] }>(`/v1/workspaces/${ws.id}/knowledge/search`, {
      method: "POST",
      json: { query: search, limit: 10 },
    });
    setHits(res.items);
  };

  const panel = selected ? (
    <KnowledgeDetail object={selected} onChanged={load} onClose={() => setSelected(null)} />
  ) : null;

  return (
    <AppShell panel={panel ?? undefined} panelTitle="Knowledge item">
      <div className="mx-auto w-full max-w-[900px] px-5 py-8 sm:px-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-serif text-[28px] font-semibold tracking-tight text-ink">
              Knowledge
            </h1>
            <p className="mt-1 text-[14px] text-ink-2">
              Your governed library. Everything here carries an owner, a privacy class, provenance
              and an explicit permission for model use.
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setCreating("upload")}>
              <Upload size={14} /> Upload
            </Button>
            <Button variant="primary" onClick={() => setCreating("note")}>
              <Plus size={14} /> New note
            </Button>
          </div>
        </div>

        <form onSubmit={semanticSearch} className="mt-6 flex items-center gap-2">
          <div className="relative flex-1">
            <Search
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setHits(null);
              }}
              placeholder="Filter by title or tag, or press Enter to search inside your knowledge"
              className="pl-9"
              aria-label="Search knowledge"
            />
          </div>
          <div className="flex gap-1 overflow-x-auto">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={cx(
                  "whitespace-nowrap rounded-full px-2.5 py-1 text-[12.5px]",
                  kind === k
                    ? "bg-accent-soft text-accent-2"
                    : "text-ink-3 hover:bg-surface-2 hover:text-ink-2",
                )}
              >
                {k === "All" ? "All" : k.toLowerCase().replace("_", " ")}
              </button>
            ))}
          </div>
        </form>

        {creating ? (
          <div className="mt-6">
            <CreateKnowledge
              mode={creating}
              projects={projects}
              maxPrivacy={ws?.settings.maxPrivacyClass ?? "CONFIDENTIAL"}
              onDone={() => {
                setCreating(null);
                void load();
              }}
              onCancel={() => setCreating(null)}
            />
          </div>
        ) : null}

        {hits ? (
          <section className="mt-6">
            <h2 className="mb-2 text-[13px] font-medium text-ink-3">
              {hits.length} passage{hits.length === 1 ? "" : "s"} match “{search}”
            </h2>
            {hits.length ? (
              <ul className="space-y-2">
                {hits.map((h) => (
                  <li
                    key={h.chunkId}
                    className="rounded-[var(--radius-md)] border border-line bg-surface p-3"
                  >
                    <div className="flex items-center justify-between gap-2 text-[12.5px] text-ink-3">
                      <span className="font-medium text-ink">{h.title}</span>
                      <span>
                        {h.lexicalRank != null ? `lexical #${h.lexicalRank}` : ""}
                        {h.lexicalRank != null && h.vectorRank != null ? " · " : ""}
                        {h.vectorRank != null ? `vector #${h.vectorRank}` : ""}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-3 font-serif text-[14px] text-ink-2">
                      {h.content}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="Nothing matched">
                Only items that are indexed, allowed for model use and within your privacy ceiling
                are searched.
              </Empty>
            )}
          </section>
        ) : null}

        <section className="mt-8">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {loading && !items.length ? <Spinner label="Loading" /> : null}
          {!loading && !items.length ? (
            <Empty title="Your library is empty">
              Add a note or upload a text document. Once indexed, it becomes a source the platform
              can cite.
            </Empty>
          ) : null}
          <ul className="divide-y divide-line">
            {items.map((k) => (
              <li key={k.id}>
                <button
                  onClick={() => setSelected(k)}
                  className={cx(
                    "flex w-full items-start justify-between gap-4 py-3 text-left hover:bg-canvas/70",
                    selected?.id === k.id && "bg-canvas",
                  )}
                >
                  <div className="min-w-0">
                    <p className="truncate font-serif text-[16px] text-ink">{k.title}</p>
                    <p className="mt-0.5 text-[12.5px] text-ink-3">
                      {k.kind.toLowerCase().replace("_", " ")} · {k.chunkCount} chunk
                      {k.chunkCount === 1 ? "" : "s"} · {formatRelative(k.createdAt)}
                      {k.statusDetail && k.status === "FAILED" ? ` · ${k.statusDetail}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    <StatusPill status={k.status} />
                    <Pill>{k.privacyClass.toLowerCase()}</Pill>
                    {k.aiUsePermission === "DENY" ? <Pill tone="caution">not for AI</Pill> : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </AppShell>
  );
}

function StatusPill({ status }: { status: KnowledgeObject["status"] }) {
  if (status === "READY") return <Pill tone="accent">ready</Pill>;
  if (status === "FAILED") return <Pill tone="danger">failed</Pill>;
  if (status === "ARCHIVED") return <Pill>archived</Pill>;
  return <Pill tone="neutral">{status.toLowerCase()}…</Pill>;
}

function CreateKnowledge({
  mode,
  projects,
  maxPrivacy,
  onDone,
  onCancel,
}: {
  mode: "note" | "upload";
  projects: Project[];
  maxPrivacy: PrivacyClass;
  onDone(): void;
  onCancel(): void;
}) {
  const { workspace: ws } = useSession();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [privacy, setPrivacy] = useState<PrivacyClass>(
    ws?.settings.defaultPrivacyClass ?? "INTERNAL",
  );
  const [aiUse, setAiUse] = useState<"ALLOW" | "DENY">("ALLOW");
  const [projectId, setProjectId] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const allowed = PRIVACY.slice(0, PRIVACY.indexOf(maxPrivacy) + 1);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ws) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "note") {
        await api(`/v1/workspaces/${ws.id}/knowledge/notes`, {
          method: "POST",
          json: {
            title,
            content,
            privacyClass: privacy,
            aiUsePermission: aiUse,
            projectId: projectId || undefined,
          },
        });
      } else {
        if (!file) throw new Error("Choose a file first.");
        const fd = new FormData();
        fd.append("title", title || file.name);
        fd.append("privacyClass", privacy);
        fd.append("aiUsePermission", aiUse);
        if (projectId) fd.append("projectId", projectId);
        fd.append("file", file);
        const res = await fetch(`${API_URL}/v1/workspaces/${ws.id}/knowledge/upload`, {
          method: "POST",
          credentials: "include",
          body: fd,
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new ApiError(
            res.status,
            j?.error?.code ?? "UPLOAD_FAILED",
            j?.error?.message ?? "Upload failed.",
          );
        }
        const j = await res.json();
        if (j.supported === false) setError(j.note);
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-[var(--radius-lg)] border border-line bg-canvas p-5"
    >
      <h2 className="font-serif text-[18px] text-ink">
        {mode === "note" ? "New note" : "Upload a document"}
      </h2>
      {error ? <Notice tone="caution">{error}</Notice> : null}
      <Field label="Title">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required={mode === "note"}
          placeholder={mode === "upload" ? "Defaults to the file name" : ""}
        />
      </Field>
      {mode === "note" ? (
        <Field label="Content" hint="Markdown is fine. Headings become locators for citations.">
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={8}
            required
          />
        </Field>
      ) : (
        <Field
          label="File"
          hint="Text, Markdown, CSV, HTML and JSON are indexed now. Other formats are stored and marked unsupported until extraction is connected."
        >
          <input
            ref={fileInput}
            type="file"
            accept=".txt,.md,.markdown,.csv,.html,.json,text/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block text-[14px]"
          />
        </Field>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Privacy class">
          <select
            value={privacy}
            onChange={(e) => setPrivacy(e.target.value as PrivacyClass)}
            className="h-10 w-full rounded-[var(--radius-sm)] border border-line bg-surface px-3 text-[14px]"
          >
            {allowed.map((p) => (
              <option key={p} value={p}>
                {p.toLowerCase()}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model use">
          <select
            value={aiUse}
            onChange={(e) => setAiUse(e.target.value as "ALLOW" | "DENY")}
            className="h-10 w-full rounded-[var(--radius-sm)] border border-line bg-surface px-3 text-[14px]"
          >
            <option value="ALLOW">Models may read it</option>
            <option value="DENY">Keep away from models</option>
          </select>
        </Field>
        <Field label="Project">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="h-10 w-full rounded-[var(--radius-sm)] border border-line bg-surface px-3 text-[14px]"
          >
            <option value="">Whole workspace</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Saving" : mode === "note" ? "Save note" : "Upload"}
        </Button>
      </div>
    </form>
  );
}

function KnowledgeDetail({
  object,
  onChanged,
  onClose,
}: {
  object: KnowledgeObject;
  onChanged(): void;
  onClose(): void;
}) {
  const { workspace: ws } = useSession();
  const [prov, setProv] = useState<ProvenanceRecord[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ws) return;
    void api<{ provenance: ProvenanceRecord[] }>(`/v1/workspaces/${ws.id}/knowledge/${object.id}`)
      .then((r) => setProv(r.provenance))
      .catch(() => setProv([]));
  }, [ws, object.id]);

  const update = async (patch: Record<string, unknown>) => {
    if (!ws) return;
    setBusy(true);
    try {
      await api(`/v1/workspaces/${ws.id}/knowledge/${object.id}`, { method: "PATCH", json: patch });
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !ws ||
      !confirm(`Delete “${object.title}”? Its chunks are removed from retrieval immediately.`)
    )
      return;
    await api(`/v1/workspaces/${ws.id}/knowledge/${object.id}`, { method: "DELETE" });
    onClose();
    onChanged();
  };

  return (
    <div className="space-y-5 px-4 py-4 text-[13.5px] text-ink-2">
      <div>
        <p className="font-serif text-[17px] text-ink">{object.title}</p>
        <p className="text-[12.5px] text-ink-3">
          {object.kind.toLowerCase()} · {object.mimeType ?? "text"} · {object.byteSize ?? 0} bytes
        </p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
        <dt className="text-ink-3">Status</dt>
        <dd>
          <StatusPill status={object.status} />
          {object.statusDetail ? (
            <span className="ml-1 text-ink-3">{object.statusDetail}</span>
          ) : null}
        </dd>
        <dt className="text-ink-3">Privacy</dt>
        <dd>
          <select
            value={object.privacyClass}
            disabled={busy}
            onChange={(e) => void update({ privacyClass: e.target.value })}
            className="rounded border border-line bg-surface px-1.5 py-0.5 text-[12.5px]"
            aria-label="Privacy class"
          >
            {PRIVACY.map((p) => (
              <option key={p} value={p}>
                {p.toLowerCase()}
              </option>
            ))}
          </select>
        </dd>
        <dt className="text-ink-3">Model use</dt>
        <dd>
          <select
            value={object.aiUsePermission}
            disabled={busy}
            onChange={(e) => void update({ aiUsePermission: e.target.value })}
            className="rounded border border-line bg-surface px-1.5 py-0.5 text-[12.5px]"
            aria-label="AI use permission"
          >
            <option value="ALLOW">allowed</option>
            <option value="DENY">denied</option>
          </select>
        </dd>
        <dt className="text-ink-3">Chunks</dt>
        <dd>{object.chunkCount}</dd>
        <dt className="text-ink-3">Created</dt>
        <dd>{new Date(object.createdAt).toLocaleString()}</dd>
        <dt className="text-ink-3">Modified</dt>
        <dd>{new Date(object.updatedAt).toLocaleString()}</dd>
        <dt className="text-ink-3">Source</dt>
        <dd className="break-all">{object.sourceUri ?? "created here"}</dd>
        <dt className="text-ink-3">Hash</dt>
        <dd className="break-all font-mono text-[11px]">{object.contentHash?.slice(0, 24)}…</dd>
      </dl>
      <div>
        <p className="mb-1.5 text-[12.5px] font-medium text-ink-2">Provenance</p>
        <ol className="relative ml-2 border-l border-line-2 pl-4">
          {prov.map((p) => (
            <li key={p.id} className="relative pb-2 text-[12.5px] last:pb-0">
              <span
                className="absolute -left-[21px] top-[5px] h-2.5 w-2.5 rounded-full border-2 border-accent bg-canvas"
                aria-hidden
              />
              <span className="text-ink">{p.event.toLowerCase().replace(/_/g, " ")}</span>
              <span className="text-ink-3"> · {formatRelative(p.createdAt)}</span>
            </li>
          ))}
          {!prov.length ? (
            <li className="text-[12.5px] text-ink-3">No provenance recorded yet.</li>
          ) : null}
        </ol>
      </div>
      <Button variant="danger" size="sm" onClick={remove}>
        <Trash2 size={13} /> Delete
      </Button>
    </div>
  );
}
