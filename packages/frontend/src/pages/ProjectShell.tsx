import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useParams, useLocation, useNavigate, Outlet, Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAppDispatch, useAppSelector } from "../store";
import { resetProject } from "../store/slices/projectSlice";
import { resetWebsocket, clearDeliverToast } from "../store/slices/websocketSlice";
import { resetSketch } from "../store/slices/sketchSlice";
import { resetPlan, clearPlanBackgroundError } from "../store/slices/planSlice";
import { resetExecute } from "../store/slices/executeSlice";
import { resetEval } from "../store/slices/evalSlice";
import { resetDeliver } from "../store/slices/deliverSlice";
import {
  setTasks,
  setExecuteStatusPayload,
  setActiveAgentsPayload,
} from "../store/slices/executeSlice";
import { setPlansAndGraph, setPlanStatusPayload } from "../store/slices/planSlice";
import { setFeedback } from "../store/slices/evalSlice";
import {
  setPrdContent,
  setPrdHistory,
  setMessages as setSketchMessages,
} from "../store/slices/sketchSlice";
import { setDeliverStatusPayload, setDeliverHistoryPayload } from "../store/slices/deliverSlice";
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
  useActiveAgents,
  useDbStatus,
} from "../api/hooks";
import { queryKeys } from "../api/queryKeys";
import { Layout } from "../components/layout/Layout";
import { DatabaseUnavailableState } from "../components/DatabaseUnavailableState";
import { getProjectPhasePath } from "../lib/phaseRouting";
import { VALID_PHASE_SLUGS } from "../lib/phaseRouting";
import type { ProjectPhase } from "@opensprint/shared";
import { ACTIVE_AGENTS_POLL_INTERVAL_MS } from "../lib/constants";
import { TOAST_SAFE_STYLE } from "../lib/dropdownViewport";
import { fetchProjectNotifications } from "../store/slices/openQuestionsSlice";
import { setRoute } from "../store/slices/routeSlice";

/** Derives current view from pathname: "help" | "settings" | phase slug. */
function getViewFromPathname(pathname: string): "help" | "settings" | string {
  const segments = pathname.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (last === "help") return "help";
  if (last === "settings") return "settings";
  return last ?? "sketch";
}

/** Returns true if we're on a phase route (sketch, plan, execute, eval, deliver). */
function isPhaseRoute(view: string): view is ProjectPhase {
  return VALID_PHASE_SLUGS.includes(view as ProjectPhase);
}

interface SyncedProjectData {
  projectId: string;
  data: unknown;
}

/**
 * ProjectShell keeps project state (Redux, WebSocket, TanStack Query sync) alive
 * when navigating between phases, Help, and Settings. Only unmounts when leaving
 * the project entirely, so state is preserved during Help/Settings visits.
 */
