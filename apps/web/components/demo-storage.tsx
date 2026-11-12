"use client";

import { useEffect, useState } from "react";
import { API_URL } from "@/lib/api";
import { Notice } from "./ui";

type Health = { storage?: "ephemeral" | "durable" };

let healthRequest: Promise<Health | null> | null = null;

/** One /health read per page load; a failed read is retried by the next caller. */
function readHealth(): Promise<Health | null> {
  healthRequest ??= fetch(`${API_URL}/health`, { credentials: "omit" })
    .then((res) => (res.ok ? (res.json() as Promise<Health>) : null))
    .catch(() => null)
    .then((health) => {
      if (!health) healthRequest = null;
      return health;
    });
  return healthRequest;
}

/** True when the API reports a container-local database that does not survive a restart. */
export function useDemoStorage(): boolean {
  const [ephemeral, setEphemeral] = useState(false);
  useEffect(() => {
    let live = true;
    void readHealth().then((health) => {
      if (live) setEphemeral(health?.storage === "ephemeral");
    });
    return () => {
      live = false;
    };
  }, []);
  return ephemeral;
}

/**
 * Says plainly that this environment forgets. Rendered only when the API
 * reports ephemeral storage, so durable environments never see it.
 */
export function DemoStorageNotice({ compact = false }: { compact?: boolean }) {
  const ephemeral = useDemoStorage();
  if (!ephemeral) return null;
  if (compact) {
    return (
      <p
        role="status"
        className="rounded-[var(--radius-sm)] bg-caution-soft px-2.5 py-2 text-[12.5px] leading-[1.35] text-caution"
      >
        Demo storage. Accounts and data are erased when this environment restarts.
      </p>
    );
  }
  return (
    <Notice tone="caution">
      This is a demo environment. Accounts and everything you add are erased when it restarts, which
      also happens after about 30 minutes without use.
    </Notice>
  );
}
