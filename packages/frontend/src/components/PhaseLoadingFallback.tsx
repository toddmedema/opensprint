import type { ProjectPhase } from "@opensprint/shared";

/** Phase-appropriate loading fallback for Suspense when lazy-loading phase content. */
export function PhaseLoadingFallback({ phase }: { phase: ProjectPhase }) {
  switch (phase) {
    case "sketch":
      return <SketchPhaseSkeleton />;
    case "plan":
      return <PlanPhaseSkeleton />;
    case "execute":
      return <ExecutePhaseSkeleton />;
    case "eval":
      return <EvalPhaseSkeleton />;
    case "deliver":
      return <DeliverPhaseSkeleton />;
    default:
      return <GenericPhaseSpinner />;
  }
}

function SketchPhaseSkeleton() {
  return (
    <div className="flex flex-1 min-h-0" data-testid="phase-sketch-loading">
      <div className="flex-1 p-6 space-y-4">
        <div className="h-8 w-48 rounded bg-theme-surface-muted animate-pulse" />
        <div className="h-4 w-full rounded bg-theme-surface-muted/70 animate-pulse" />
        <div className="h-4 w-3/4 rounded bg-theme-surface-muted/70 animate-pulse" />
        <div className="h-64 rounded-lg border border-theme-border bg-theme-surface-muted/30 animate-pulse" />
      </div>
    </div>
  );
}

function PlanPhaseSkeleton() {
  return (
    <div className="flex flex-1 min-h-0" data-testid="phase-plan-loading">
      <div className="flex-1 p-6 space-y-4">
        <div className="h-8 w-32 rounded bg-theme-surface-muted animate-pulse" />
        <div className="h-64 rounded-lg border border-theme-border bg-theme-surface-muted/30 animate-pulse" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-40 rounded-xl border border-theme-border bg-theme-surface-muted/30 animate-pulse"
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ExecutePhaseSkeleton() {
  return (
    <div className="flex flex-1 min-h-0" data-testid="phase-execute-loading">
      <div className="flex-1 p-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-xl border border-theme-border bg-theme-surface overflow-hidden"
              style={{ minHeight: 160 }}
            >
              <div className="p-4 border-b border-theme-border-subtle">
                <div className="h-4 w-3/4 rounded bg-theme-surface-muted animate-pulse" />
                <div className="h-2 w-1/2 rounded bg-theme-surface-muted/70 animate-pulse mt-2" />
              </div>
              <ul className="divide-y divide-theme-border-subtle">
                {[1, 2, 3].map((j) => (
                  <li key={j} className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className="h-5 w-16 rounded bg-theme-surface-muted/70 animate-pulse" />
                      <div className="h-4 flex-1 rounded bg-theme-surface-muted animate-pulse" />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EvalPhaseSkeleton() {
  return (
    <div className="flex flex-1 min-h-0" data-testid="phase-eval-loading">
      <div className="flex-1 p-6 space-y-4">
        <div className="h-8 w-40 rounded bg-theme-surface-muted animate-pulse" />
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-24 rounded-lg border border-theme-border bg-theme-surface-muted/30 animate-pulse"
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DeliverPhaseSkeleton() {
  return (
    <div className="flex flex-1 min-h-0" data-testid="phase-deliver-loading">
      <div className="flex-1 p-6 space-y-4">
        <div className="h-8 w-36 rounded bg-theme-surface-muted animate-pulse" />
        <div className="h-32 rounded-lg border border-theme-border bg-theme-surface-muted/30 animate-pulse" />
        <div className="h-48 rounded-lg border border-theme-border bg-theme-surface-muted/30 animate-pulse" />
      </div>
    </div>
  );
}

function GenericPhaseSpinner() {
  return (
    <div
      className="flex flex-1 min-h-0 items-center justify-center text-theme-muted"
      data-testid="phase-loading-spinner"
    >
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-theme-border border-t-theme-text" />
    </div>
  );
}