export function ProjectShell() {
  const { projectId } = useParams<{ projectId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const queryClient = useQueryClient();
  const prevProjectIdRef = useRef<string | null>(null);
  const lastSyncedRef = useRef<Record<string, SyncedProjectData | undefined>>({});

  const view = getViewFromPathname(location.pathname);
  const phaseRoute = isPhaseRoute(view);
  const currentPhase: ProjectPhase = isPhaseRoute(view) ? view : "sketch";
  const routePhase: ProjectPhase | null = phaseRoute ? view : null;
  const isSketch = currentPhase === "sketch";
  const isPlan = currentPhase === "plan";
  const isExecute = currentPhase === "execute";
  const isDeliver = currentPhase === "deliver";
  const dbStatus = useDbStatus();
  const dbPhaseAvailable = dbStatus.data?.ok === true;
  const shouldEnableDbBackedQueries = dbPhaseAvailable;
  const shouldConnectProjectWs = dbPhaseAvailable;
  const settingsHref = projectId ? `/projects/${projectId}/settings` : "/settings";

  const { data: project, isLoading: projectLoading, error: projectError } = useProject(projectId);
  const { data: tasksData } = useTasks(projectId, { enabled: shouldEnableDbBackedQueries });
  const { data: plansData } = usePlans(projectId, { enabled: shouldEnableDbBackedQueries });
  const { data: feedbackData } = useFeedback(projectId, { enabled: shouldEnableDbBackedQueries });
  const { data: executeStatusData } = useExecuteStatus(projectId, {
    enabled: isExecute && shouldEnableDbBackedQueries,
  });
  const { data: deliverStatusData } = useDeliverStatus(projectId, {
    enabled: isDeliver && shouldEnableDbBackedQueries,
  });
  const { data: deliverHistoryData } = useDeliverHistory(projectId, undefined, {
    enabled: isDeliver && shouldEnableDbBackedQueries,
  });
  const { data: prdData } = usePrd(projectId, {
    enabled: isSketch && shouldEnableDbBackedQueries,
  });
  const { data: prdHistoryData } = usePrdHistory(projectId, {
    enabled: isSketch && shouldEnableDbBackedQueries,
  });
  const { data: sketchChatData } = useSketchChat(projectId, {
    enabled: isSketch && shouldEnableDbBackedQueries,
  });
  const { data: planStatusData } = usePlanStatus(projectId, {
    enabled: (isSketch || isPlan) && shouldEnableDbBackedQueries,
  });
  const activeAgentsQuery = useActiveAgents(projectId, {
    enabled: shouldEnableDbBackedQueries,
    refetchInterval: ACTIVE_AGENTS_POLL_INTERVAL_MS,
  });
  const wsConnected = useAppSelector((s) => s.websocket.connected);
  const prevWsConnectedRef = useRef<boolean | null>(null);

  // Sync current project and phase to Redux so WebSocket middleware and Execute-unread logic can read them.
  useEffect(() => {
    if (projectId) {
      dispatch(setRoute({ projectId, phase: routePhase }));
    }
  }, [projectId, routePhase, dispatch]);

  // Project lifecycle: reset slices before query-to-Redux syncs run, then connect WS when DB is ready.
  // When projectId changes (switch or fresh mount from home), clear sync state and invalidate queries
  // so plans/tasks/feedback always load correctly without requiring a manual refresh.
  // useLayoutEffect ensures reset runs before paint when switching projects, avoiding a flash of
  // the previous project's data.
  useLayoutEffect(() => {
    if (!projectId) return;

    const projectIdChanged = prevProjectIdRef.current !== projectId;
    const switchingProject =
      prevProjectIdRef.current != null && prevProjectIdRef.current !== projectId;

    if (projectIdChanged) {
      lastSyncedRef.current = {};
      // Invalidate and refetch tasks/plans/feedback when project changes so Plan/Execute/Evaluate
      // show correct data without requiring a manual refresh. refetchQueries ensures we actively
      // trigger fetches rather than relying on stale-while-revalidate timing.
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.plans.list(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.feedback.list(projectId) });
      void queryClient.refetchQueries({ queryKey: queryKeys.tasks.list(projectId) });
      void queryClient.refetchQueries({ queryKey: queryKeys.plans.list(projectId) });
      void queryClient.refetchQueries({ queryKey: queryKeys.feedback.list(projectId) });
    }
    if (switchingProject) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
      dispatch(resetSketch(undefined as never));
      dispatch(resetPlan(undefined as never));
      dispatch(resetExecute(undefined as never));
      dispatch(resetEval());
      dispatch(resetDeliver());
      dispatch(resetProject());
      dispatch(resetWebsocket());
    }
    prevProjectIdRef.current = projectId;
    if (shouldConnectProjectWs) {
      dispatch(wsConnect({ projectId }));
    }

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
  }, [projectId, shouldConnectProjectWs]);

  // Sync TanStack Query → Redux (keeps state populated even when on Help/Settings)
  useEffect(() => {
    if (!projectId || !tasksData) return;
    const previous = lastSyncedRef.current["tasks"];
    if (previous?.projectId === projectId && previous.data === tasksData) return;
    lastSyncedRef.current["tasks"] = { projectId, data: tasksData };
    dispatch(setTasks(tasksData));
  }, [projectId, tasksData, dispatch]);
  useEffect(() => {
    if (!projectId || !plansData) return;
    const previous = lastSyncedRef.current["plans"];
    if (previous?.projectId === projectId && previous.data === plansData) return;
    lastSyncedRef.current["plans"] = { projectId, data: plansData };
    dispatch(setPlansAndGraph({ plans: plansData.plans, dependencyGraph: plansData }));
  }, [projectId, plansData, dispatch]);
  useEffect(() => {
    if (!projectId || feedbackData == null) return;
    const previous = lastSyncedRef.current["feedback"];
    if (previous?.projectId === projectId && previous.data === feedbackData) return;
    lastSyncedRef.current["feedback"] = { projectId, data: feedbackData };
    dispatch(setFeedback(feedbackData));
  }, [projectId, feedbackData, dispatch]);
  useEffect(() => {
    if (!projectId || !executeStatusData) return;
    const previous = lastSyncedRef.current["executeStatus"];
    if (previous?.projectId === projectId && previous.data === executeStatusData) return;
    lastSyncedRef.current["executeStatus"] = { projectId, data: executeStatusData };
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
    const previous = lastSyncedRef.current["deliverStatus"];
    if (previous?.projectId === projectId && previous.data === deliverStatusData) return;
    lastSyncedRef.current["deliverStatus"] = { projectId, data: deliverStatusData };
    dispatch(
      setDeliverStatusPayload({
        activeDeployId: deliverStatusData.activeDeployId,
        currentDeploy: deliverStatusData.currentDeploy,
      })
    );
  }, [projectId, deliverStatusData, dispatch]);
  useEffect(() => {
    if (!projectId || deliverHistoryData == null) return;
    const previous = lastSyncedRef.current["deliverHistory"];
    if (previous?.projectId === projectId && previous.data === deliverHistoryData) return;
    lastSyncedRef.current["deliverHistory"] = { projectId, data: deliverHistoryData };
    dispatch(setDeliverHistoryPayload(deliverHistoryData));
  }, [projectId, deliverHistoryData, dispatch]);
  useEffect(() => {
    if (!projectId || prdData == null) return;
    const previous = lastSyncedRef.current["prd"];
    if (previous?.projectId === projectId && previous.data === prdData) return;
    lastSyncedRef.current["prd"] = { projectId, data: prdData };
    dispatch(setPrdContent(prdData));
  }, [projectId, prdData, dispatch]);
  useEffect(() => {
    if (!projectId || prdHistoryData == null) return;
    const previous = lastSyncedRef.current["prdHistory"];
    if (previous?.projectId === projectId && previous.data === prdHistoryData) return;
    lastSyncedRef.current["prdHistory"] = { projectId, data: prdHistoryData };
    dispatch(setPrdHistory(prdHistoryData));
  }, [projectId, prdHistoryData, dispatch]);
  useEffect(() => {
    if (!projectId || sketchChatData == null) return;
    const previous = lastSyncedRef.current["sketchChat"];
    if (previous?.projectId === projectId && previous.data === sketchChatData) return;
    lastSyncedRef.current["sketchChat"] = { projectId, data: sketchChatData };
    dispatch(setSketchMessages(sketchChatData));
  }, [projectId, sketchChatData, dispatch]);
  useEffect(() => {
    if (!projectId || planStatusData == null) return;
    const previous = lastSyncedRef.current["planStatus"];
    if (previous?.projectId === projectId && previous.data === planStatusData) return;
    lastSyncedRef.current["planStatus"] = { projectId, data: planStatusData };
    dispatch(setPlanStatusPayload(planStatusData));
  }, [projectId, planStatusData, dispatch]);
  useEffect(() => {
    if (!projectId || !shouldEnableDbBackedQueries) return;
    dispatch(fetchProjectNotifications(projectId));
  }, [projectId, shouldEnableDbBackedQueries, dispatch]);
  useEffect(() => {
    if (!projectId || !activeAgentsQuery.data) return;
    const previous = lastSyncedRef.current["activeAgents"];
    if (previous?.projectId === projectId && previous.data === activeAgentsQuery.data) return;
    lastSyncedRef.current["activeAgents"] = { projectId, data: activeAgentsQuery.data };
    dispatch(setActiveAgentsPayload(activeAgentsQuery.data));
  }, [projectId, activeAgentsQuery.data, dispatch]);
  useEffect(() => {
    if (
      !projectId ||
      activeAgentsQuery.data ||
      activeAgentsQuery.isFetching ||
      !activeAgentsQuery.isError
    ) {
      return;
    }
    dispatch(setActiveAgentsPayload({ agents: [], taskIdToStartedAt: {} }));
  }, [
    projectId,
    activeAgentsQuery.data,
    activeAgentsQuery.isError,
    activeAgentsQuery.isFetching,
    dispatch,
  ]);
  useEffect(() => {
    const prev = prevWsConnectedRef.current;
    prevWsConnectedRef.current = wsConnected;
    if (prev == null || !projectId || !shouldEnableDbBackedQueries) return;
    if (!prev && wsConnected) {
      void activeAgentsQuery.refetch();
      dispatch(fetchProjectNotifications(projectId));
    }
  }, [projectId, wsConnected, shouldEnableDbBackedQueries, activeAgentsQuery, dispatch]);

  const handlePhaseChange = (phase: ProjectPhase) => {
    if (projectId) navigate(getProjectPhasePath(projectId, phase));
  };

  const handleProjectSaved = () => {
    if (projectId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
    }
  };

  const deliverToast = useAppSelector((s) => s.websocket.deliverToast);
  const planBackgroundError = useAppSelector((s) => s.plan.backgroundError);
  const connectionError = useAppSelector((s) => s.connection?.connectionError ?? false);
  const dbUnavailableMessage = dbStatus.data?.message ?? "PostgreSQL is unavailable.";

  const handleDismissDeliverToast = () => dispatch(clearDeliverToast());
  const handleDismissPlanBackgroundError = () => dispatch(clearPlanBackgroundError());

  function renderShellContent(content: ReactNode) {
    return (
      <>
        <Layout
          project={project ?? null}
          currentPhase={currentPhase}
          onPhaseChange={project ? handlePhaseChange : undefined}
          onProjectSaved={project ? handleProjectSaved : undefined}
        >
          {content}
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

  if (!projectId) return null;

  if (projectLoading && !project) {
    return renderShellContent(
      <div className="flex items-center justify-center h-full text-theme-muted">
        Loading project...
      </div>
    );
  }

  if (projectError || (!projectLoading && !project)) {
    return renderShellContent(
      <div className="flex flex-col items-center justify-center h-full gap-2 text-theme-muted">
        <p>Project not found or failed to load.</p>
        <Link to="/" className="text-brand-600 hover:text-brand-700 font-medium">
          Return to home
        </Link>
      </div>
    );
  }

  if (!project) {
    return null;
  }

  const resolvedProject = project;

  if (phaseRoute && dbStatus.isPending) {
    return renderShellContent(
      <div className="flex items-center justify-center h-full text-theme-muted">
        Checking PostgreSQL...
      </div>
    );
  }

  if (phaseRoute && dbStatus.data && !dbStatus.data.ok) {
    return renderShellContent(
      <DatabaseUnavailableState message={dbUnavailableMessage} settingsHref={settingsHref} />
    );
  }

  return (
    renderShellContent(
      <Outlet
        context={
          { projectId, project: resolvedProject, currentPhase } satisfies ProjectShellContext
        }
      />
    )
  );
}

function PlanRefreshToast({ error, onDismiss }: { error: string | null; onDismiss: () => void }) {
  if (!error) return null;
  return (
    <div
      className="fixed z-40 max-w-md max-h-[90vh] overflow-y-auto rounded-lg border border-theme-error-border bg-theme-error-bg p-4 shadow-lg text-theme-error-text"
      style={TOAST_SAFE_STYLE}
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
      className={`fixed z-40 max-w-md max-h-[90vh] overflow-y-auto rounded-lg border p-4 shadow-lg ${style}`}
      style={TOAST_SAFE_STYLE}
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

export interface ProjectShellContext {
  projectId: string;
  project: NonNullable<Awaited<ReturnType<typeof useProject>>["data"]>;
  currentPhase: ProjectPhase;
}
