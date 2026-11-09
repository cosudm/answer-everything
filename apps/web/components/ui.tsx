"use client";

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
export { cx };

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

export function Button({ variant = "secondary", size = "md", className, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-sm)] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9 px-3.5 text-[14px]",
        variant === "primary" && "bg-accent text-white hover:bg-accent-2",
        variant === "secondary" &&
          "border border-line bg-surface text-ink hover:border-line-2 hover:bg-surface-2",
        variant === "ghost" && "text-ink-2 hover:bg-surface-2 hover:text-ink",
        variant === "danger" && "border border-line bg-surface text-danger hover:bg-danger-soft",
        className,
      )}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        "h-10 w-full rounded-[var(--radius-sm)] border border-line bg-surface px-3 text-[15px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none",
        className,
      )}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={cx(
        "w-full rounded-[var(--radius-sm)] border border-line bg-surface px-3 py-2 text-[15px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none",
        className,
      )}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[12.5px] text-ink-3">{hint}</span> : null}
    </label>
  );
}

export function Pill({
  tone = "neutral",
  children,
  title,
}: {
  tone?: "neutral" | "accent" | "caution" | "danger";
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[11.5px] font-medium leading-4",
        tone === "neutral" && "border-line bg-surface-2 text-ink-2",
        tone === "accent" && "border-transparent bg-accent-soft text-accent-2",
        tone === "caution" && "border-transparent bg-caution-soft text-caution",
        tone === "danger" && "border-transparent bg-danger-soft text-danger",
      )}
    >
      {children}
    </span>
  );
}

export function Notice({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "caution" | "danger" | "accent";
  children: ReactNode;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cx(
        "rounded-[var(--radius-md)] border px-3.5 py-2.5 text-[14px] leading-5",
        tone === "neutral" && "border-line bg-surface-2 text-ink-2",
        tone === "accent" && "border-transparent bg-accent-soft text-accent-2",
        tone === "caution" && "border-transparent bg-caution-soft text-caution",
        tone === "danger" && "border-transparent bg-danger-soft text-danger",
      )}
    >
      {children}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-dashed border-line-2 px-6 py-10 text-center">
      <p className="font-serif text-[18px] text-ink">{title}</p>
      {children ? <div className="mt-2 text-[14px] text-ink-2">{children}</div> : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-ink-2" role="status">
      <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-2 border-t-accent" />
      {label}
    </span>
  );
}

export function formatUsd(n: number | null | undefined): string {
  if (n == null) return "unknown";
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatRelative(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}
