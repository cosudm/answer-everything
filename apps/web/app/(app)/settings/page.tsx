"use client";

import type { PrivacyClass, Workspace, WorkspaceSettings } from "@ae/domain";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/shell";
import { Button, Field, formatUsd, Input, Notice } from "@/components/ui";
import { api, API_URL, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";

type Spend = {
  monthToDateUsd: number;
  limitUsd: number;
  remainingUsd: number;
  inputTokens: number;
  outputTokens: number;
  runs: number;
};
type AuditItem = {
  id: string;
  eventType: string;
  outcome: string;
  createdAt: string;
  resourceKind: string | null;
  details: Record<string, unknown>;
};

export default function SettingsPage() {
  const session = useSession();
  const ws = session.workspace;
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [spend, setSpend] = useState<Spend | null>(null);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    tone: "accent" | "danger" | "caution";
    text: string;
  } | null>(null);
  const [confirmEmail, setConfirmEmail] = useState("");

  useEffect(() => {
    if (!ws) return;
    setSettings(ws.settings);
    void api<Workspace & { spend: Spend }>(`/v1/workspaces/${ws.id}`).then((w) => {
      setSettings(w.settings);
      setSpend(w.spend);
    });
    void api<{ items: AuditItem[] }>(`/v1/workspaces/${ws.id}/audit?limit=30`)
      .then((r) => setAudit(r.items))
      .catch(() => setAudit([]));
  }, [ws]);

  const save = async () => {
    if (!ws || !settings) return;
    setSaving(true);
    setMessage(null);
    try {
      const updated = await api<Workspace>(`/v1/workspaces/${ws.id}/settings`, {
        method: "PATCH",
        json: settings,
      });
      setSettings(updated.settings);
      await session.refresh();
      setMessage({ tone: "accent", text: "Settings saved." });
    } catch (err) {
      setMessage({
        tone: "danger",
        text: err instanceof ApiError ? err.message : "Could not save settings.",
      });
    } finally {
      setSaving(false);
    }
  };

  const exportData = async () => {
    const res = await fetch(`${API_URL}/v1/account/export`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      setMessage({ tone: "danger", text: "Export failed." });
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "answer-everything-export.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const deleteAccount = async () => {
    if (!session.user) return;
    try {
      await api("/v1/account/delete", { method: "POST", json: { confirmEmail } });
      await session.signOut();
    } catch (err) {
      setMessage({
        tone: "danger",
        text: err instanceof ApiError ? err.message : "Deletion request failed.",
      });
    }
  };

  const canAdmin = ws?.role === "OWNER" || ws?.role === "ADMIN";

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[760px] px-5 py-8 sm:px-8">
        <h1 className="font-serif text-[28px] font-semibold tracking-tight text-ink">Controls</h1>
        <p className="mt-1 text-[14px] text-ink-2">
          Privacy, model routing, budget, data retention, export and deletion for {ws?.name}.
        </p>
        {message ? (
          <div className="mt-4">
            <Notice tone={message.tone}>{message.text}</Notice>
          </div>
        ) : null}

        {settings ? (
          <section className="mt-8 space-y-5">
            <h2 className="font-serif text-[19px] text-ink">Workspace policy</h2>
            {!canAdmin ? (
              <Notice>Only workspace owners and admins can change these settings.</Notice>
            ) : null}
            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Default privacy class"
                hint="Applied to new conversations and knowledge."
              >
                <Select
                  value={settings.defaultPrivacyClass}
                  disabled={!canAdmin}
                  onChange={(v) =>
                    setSettings({ ...settings, defaultPrivacyClass: v as PrivacyClass })
                  }
                  options={["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]}
                />
              </Field>
              <Field
                label="Highest privacy class allowed"
                hint="Nothing in this workspace may be classified above it."
              >
                <Select
                  value={settings.maxPrivacyClass}
                  disabled={!canAdmin}
                  onChange={(v) => setSettings({ ...settings, maxPrivacyClass: v as PrivacyClass })}
                  options={["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]}
                />
              </Field>
              <Field label="Monthly model budget (USD)" hint="Runs stop before this is exceeded.">
                <Input
                  type="number"
                  min={0}
                  step={1}
                  disabled={!canAdmin}
                  value={settings.monthlyBudgetUsd}
                  onChange={(e) =>
                    setSettings({ ...settings, monthlyBudgetUsd: Number(e.target.value) })
                  }
                />
              </Field>
              <Field
                label="Conversation retention (days)"
                hint="Blank keeps conversations until deleted."
              >
                <Input
                  type="number"
                  min={1}
                  disabled={!canAdmin}
                  value={settings.conversationRetentionDays ?? ""}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      conversationRetentionDays: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                />
              </Field>
            </div>
            <div className="space-y-2.5">
              <Toggle
                label="Allow commercial API providers"
                hint="Off restricts answers to private, open-weight and local deployments."
                checked={settings.allowCommercialProviders}
                disabled={!canAdmin}
                onChange={(v) => setSettings({ ...settings, allowCommercialProviders: v })}
              />
              <Toggle
                label="Allow experimental and testing-stage models"
                hint="Models that have not passed evaluation. They appear as Experimental in the picker."
                checked={settings.allowExperimentalModels}
                disabled={!canAdmin}
                onChange={(v) => setSettings({ ...settings, allowExperimentalModels: v })}
              />
              <Toggle
                label="Web access for research"
                hint="Not connected in this build; the switch is recorded for when it is."
                checked={settings.webAccessEnabled}
                disabled={!canAdmin}
                onChange={(v) => setSettings({ ...settings, webAccessEnabled: v })}
              />
              <Toggle
                label="Confirmed memory"
                hint="Memory stays off until the memory feature ships."
                checked={settings.memoryEnabled}
                disabled={!canAdmin}
                onChange={(v) => setSettings({ ...settings, memoryEnabled: v })}
              />
            </div>
            {canAdmin ? (
              <Button variant="primary" onClick={save} disabled={saving}>
                {saving ? "Saving" : "Save settings"}
              </Button>
            ) : null}
          </section>
        ) : null}

        {spend ? (
          <section className="mt-10">
            <h2 className="font-serif text-[19px] text-ink">Usage this month</h2>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Spent" value={formatUsd(spend.monthToDateUsd)} />
              <Stat label="Remaining" value={formatUsd(spend.remainingUsd)} />
              <Stat label="Model runs" value={String(spend.runs)} />
              <Stat
                label="Tokens"
                value={`${Intl.NumberFormat().format(spend.inputTokens + spend.outputTokens)}`}
              />
            </dl>
          </section>
        ) : null}

        <section className="mt-10">
          <h2 className="font-serif text-[19px] text-ink">Your data</h2>
          <p className="mt-1 text-[14px] text-ink-2">
            Export everything you own as JSON, or request deletion of your account. Deletion revokes
            all sessions immediately and purges data through a background job.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Button onClick={exportData}>Export my data</Button>
            <div className="flex items-end gap-2">
              <Field label="Type your email to confirm deletion">
                <Input
                  value={confirmEmail}
                  onChange={(e) => setConfirmEmail(e.target.value)}
                  placeholder={session.user?.email}
                />
              </Field>
              <Button
                variant="danger"
                disabled={confirmEmail.trim().toLowerCase() !== session.user?.email.toLowerCase()}
                onClick={deleteAccount}
              >
                Delete account
              </Button>
            </div>
          </div>
        </section>

        {canAdmin ? (
          <section className="mt-10">
            <h2 className="font-serif text-[19px] text-ink">Recent audit events</h2>
            <p className="mt-1 text-[13px] text-ink-3">
              Immutable. Denied attempts appear here too.
            </p>
            <ul className="mt-3 divide-y divide-line text-[13px]">
              {audit.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 py-1.5">
                  <span className="truncate text-ink">{a.eventType}</span>
                  <span className="shrink-0 text-ink-3">
                    {a.outcome.toLowerCase()} · {new Date(a.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
              {!audit.length ? <li className="py-2 text-ink-3">No events yet.</li> : null}
            </ul>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}

function Select({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange(v: string): void;
  options: string[];
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="h-10 w-full rounded-[var(--radius-sm)] border border-line bg-surface px-3 text-[14px] disabled:opacity-60"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o.toLowerCase()}
        </option>
      ))}
    </select>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange(v: boolean): void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-start gap-3 rounded-[var(--radius-md)] border border-line bg-surface px-3.5 py-3">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
      />
      <span>
        <span className="block text-[14px] text-ink">{label}</span>
        <span className="block text-[12.5px] text-ink-3">{hint}</span>
      </span>
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-line bg-surface px-3 py-2.5">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="font-serif text-[20px] text-ink">{value}</dd>
    </div>
  );
}
