import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { useParams, useNavigate, useLocation, Navigate, Link } from "react-router-dom";
import type { ProjectPhase } from "@opensprint/shared";
import {
  phaseFromSlug,
  getProjectPhasePath,
  isValidPhaseSlug,
  parseDetailParams,
} from "../lib/phaseRouting";
import { useQueryClient } from "@tanstack/react-query";
import { useAppDispatch, useAppSelector } from "../store";
import { resetProject } from "../store/slices/projectSlice";
import { resetWebsocket, clearDeliverToast } from "../store/slices/websocketSlice";
import { resetSketch } from "../store/slices/sketchSlice";
import {
  resetPlan,
  setSelectedPlanId,
  clearPlanBackgroundError,
} from "../store/slices/planSlice";
import { resetExecute, setSelectedTaskId } from "../store/slices/executeSlice";
import { resetEval } from "../store/slices/evalSlice";
import {
  resetDeliver,
  setDeliverStatusPayload,
  setDeliverHistoryPayload,
} from "../store/slices/deliverSlice";
import {
  setTasks,
  setExecuteStatusPayload,
} from "../store/slices/executeSlice";
import { setPlansAndGraph, setPlanStatusPayload } from "../store/slices/planSlice";
import { setFeedback } from "../store/slices/evalSlice";
import {
  setPrdContent,
  setPrdHistory,
  setMessages as setSketchMessages,
} from "../store/slices/sketchSlice";
import { wsConnect, wsDisconnect } from "../store/middleware/websocketMiddleware";
import {
  useProject,
  useTasks,
  usePlans,
  useFeedback,
  useExecuteStatus,
  useDeliverStatus,
  useDeliverHistory,
  usePrd,
  usePrdHistory,
  useSketchChat,
  usePlanStatus,
} from "../api/hooks";
import { queryKeys } from "../api/queryKeys";
import { Layout } from "../components/layout/Layout";
import { PhaseLoadingFallback } from "../components/PhaseLoadingFallback";

const LazySketchPhase = lazy(() =>
  import("./phases/SketchPhase").then((m) => ({ default: m.SketchPhase }))
);
const LazyPlanPhase = lazy(() =>
  import("./phases/PlanPhase").then((m) => ({ default: m.PlanPhase }))
);
const LazyExecutePhase = lazy(() =>
  import("./phases/ExecutePhase").then((m) => ({ default: m.ExecutePhase }))
);
const LazyEvalPhase = lazy(() =>
  import("./phases/EvalPhase").then((m) => ({ default: m.EvalPhase }))
);
const LazyDeliverPhase = lazy(() =>
  import("./phases/DeliverPhase").then((m) => ({ default: m.DeliverPhase }))
);

