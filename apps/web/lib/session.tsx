"use client";

import type { ActingIdentity, User, Workspace, WorkspaceRole } from "@ae/domain";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError } from "./api";

export type WorkspaceWithRole = Workspace & { role: WorkspaceRole };

interface SessionState {
  status: "loading" | "anonymous" | "authenticated";
  user: User | null;
  identity: ActingIdentity | null;
  workspaces: WorkspaceWithRole[];
  workspace: WorkspaceWithRole | null;
  selectWorkspace(id: string): void;
  refresh(): Promise<void>;
  signOut(): Promise<void>;
}

const SessionContext = createContext<SessionState | null>(null);
const WS_KEY = "ae.workspace";

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionState["status"]>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [identity, setIdentity] = useState<ActingIdentity | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceWithRole[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{
        user: User;
        actingIdentity: ActingIdentity;
        workspaces: WorkspaceWithRole[];
      }>("/v1/auth/me");
      setUser(me.user);
      setIdentity(me.actingIdentity);
      setWorkspaces(me.workspaces);
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(WS_KEY);
      } catch {
        /* storage unavailable */
      }
      const pick = me.workspaces.find((w) => w.id === stored) ?? me.workspaces[0] ?? null;
      setWorkspaceId(pick?.id ?? null);
      setStatus("authenticated");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
        setStatus("anonymous");
      } else {
        setStatus("anonymous");
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectWorkspace = useCallback((id: string) => {
    setWorkspaceId(id);
    try {
      localStorage.setItem(WS_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);

  const signOut = useCallback(async () => {
    await api("/v1/auth/logout", { method: "POST" }).catch(() => undefined);
    setUser(null);
    setWorkspaces([]);
    setStatus("anonymous");
  }, []);

  const value = useMemo<SessionState>(
    () => ({
      status,
      user,
      identity,
      workspaces,
      workspace: workspaces.find((w) => w.id === workspaceId) ?? null,
      selectWorkspace,
      refresh,
      signOut,
    }),
    [status, user, identity, workspaces, workspaceId, selectWorkspace, refresh, signOut],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used inside SessionProvider");
  return ctx;
}

/** Redirects anonymous visitors to the sign-in page; renders nothing while loading. */
export function useRequireSession(): SessionState {
  const s = useSession();
  const router = useRouter();
  useEffect(() => {
    if (s.status === "anonymous") router.replace("/login");
  }, [s.status, router]);
  return s;
}
