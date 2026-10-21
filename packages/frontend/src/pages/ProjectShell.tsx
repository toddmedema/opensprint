import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useParams, useLocation, useNavigate, Outlet } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { CollaborationBar } from "../components/CollaborationBar";
import { useProjectReplay } from "../hooks/useProjectReplay";
import { useAppDispatch, useAppSelector } from "../store";
import { resetProject } from "../store/slices/projectSlice";
import { resetWebsocket } from "../store/slices/websocketSlice";
import { resetSketch } from "../store/slices/sketchSlice";
import { resetPlan } from "../store/slices/planSlice";
import { resetExecute } from "../store/slices/executeSlice";
import { resetEval } from "../store/slices/evalSlice";
import { resetDeliver } from "../store/slices/deliverSlice";
import { wsConnect, wsDisconnect } from "../store/middleware/websocketMiddleware";
import {
  useProject,
  useTasks,
  usePlans,
  useFeedback,
  useExecuteStatus,
  usePrd,
  usePrdHistory,
  useSketchChat,
  usePlanStatus,
  useActiveAgents,
  useProjectNotifications,
  useDbStatus,
} from "../api/hooks";
import { queryKeys } from "../api/queryKeys";
import { Layout } from "../components/layout/Layout";
import { PhaseLoadingSpinner } from "../components/PhaseLoadingSpinner";
import { DatabaseUnavailableState } from "../components/DatabaseUnavailableState";
import { ProjectNotFoundState } from "../components/ProjectNotFoundState";
import { getProjectPhasePath } from "../lib/phaseRouting";
import { VALID_PHASE_SLUGS } from "../lib/phaseRouting";
import { schedulePhasePreload } from "../lib/phasePreload";
import type { ProjectPhase } from "@opensprint/shared";
import { ACTIVE_AGENTS_POLL_INTERVAL_MS } from "../lib/constants";

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

/**
 * ProjectShell keeps query observers and WebSocket transport alive
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

  const view = getViewFromPathname(location.pathname);
  const phaseRoute = isPhaseRoute(view);
  const currentPhase: ProjectPhase = isPhaseRoute(view) ? view : "sketch";
  const isSketch = currentPhase === "sketch";
  const isPlan = currentPhase === "plan";
  const isExecute = currentPhase === "execute";
  const dbStatus = useDbStatus();
  const dbPhaseAvailable = dbStatus.data?.ok === true;
  const shouldEnableDbBackedQueries = dbPhaseAvailable;
  const shouldConnectProjectWs = dbPhaseAvailable;
  useProjectReplay(projectId, dbPhaseAvailable);
  const settingsHref = projectId ? `/projects/${projectId}/settings` : "/settings";

  const { data: project, isLoading: projectLoading, error: projectError } = useProject(projectId);
  useTasks(projectId, { enabled: shouldEnableDbBackedQueries });
  usePlans(projectId, { enabled: shouldEnableDbBackedQueries });
  useFeedback(projectId, { enabled: shouldEnableDbBackedQueries });
  useExecuteStatus(projectId, {
    enabled: isExecute && shouldEnableDbBackedQueries,
  });
  usePrd(projectId, {
    enabled: isSketch && shouldEnableDbBackedQueries,
  });
  usePrdHistory(projectId, {
    enabled: isSketch && shouldEnableDbBackedQueries,
  });
  useSketchChat(projectId, {
    enabled: isSketch && shouldEnableDbBackedQueries,
  });
  usePlanStatus(projectId, {
    enabled: (isSketch || isPlan) && shouldEnableDbBackedQueries,
  });
  const activeAgentsQuery = useActiveAgents(projectId, {
    enabled: shouldEnableDbBackedQueries,
    refetchInterval: ACTIVE_AGENTS_POLL_INTERVAL_MS,
  });
  const notificationsQuery = useProjectNotifications(projectId, {
    enabled: shouldEnableDbBackedQueries,
  });
  const wsConnected = useAppSelector((s) => s.websocket.connected);
  const prevWsConnectedRef = useRef<boolean | null>(null);

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

    return () => {
      dispatch(resetProject());
      dispatch(resetWebsocket());
      dispatch(resetSketch(undefined as never));
      dispatch(resetPlan(undefined as never));
      dispatch(resetExecute(undefined as never));
      dispatch(resetEval());
      dispatch(resetDeliver());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  // Database availability controls transport only; cached project state survives outages.
  useLayoutEffect(() => {
    if (projectId && shouldConnectProjectWs) dispatch(wsConnect({ projectId }));
    return () => {
      dispatch(wsDisconnect());
    };
  }, [projectId, shouldConnectProjectWs, dispatch]);

  // Preload phase data and lazy chunks in background so first navigation to each tab is instant.
  useEffect(() => {
    if (!projectId || !shouldEnableDbBackedQueries) return;
    schedulePhasePreload(projectId, queryClient);
  }, [projectId, shouldEnableDbBackedQueries, queryClient]);
  useEffect(() => {
    const prev = prevWsConnectedRef.current;
    prevWsConnectedRef.current = wsConnected;
    if (prev == null || !projectId || !shouldEnableDbBackedQueries) return;
    if (!prev && wsConnected) {
      void activeAgentsQuery.refetch();
      void notificationsQuery.refetch();
    }
  }, [projectId, wsConnected, shouldEnableDbBackedQueries, activeAgentsQuery, notificationsQuery]);

  const handlePhaseChange = (phase: ProjectPhase) => {
    if (projectId) navigate(getProjectPhasePath(projectId, phase));
  };

  const handleProjectSaved = () => {
    if (projectId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectId) });
    }
  };

  const dbUnavailableMessage =
    dbStatus.data?.message ??
    "The database is not available; check Settings to fix the connection.";

  function renderShellContent(content: ReactNode) {
    return (
      <>
        <Layout
          project={project ?? null}
          currentPhase={currentPhase}
          onPhaseChange={project ? handlePhaseChange : undefined}
          onProjectSaved={project ? handleProjectSaved : undefined}
        >
          {projectId && dbPhaseAvailable && <CollaborationBar projectId={projectId} />}
          {content}
        </Layout>
      </>
    );
  }

  if (!projectId) return null;

  if (projectLoading && !project) {
    return renderShellContent(
      <div className="flex flex-1 min-h-0 items-center justify-center">
        <PhaseLoadingSpinner status="Loading project…" aria-label="Loading project" />
      </div>
    );
  }

  if (projectError || (!projectLoading && !project)) {
    return renderShellContent(<ProjectNotFoundState />);
  }

  if (!project) {
    return null;
  }

  const resolvedProject = project;

  if (phaseRoute && dbStatus.isPending) {
    return renderShellContent(
      <div className="flex flex-1 min-h-0 items-center justify-center">
        <PhaseLoadingSpinner status="Checking database…" aria-label="Checking database" />
      </div>
    );
  }

  if (phaseRoute && dbStatus.data && !dbStatus.data.ok) {
    return renderShellContent(
      <DatabaseUnavailableState message={dbUnavailableMessage} settingsHref={settingsHref} />
    );
  }

  return renderShellContent(
    <Outlet
      context={{ projectId, project: resolvedProject, currentPhase } satisfies ProjectShellContext}
    />
  );
}

export interface ProjectShellContext {
  projectId: string;
  project: NonNullable<Awaited<ReturnType<typeof useProject>>["data"]>;
  currentPhase: ProjectPhase;
}
