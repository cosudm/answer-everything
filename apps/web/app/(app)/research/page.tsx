"use client";

import { AppShell } from "@/components/shell";
import { Notice } from "@/components/ui";

const STEPS = [
  "Question",
  "Research plan",
  "Sources",
  "Evidence",
  "Contradictions",
  "Claims",
  "Verification",
  "Synthesis",
  "Answer",
];

/**
 * Research mode is designed as a visible process. The contracts and task
 * table exist; the worker steps that execute it are on the roadmap, so this
 * screen states that plainly instead of simulating progress.
 */
export default function ResearchPage() {
  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[760px] px-5 py-8 sm:px-8">
        <h1 className="font-serif text-[28px] font-semibold tracking-tight text-ink">Research</h1>
        <p className="mt-1 max-w-[60ch] text-[14px] text-ink-2">
          A deeper workflow that decomposes a question, gathers and reads sources, separates facts
          from inference, surfaces disagreements and synthesizes a sourced answer with the full
          trail visible.
        </p>
        <ol className="mt-8 flex flex-wrap items-center gap-2 text-[13px]">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span className="rounded-full border border-line bg-surface px-3 py-1 text-ink-2">
                {s}
              </span>
              {i < STEPS.length - 1 ? <span className="text-ink-3">→</span> : null}
            </li>
          ))}
        </ol>
        <div className="mt-8">
          <Notice>
            Long-running research is not yet executable in this build. The research task contract,
            planner and storage are in place; step execution by the worker is the next roadmap item.
            Until then, use Ask with Knowledge on and Research mode in the model picker for
            citation-oriented models.
          </Notice>
        </div>
      </div>
    </AppShell>
  );
}
