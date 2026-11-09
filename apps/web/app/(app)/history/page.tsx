"use client";

import type { Conversation } from "@ae/domain";
import { Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/shell";
import { Button, Empty, formatRelative, Pill } from "@/components/ui";
import { api } from "@/lib/api";
import { useSession } from "@/lib/session";

export default function HistoryPage() {
  const { workspace: ws } = useSession();
  const [items, setItems] = useState<Conversation[]>([]);
  const load = useCallback(async () => {
    if (!ws) return;
    const res = await api<{ items: Conversation[] }>(
      `/v1/workspaces/${ws.id}/conversations?limit=100`,
    );
    setItems(res.items);
  }, [ws]);
  useEffect(() => {
    void load();
  }, [load]);
  const remove = async (c: Conversation) => {
    if (!ws || !confirm("Delete this conversation?")) return;
    await api(`/v1/workspaces/${ws.id}/conversations/${c.id}`, { method: "DELETE" });
    void load();
  };
  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[760px] px-5 py-8 sm:px-8">
        <h1 className="font-serif text-[28px] font-semibold tracking-tight text-ink">History</h1>
        <p className="mt-1 text-[14px] text-ink-2">
          Every conversation in this workspace, newest first.
        </p>
        <ul className="mt-6 divide-y divide-line">
          {items.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-3">
              <Link href={`/ask/${c.id}`} className="min-w-0 flex-1 hover:text-accent">
                <span className="block truncate font-serif text-[16px] text-ink">
                  {c.title ?? "Untitled conversation"}
                </span>
                <span className="block text-[12.5px] text-ink-3">
                  {c.messageCount} messages · {c.modelMode.toLowerCase()} ·{" "}
                  {formatRelative(c.lastMessageAt ?? c.createdAt)}
                </span>
              </Link>
              <Pill>{c.privacyClass.toLowerCase()}</Pill>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void remove(c)}
                aria-label="Delete conversation"
              >
                <Trash2 size={14} />
              </Button>
            </li>
          ))}
        </ul>
        {!items.length ? (
          <Empty title="No conversations yet">Ask something and it will appear here.</Empty>
        ) : null}
      </div>
    </AppShell>
  );
}