export function ProjectView() {
  const { projectId, phase: phaseSlug } = useParams<{ projectId: string; phase?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useAppDispatch();
  const redirectTo =
    projectId && !isValidPhaseSlug(phaseSlug) ? getProjectPhasePath(projectId, "sketch") : null;

  const currentPhase = phaseFromSlug(phaseSlug);
  const selectedPlanId = useAppSelector((s) => s.plan.selectedPlanId);
  const selectedTaskId = useAppSelector((s) => s.execute.selectedTaskId);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const prevProjectIdRef = useRef<string | null>(null);
  /** Last synced data refs per key so we only dispatch when data actually changed (avoids flash from same data re-syncing). */
  const lastSyncedRef = useRef<Record<string, unknown>>({});
  const queryClient = useQueryClient();
  const { data: project, isLoading: projectLoading, error: projectError } = useProject(projectId);
  const { data: tasksData } = useTasks(projectId);
  const { data: plansData } = usePlans(projectId);
  const { data: feedbackData } = useFeedback(projectId);
  const { data: executeStatusData } = useExecuteStatus(projectId);
  const { data: deliverStatusData } = useDeliverStatus(projectId);
  const { data: deliverHistoryData } = useDeliverHistory(projectId);
  const { data: prdData } = usePrd(projectId);
  const { data: prdHistoryData } = usePrdHistory(projectId);
  const { data: sketchChatData } = useSketchChat(projectId);
  const { data: planStatusData } = usePlanStatus(projectId);
  // Sync TanStack Query → Redux only when data reference changed (avoids flash from refetch returning same ref)
  useEffect(() => {
    if (!projectId || !tasksData) return;
    if (lastSyncedRef.current["tasks"] === tasksData) return;
    lastSyncedRef.current["tasks"] = tasksData;
    dispatch(setTasks(tasksData));
  }, [projectId, tasksData, dispatch]);
  useEffect(() => {
    if (!projectId || !plansData) return;
    if (lastSyncedRef.current["plans"] === plansData) return;
    lastSyncedRef.current["plans"] = plansData;
    dispatch(setPlansAndGraph({ plans: plansData.plans, dependencyGraph: plansData }));
  }, [projectId, plansData, dispatch]);
  useEffect(() => {
    if (!projectId || feedbackData == null) return;
    if (lastSyncedRef.current["feedback"] === feedbackData) return;
    lastSyncedRef.current["feedback"] = feedbackData;
    dispatch(setFeedback(feedbackData));
  }, [projectId, feedbackData, dispatch]);
  useEffect(() => {
    if (!projectId || !executeStatusData) return;
    if (lastSyncedRef.current["executeStatus"] === executeStatusData) return;
    lastSyncedRef.current["executeStatus"] = executeStatusData;
    dispatch(
      setExecuteStatusPayload({
        activeTasks: executeStatusData.activeTasks ?? [],
        queueDepth: executeStatusData.queueDepth ?? 0,
        awaitingApproval: executeStatusData.awaitingApproval,
        totalDone: executeStatusData.totalDone ?? 0,
        totalFailed: executeStatusData.totalFailed ?? 0,
      })
    );
  }, [projectId, executeStatusData, dispatch]);
  useEffect(() => {
    if (!projectId || !deliverStatusData) return;
    if (lastSyncedRef.current["deliverStatus"] === deliverStatusData) return;
    lastSyncedRef.current["deliverStatus"] = deliverStatusData;
    dispatch(
      setDeliverStatusPayload({
        activeDeployId: deliverStatusData.activeDeployId,
        currentDeploy: deliverStatusData.currentDeploy,
      })
    );
  }, [projectId, deliverStatusData, dispatch]);
  useEffect(() => {
    if (!projectId || deliverHistoryData == null) return;
    if (lastSyncedRef.current["deliverHistory"] === deliverHistoryData) return;
    lastSyncedRef.current["deliverHistory"] = deliverHistoryData;
    dispatch(setDeliverHistoryPayload(deliverHistoryData));
  }, [projectId, deliverHistoryData, dispatch]);
  useEffect(() => {
    if (!projectId || prdData == null) return;
    if (lastSyncedRef.current["prd"] === prdData) return;
    lastSyncedRef.current["prd"] = prdData;
    dispatch(setPrdContent(prdData));
  }, [projectId, prdData, dispatch]);
  useEffect(() => {
    if (!projectId || prdHistoryData == null) return;
    if (lastSyncedRef.current["prdHistory"] === prdHistoryData) return;
    lastSyncedRef.current["prdHistory"] = prdHistoryData;
    dispatch(setPrdHistory(prdHistoryData));
  }, [projectId, prdHistoryData, dispatch]);
  useEffect(() => {
    if (!projectId || sketchChatData == null) return;
    if (lastSyncedRef.current["sketchChat"] === sketchChatData) return;
    lastSyncedRef.current["sketchChat"] = sketchChatData;
    dispatch(setSketchMessages(sketchChatData));
  }, [projectId, sketchChatData, dispatch]);
  useEffect(() => {
    if (!projectId || planStatusData == null) return;
    if (lastSyncedRef.current["planStatus"] === planStatusData) return;
    lastSyncedRef.current["planStatus"] = planStatusData;
    dispatch(setPlanStatusPayload(planStatusData));
  }, [projectId, planStatusData, dispatch]);
  const deliverToast = useAppSelector((s) => s.websocket.deliverToast);
  const planBackgroundError = useAppSelector((s) => s.plan.backgroundError);
  const connectionError = useAppSelector((s) => s.connection?.connectionError ?? false);

  // UI state is only for the current project: when projectId changes, clear everything then reload from server
  useEffect(() => {
    if (!projectId || redirectTo) return;

    const switchingProject =
      prevProjectIdRef.current != null && prevProjectIdRef.current !== projectId;
    if (switchingProject) {
      lastSyncedRef.current = {};
      dispatch(resetSketch(undefined as never));
      dispatch(resetPlan(undefined as never));
      dispatch(resetExecute(undefined as never));
      dispatch(resetEval());
      dispatch(resetDeliver());
      dispatch(resetProject());
      dispatch(resetWebsocket());
    }
    prevProjectIdRef.current = projectId;

    dispatch(wsConnect({ projectId }));

    return () => {
      dispatch(wsDisconnect());
      dispatch(resetProject());
      dispatch(resetWebsocket());
      dispatch(resetSketch(undefined as never));
      dispatch(resetPlan(undefined as never));
      dispatch(resetExecute(undefined as never));
      dispatch(resetEval());
      dispatch(resetDeliver());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, redirectTo]);

  // Sync URL search params → Redux on load / when URL changes (deep link support).
  // Setting selectedTaskId/selectedPlanId is enough; phase components use Query hooks for data.
  useEffect(() => {
    if (!projectId) return;
    const { plan, task } = parseDetailParams(location.search);
    if (plan && currentPhase === "plan") dispatch(setSelectedPlanId(plan));
    if (task && currentPhase === "execute") dispatch(setSelectedTaskId(task));
  }, [projectId, location.search, currentPhase, dispatch]);

  // Sync Redux selection → URL when user selects plan/task (shareable links).
  // Use URL params as fallback so we don't overwrite a deep link before URL→Redux effect has run.
  // Preserve feedback, question, section params (e.g. from Analyst dropdown or NotificationBell).
  useEffect(() => {
    if (!projectId) return;
    const {
      plan: urlPlan,
      task: urlTask,
      feedback: urlFeedback,
      question: urlQuestion,
      section: urlSection,
    } = parseDetailParams(location.search);
    const path = getProjectPhasePath(projectId, currentPhase, {
      plan: currentPhase === "plan" ? (selectedPlanId ?? urlPlan ?? undefined) : undefined,
      task: currentPhase === "execute" ? (selectedTaskId ?? urlTask ?? undefined) : undefined,
      feedback: currentPhase === "eval" ? urlFeedback ?? undefined : undefined,
      question: urlQuestion ?? undefined,
      section: urlSection ?? undefined,
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

  const handleDismissDeliverToast = () => {
    dispatch(clearDeliverToast());
  };

  const handleDismissPlanBackgroundError = () => {
    dispatch(clearPlanBackgroundError());
  };

  const handleProjectSaved = () => {
    if (projectId) void queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
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
        <DeliverToast toast={deliverToast} onDismiss={handleDismissDeliverToast} />
        {!connectionError && (
          <PlanRefreshToast
            error={planBackgroundError}
            onDismiss={handleDismissPlanBackgroundError}
          />
        )}
      </>
    );
  }

  // Error state — notification bar shows error details
  if (projectError || (!projectLoading && !project)) {
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
        <DeliverToast toast={deliverToast} onDismiss={handleDismissDeliverToast} />
        {!connectionError && (
          <PlanRefreshToast
            error={planBackgroundError}
            onDismiss={handleDismissPlanBackgroundError}
          />
        )}
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
        {/* Mount only active phase; lazy-load phase content. Layout and phase shell render eagerly.
            Phase data stays in global store (Redux + TanStack Query) so switching phases shows cached data. */}
        <div
          key={currentPhase}
          data-testid={`phase-${currentPhase}`}
          className="flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col"
        >
          <Suspense fallback={<PhaseLoadingFallback phase={currentPhase} />}>
            {currentPhase === "sketch" && (
              <LazySketchPhase
                projectId={projectId}
                onNavigateToPlan={() => handlePhaseChange("plan")}
              />
            )}
            {currentPhase === "plan" && (
              <LazyPlanPhase
                projectId={projectId}
                onNavigateToBuildTask={handleNavigateToBuildTask}
              />
            )}
            {currentPhase === "execute" && (
              <LazyExecutePhase
                projectId={projectId}
                initialTaskIdFromUrl={parseDetailParams(location.search).task ?? undefined}
                onNavigateToPlan={handleNavigateToPlan}
                onClose={() => {
                  dispatch(setSelectedTaskId(null));
                  navigate(getProjectPhasePath(projectId, "execute"));
                }}
              />
            )}
            {currentPhase === "eval" && (
              <LazyEvalPhase
                projectId={projectId}
                onNavigateToBuildTask={handleNavigateToBuildTask}
                feedbackIdFromUrl={parseDetailParams(location.search).feedback ?? undefined}
              />
            )}
            {currentPhase === "deliver" && (
              <LazyDeliverPhase
                projectId={projectId}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            )}
          </Suspense>
        </div>
      </Layout>
      <DeliverToast toast={deliverToast} onDismiss={handleDismissDeliverToast} />
      {!connectionError && (
        <PlanRefreshToast
          error={planBackgroundError}
          onDismiss={handleDismissPlanBackgroundError}
        />
      )}
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
