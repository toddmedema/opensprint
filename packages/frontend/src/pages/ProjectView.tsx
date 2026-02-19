import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, useLocation, Navigate, Link } from "react-router-dom";
import type { ProjectPhase } from "@opensprint/shared";
import {
  phaseFromSlug,
  getProjectPhasePath,
  isValidPhaseSlug,
  parseDetailParams,
  VALID_PHASES,
} from "../lib/phaseRouting";
import { useAppDispatch, useAppSelector } from "../store";
import { fetchProject, resetProject } from "../store/slices/projectSlice";
import {
  resetWebsocket,
  clearHilRequest,
  clearHilNotification,
  clearDeliverToast,
} from "../store/slices/websocketSlice";
import {
  fetchSketchChat,
  fetchPrd,
  fetchPrdHistory,
  resetSketch,
} from "../store/slices/sketchSlice";
import {
  fetchPlans,
  resetPlan,
  setSelectedPlanId,
  clearPlanBackgroundError,
} from "../store/slices/planSlice";
import {
  fetchTasks,
  fetchExecuteStatus,
  resetExecute,
  setSelectedTaskId,
  setAwaitingApproval,
} from "../store/slices/executeSlice";
import { fetchFeedback, resetEval } from "../store/slices/evalSlice";
import {
  fetchDeliverStatus,
  fetchDeliverHistory,
  resetDeliver,
} from "../store/slices/deliverSlice";
import { wsConnect, wsDisconnect, wsSend } from "../store/middleware/websocketMiddleware";
import { Layout } from "../components/layout/Layout";
import { HilApprovalModal } from "../components/HilApprovalModal";
import { SketchPhase } from "./phases/SketchPhase";
import { PlanPhase } from "./phases/PlanPhase";
import { ExecutePhase } from "./phases/ExecutePhase";
import { EvalPhase } from "./phases/EvalPhase";
import { DeliverPhase } from "./phases/DeliverPhase";

const CATEGORY_LABELS: Record<string, string> = {
  scopeChanges: "Scope Changes",
  architectureDecisions: "Architecture Decisions",
  dependencyModifications: "Dependency Modifications",
};

