"use client";

import {
  BookOpen,
  Boxes,
  ChevronDown,
  FolderKanban,
  History,
  MessageSquareText,
  Microscope,
  PanelRight,
  Settings,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useRequireSession } from "@/lib/session";
import { DemoStorageNotice } from "./demo-storage";
import { Button, cx, Spinner } from "./ui";

const NAV = [
  { href: "/", label: "Ask", icon: MessageSquareText },
  { href: "/research", label: "Research", icon: Microscope },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/models", label: "Models", icon: Boxes },
  { href: "/history", label: "History", icon: History },
];

/**
 * Three-region workspace: quiet navigation on the left, the intelligence
 * workspace in the center, and an optional context panel on the right. On
 * narrow screens the navigation becomes a top bar and the context panel a
 * full-height sheet.
 */
export function AppShell({
  children,
  panel,
  panelTitle = "Context",
}: {
  children: ReactNode;
  panel?: ReactNode;
  panelTitle?: string;
}) {
  const session = useRequireSession();
  const pathname = usePathname();
  const [navOpen, setNavOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    setNavOpen(false);
    setPanelOpen(false);
  }, [pathname]);

  if (session.status !== "authenticated" || !session.workspace) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner label="Loading your workspace" />
      </div>
    );
  }

  const nav = (
    <nav className="flex h-full flex-col px-3 py-4">
      <Link href="/" className="mb-6 flex items-center gap-2 px-2">
        <span className="inline-block h-6 w-6 rounded-md bg-accent" aria-hidden />
        <span className="font-serif text-[17px] font-semibold tracking-tight text-ink">
          Answer Everything
        </span>
      </Link>
      <ul className="space-y-0.5">
        {NAV.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/" || pathname.startsWith("/ask")
              : pathname.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-[14px] transition-colors",
                  active
                    ? "bg-surface text-ink shadow-[var(--shadow-soft)]"
                    : "text-ink-2 hover:bg-surface hover:text-ink",
                )}
              >
                <item.icon size={16} strokeWidth={1.75} aria-hidden />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto space-y-1 px-1">
        <DemoStorageNotice compact />
        <WorkspaceSwitcher />
        <Link
          href="/settings"
          className={cx(
            "flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-[14px] text-ink-2 hover:bg-surface hover:text-ink",
            pathname.startsWith("/settings") && "bg-surface text-ink",
          )}
        >
          <Settings size={16} strokeWidth={1.75} aria-hidden /> Settings
        </Link>
      </div>
    </nav>
  );

  return (
    <div className="flex h-dvh flex-col lg:flex-row">
      {/* top bar (mobile) */}
      <header className="flex items-center justify-between border-b border-line bg-canvas px-3 py-2 lg:hidden">
        <button
          className="rounded-md px-2 py-1 text-[14px] font-medium text-ink"
          onClick={() => setNavOpen(true)}
          aria-label="Open navigation"
        >
          <span className="mr-2 inline-block h-4 w-4 rounded bg-accent align-[-2px]" aria-hidden />
          Answer Everything
        </button>
        {panel ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPanelOpen(true)}
            aria-label={`Open ${panelTitle}`}
          >
            <PanelRight size={16} /> {panelTitle}
          </Button>
        ) : null}
      </header>

      {/* left nav */}
      <aside className="hidden w-[232px] shrink-0 border-r border-line bg-canvas lg:block">
        {nav}
      </aside>
      {navOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <button
            className="absolute inset-0 bg-ink/20"
            onClick={() => setNavOpen(false)}
            aria-label="Close navigation"
          />
          <div className="absolute inset-y-0 left-0 w-[260px] bg-canvas shadow-xl">
            <button
              className="absolute right-2 top-3 rounded-md p-1 text-ink-2"
              onClick={() => setNavOpen(false)}
              aria-label="Close"
            >
              <X size={18} />
            </button>
            {nav}
          </div>
        </div>
      ) : null}

      {/* center */}
      <main className="relative flex min-w-0 flex-1 flex-col bg-surface lg:rounded-l-[18px] lg:border-l lg:border-line">
        {children}
      </main>

      {/* right panel */}
      {panel ? (
        <>
          <aside className="hidden w-[324px] shrink-0 border-l border-line bg-canvas xl:block">
            <div className="h-full overflow-y-auto scroll-quiet">{panel}</div>
          </aside>
          {panelOpen ? (
            <div className="fixed inset-0 z-40 xl:hidden" role="dialog" aria-modal="true">
              <button
                className="absolute inset-0 bg-ink/20"
                onClick={() => setPanelOpen(false)}
                aria-label="Close panel"
              />
              <div className="absolute inset-y-0 right-0 w-full max-w-[380px] overflow-y-auto bg-canvas shadow-xl">
                <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
                  <span className="text-[13px] font-medium text-ink-2">{panelTitle}</span>
                  <button
                    className="rounded-md p-1 text-ink-2"
                    onClick={() => setPanelOpen(false)}
                    aria-label="Close"
                  >
                    <X size={18} />
                  </button>
                </div>
                {panel}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function WorkspaceSwitcher() {
  const s = useRequireSession();
  const [open, setOpen] = useState(false);
  if (!s.workspace) return null;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-[13.5px] text-ink-2 hover:bg-surface"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate">
          <span className="block truncate font-medium text-ink">{s.workspace.name}</span>
          <span className="block truncate text-[12px] text-ink-3">{s.user?.email}</span>
        </span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open ? (
        <ul
          role="listbox"
          className="absolute bottom-full left-0 z-10 mb-1 w-full rounded-[var(--radius-md)] border border-line bg-surface p-1 shadow-[var(--shadow-soft)]"
        >
          {s.workspaces.map((w) => (
            <li key={w.id}>
              <button
                role="option"
                aria-selected={w.id === s.workspace?.id}
                onClick={() => {
                  s.selectWorkspace(w.id);
                  setOpen(false);
                }}
                className={cx(
                  "w-full rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-[13.5px] hover:bg-surface-2",
                  w.id === s.workspace?.id ? "text-ink" : "text-ink-2",
                )}
              >
                {w.name} <span className="text-ink-3">· {w.role.toLowerCase()}</span>
              </button>
            </li>
          ))}
          <li className="mt-1 border-t border-line pt-1">
            <button
              onClick={() => void s.signOut()}
              className="w-full rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-[13.5px] text-ink-2 hover:bg-surface-2"
            >
              Sign out
            </button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
