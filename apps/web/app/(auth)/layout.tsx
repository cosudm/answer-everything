import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-12">
      <div className="mb-8 flex items-center gap-2">
        <span className="inline-block h-7 w-7 rounded-md bg-accent" aria-hidden />
        <span className="font-serif text-[20px] font-semibold tracking-tight text-ink">
          Answer Everything
        </span>
      </div>
      <div className="w-full max-w-[400px] rounded-[var(--radius-lg)] border border-line bg-surface p-7 shadow-[var(--shadow-soft)]">
        {children}
      </div>
      <p className="mt-6 max-w-[400px] text-center text-[13px] leading-5 text-ink-3">
        Ask anything. Get the strongest available answer, and see what supports it.
      </p>
    </div>
  );
}