export function ProjectView() {
  const { projectId, phase: phaseSlug } = useParams<{ projectId: string; phase?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useAppDispatch();
  const redirectTo =
    projectId && !isValidPhaseSlug(phaseSlug) ? getProjectPhasePath(projectId, "sketch") : null;

  const currentPhase = phaseFromSlug(phaseSlug);
  const selectedPlanId = useAppSelector((s) => s.plan.selectedPlanId);

  /* Sketch phase always uses light mode per feedback h2ayj0 */
  useEffect(() => {
    const el = document.documentElement;
    if (currentPhase === "sketch") {
      el.classList.add("sketch-phase-light");
    } else {
      el.classList.remove("sketch-phase-light");
    }
    return () => el.classList.remove("sketch-phase-light");
  }, [currentPhase]);
  const selectedTaskId = useAppSelector((s) => s.execute.selectedTaskId);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const prevProjectIdRef = useRef<string | null>(null);
  const project = useAppSelector((s) => s.project.data);
  const projectLoading = useAppSelector((s) => s.project.loading);
  const projectError = useAppSelector((s) => s.project.error);
  const hilRequest = useAppSelector((s) => s.websocket.hilRequest);
  const hilNotification = useAppSelector((s) => s.websocket.hilNotification);
  const deliverToast = useAppSelector((s) => s.websocket.deliverToast);
  const planBackgroundError = useAppSelector((s) => s.plan.backgroundError);

  // Upfront data loading for ALL phases on mount
  useEffect(() => {
    if (!projectId || redirectTo) return;

    // Only reset sketch when switching projects (not on Strict Mode remount with same projectId)
    if (prevProjectIdRef.current != null && prevProjectIdRef.current !== projectId) {
      dispatch(resetSketch());
    }
    prevProjectIdRef.current = projectId;

    dispatch(wsConnect({ projectId }));
    dispatch(fetchProject(projectId));
    dispatch(fetchSketchChat(projectId));
    dispatch(fetchPrd(projectId));
    dispatch(fetchPrdHistory(projectId));
    dispatch(fetchPlans(projectId));
    dispatch(fetchTasks(projectId));
    dispatch(fetchExecuteStatus(projectId));
    dispatch(fetchFeedback(projectId));
    dispatch(fetchDeliverStatus(projectId));
    dispatch(fetchDeliverHistory(projectId));

    return () => {
      dispatch(wsDisconnect());
      dispatch(resetProject());
      dispatch(resetWebsocket());
      // Do NOT reset sketch in cleanup: React Strict Mode double-mounts in dev; resetSketch
      // would clear prdContent before remount's fetchPrd completes. Reset only when
      // projectId changes (handled at effect start).
      dispatch(resetPlan());
      dispatch(resetExecute());
      dispatch(resetEval());
      dispatch(resetDeliver());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, redirectTo]);

  // Sync URL search params → Redux on load / when URL changes (deep link support)
  useEffect(() => {
    if (!projectId) return;
    const { plan, task } = parseDetailParams(location.search);
    if (plan && currentPhase === "plan") dispatch(setSelectedPlanId(plan));
    if (task && currentPhase === "execute") dispatch(setSelectedTaskId(task));
  }, [projectId, location.search, currentPhase, dispatch]);

  // Sync Redux selection → URL when user selects plan/task (shareable links)
  useEffect(() => {
    if (!projectId) return;
    const path = getProjectPhasePath(projectId, currentPhase, {
      plan: currentPhase === "plan" ? (selectedPlanId ?? undefined) : undefined,
      task: currentPhase === "execute" ? (selectedTaskId ?? undefined) : undefined,
    });
    const currentPath = location.pathname + location.search;
    if (path !== currentPath) {
      navigate(path, { replace: true });
    }
  }, [
    projectId,
    currentPhase,
    selectedPlanId,
    selectedTaskId,
    location.pathname,
    location.search,
    navigate,
  ]);

  if (!projectId) return null;
  if (redirectTo) return <Navigate to={redirectTo} replace />;

  const handlePhaseChange = (phase: ProjectPhase) => {
    // Preserve detail panel selection when switching phases — include plan/task in URL so
    // returning to a phase restores the detail panel
    navigate(
      getProjectPhasePath(projectId, phase, {
        plan: phase === "plan" ? (selectedPlanId ?? undefined) : undefined,
        task: phase === "execute" ? (selectedTaskId ?? undefined) : undefined,
      })
    );
  };

  const handleNavigateToBuildTask = (taskId: string) => {
    dispatch(setSelectedTaskId(taskId));
    navigate(getProjectPhasePath(projectId, "execute", { task: taskId }));
  };

  const handleNavigateToPlan = (planId: string) => {
    dispatch(setSelectedPlanId(planId));
    navigate(getProjectPhasePath(projectId, "plan", { plan: planId }));
  };

  const handleRespondToHil = (requestId: string, approved: boolean, notes?: string) => {
    dispatch(wsSend({ type: "hil.respond", requestId, approved, notes }));
    dispatch(setAwaitingApproval(false));
    dispatch(clearHilRequest());
  };

  const handleDismissNotification = () => {
    dispatch(clearHilNotification());
  };

  const handleDismissDeliverToast = () => {
    dispatch(clearDeliverToast());
  };

  const handleDismissPlanBackgroundError = () => {
    dispatch(clearPlanBackgroundError());
  };

  const handleProjectSaved = () => {
    if (projectId) dispatch(fetchProject(projectId));
  };

  // Loading state
  if (projectLoading && !project) {
    return (
      <>
        <Layout>
          <div className="flex items-center justify-center h-full text-theme-muted">
            Loading project...
          </div>
        </Layout>
        {hilRequest && <HilApprovalModal request={hilRequest} onRespond={handleRespondToHil} />}
        <HilNotificationToast
          notification={hilNotification}
          onDismiss={handleDismissNotification}
        />
        <DeliverToast toast={deliverToast} onDismiss={handleDismissDeliverToast} />
        <PlanRefreshToast
          error={planBackgroundError}
          onDismiss={handleDismissPlanBackgroundError}
        />
      </>
    );
  }

  // Error state — notification bar shows error details
  if (projectError || !project) {
    return (
      <>
        <Layout>
          <div className="flex flex-col items-center justify-center h-full gap-2 text-theme-muted">
            <p>Project not found or failed to load.</p>
            <Link to="/" className="text-brand-600 hover:text-brand-700 font-medium">
              Return to home
            </Link>
          </div>
        </Layout>
        {hilRequest && <HilApprovalModal request={hilRequest} onRespond={handleRespondToHil} />}
        <HilNotificationToast
          notification={hilNotification}
          onDismiss={handleDismissNotification}
        />
        <DeliverToast toast={deliverToast} onDismiss={handleDismissDeliverToast} />
        <PlanRefreshToast
          error={planBackgroundError}
          onDismiss={handleDismissPlanBackgroundError}
        />
      </>
    );
  }

  return (
    <>
      <Layout
        project={project}
        currentPhase={currentPhase}
        onPhaseChange={handlePhaseChange}
        onProjectSaved={handleProjectSaved}
        settingsOpen={settingsOpen}
        onSettingsOpenChange={setSettingsOpen}
      >
        {/* Mount ALL phases simultaneously, toggle visibility with CSS.
            Active phase uses flex container with flex-1 min-h-0 to establish bounded height
            so main content and sidebar can scroll independently. */}
        {VALID_PHASES.map((phase) => (
          <div
            key={phase}
            data-testid={`phase-${phase}`}
            style={{ display: phase === currentPhase ? "flex" : "none" }}
            className={
              phase === currentPhase
                ? "flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col"
                : undefined
            }
          >
            {phase === "sketch" && (
              <SketchPhase
                projectId={projectId}
                onNavigateToPlan={() => handlePhaseChange("plan")}
              />
            )}
            {phase === "plan" && (
              <PlanPhase projectId={projectId} onNavigateToBuildTask={handleNavigateToBuildTask} />
            )}
            {phase === "execute" && (
              <ExecutePhase projectId={projectId} onNavigateToPlan={handleNavigateToPlan} />
            )}
            {phase === "eval" && (
              <EvalPhase projectId={projectId} onNavigateToBuildTask={handleNavigateToBuildTask} />
            )}
            {phase === "deliver" && (
              <DeliverPhase projectId={projectId} onOpenSettings={() => setSettingsOpen(true)} />
            )}
          </div>
        ))}
      </Layout>
      {hilRequest && <HilApprovalModal request={hilRequest} onRespond={handleRespondToHil} />}
      <HilNotificationToast notification={hilNotification} onDismiss={handleDismissNotification} />
      <DeliverToast toast={deliverToast} onDismiss={handleDismissDeliverToast} />
      <PlanRefreshToast error={planBackgroundError} onDismiss={handleDismissPlanBackgroundError} />
    </>
  );
}

function PlanRefreshToast({ error, onDismiss }: { error: string | null; onDismiss: () => void }) {
  if (!error) return null;
  return (
    <div
      className="fixed bottom-4 right-4 z-40 max-w-md rounded-lg border border-theme-error-border bg-theme-error-bg p-4 shadow-lg text-theme-error-text"
      data-testid="plan-refresh-toast"
      role="alert"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium">{error}</p>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-1 text-theme-muted hover:bg-theme-border-subtle hover:text-theme-text"
          aria-label="Dismiss"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function DeliverToast({
  toast,
  onDismiss,
}: {
  toast: import("../store/slices/websocketSlice").DeliverToast | null;
  onDismiss: () => void;
}) {
  if (!toast) return null;
  const variantStyles: Record<string, string> = {
    started: "border-theme-info-border bg-theme-info-bg text-theme-info-text",
    succeeded: "border-theme-success-border bg-theme-success-bg text-theme-success-text",
    failed: "border-theme-error-border bg-theme-error-bg text-theme-error-text",
  };
  const style =
    variantStyles[toast.variant] ?? "border-theme-border bg-theme-surface text-theme-text";
  return (
    <div
      className={`fixed bottom-4 right-4 z-40 max-w-md rounded-lg border p-4 shadow-lg ${style}`}
      data-testid="deliver-toast"
      role="status"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium">{toast.message}</p>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-1 text-theme-muted hover:bg-theme-border-subtle hover:text-theme-text"
          aria-label="Dismiss"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function HilNotificationToast({
  notification,
  onDismiss,
}: {
  notification: import("@opensprint/shared").HilRequestEvent | null;
  onDismiss: () => void;
}) {
  if (!notification) return null;
  return (
    <div className="fixed bottom-4 right-4 z-40 max-w-md rounded-lg border border-theme-border bg-theme-surface p-4 shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-theme-text">
            {CATEGORY_LABELS[notification.category] ?? notification.category}
          </p>
          <p className="mt-1 text-sm text-theme-muted">{notification.description}</p>
          <p className="mt-2 text-xs text-theme-muted">
            Proceeding automatically. You can review in the log.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-1 text-theme-muted hover:bg-theme-border-subtle hover:text-theme-text"
          aria-label="Dismiss"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
