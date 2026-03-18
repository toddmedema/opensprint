import type { ProjectPhase } from "@opensprint/shared";
import { PhaseLoadingSpinner } from "./PhaseLoadingSpinner";

/** Phase-appropriate loading fallback for Suspense when lazy-loading phase content.
 * Sketch, Execute, and Evaluate show animated logo only (no skeleton blocks). */
export function PhaseLoadingFallback({ phase }: { phase: ProjectPhase }) {
  switch (phase) {
    case "sketch":
      return <SketchPhaseAnimatedLogo />;
    case "plan":
      return <PlanPhaseSkeleton />;
    case "execute":
      return <ExecutePhaseAnimatedLogo />;
    case "eval":
      return <EvalPhaseAnimatedLogo />;
    case "deliver":
      return <DeliverPhaseSkeleton />;
    default:
      return <GenericPhaseSpinner />;
  }
}

/** Centered pulsing logo and status for initial/sketch loading. No bordered container or product name. */
export function SketchLogoLoading({
  containerTestId = "phase-sketch-loading",
  spinnerTestId = "phase-sketch-loading-spinner",
  status = "Loading…",
}: {
  containerTestId?: string;
  spinnerTestId?: string;
  status?: string;
} = {}) {
  return (
    <div className="flex flex-1 min-h-0 items-center justify-center" data-testid={containerTestId}>
      <div
        className="flex flex-col items-center justify-center gap-3"
        data-testid={spinnerTestId}
        role="status"
        aria-label="Loading"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 80 80"
          className="w-10 h-10"
          aria-hidden
        >
          <polygon
            points="4,10 36,40 4,70"
            fill="#c7d2fe"
            className="animate-logo-pulse [animation-delay:0ms]"
          />
          <polygon
            points="22,10 54,40 22,70"
            fill="#818cf8"
            className="animate-logo-pulse [animation-delay:200ms]"
          />
          <polygon
            points="40,10 72,40 40,70"
            fill="#4f46e5"
            className="animate-logo-pulse [animation-delay:400ms]"
          />
        </svg>
        {status ? (
          <p className="text-sm text-theme-muted" data-testid={`${spinnerTestId}-status`}>
            {status}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function SketchPhaseAnimatedLogo() {
  return <SketchLogoLoading />;
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

function ExecutePhaseAnimatedLogo() {
  return (
    <div
      className="flex flex-1 min-h-0 items-center justify-center"
      data-testid="phase-execute-loading"
    >
      <PhaseLoadingSpinner
        data-testid="phase-execute-loading-spinner"
        aria-label="Loading tasks"
        status="Loading tasks…"
      />
    </div>
  );
}

function EvalPhaseAnimatedLogo() {
  return (
    <div
      className="flex flex-1 min-h-0 items-center justify-center"
      data-testid="phase-eval-loading"
    >
      <PhaseLoadingSpinner
        data-testid="phase-eval-loading-spinner"
        aria-label="Loading feedback"
        status="Loading feedback…"
      />
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
