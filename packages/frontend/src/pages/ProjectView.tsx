import { useEffect, useState } from "react";
import { useParams, useNavigate, useLocation, Navigate } from "react-router-dom";
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
import { resetWebsocket, clearHilRequest, clearHilNotification } from "../store/slices/websocketSlice";
import { fetchSpecChat, fetchPrd, fetchPrdHistory, resetSpec } from "../store/slices/specSlice";
import { fetchPlans, resetPlan, setSelectedPlanId } from "../store/slices/planSlice";
import {
  fetchTasks,
  fetchExecuteStatus,
  resetExecute,
  setSelectedTaskId,
  setAwaitingApproval,
} from "../store/slices/executeSlice";
import { fetchFeedback, resetEnsure } from "../store/slices/ensureSlice";
import { fetchDeployStatus, fetchDeployHistory, resetDeploy } from "../store/slices/deploySlice";
import { wsConnect, wsDisconnect, wsSend } from "../store/middleware/websocketMiddleware";
import { Layout } from "../components/layout/Layout";
import { HilApprovalModal } from "../components/HilApprovalModal";
import { SpecPhase } from "./phases/SpecPhase";
import { PlanPhase } from "./phases/PlanPhase";
import { ExecutePhase } from "./phases/ExecutePhase";
import { EnsurePhase } from "./phases/EnsurePhase";
import { DeployPhase } from "./phases/DeployPhase";

const CATEGORY_LABELS: Record<string, string> = {
  scopeChanges: "Scope Changes",
  architectureDecisions: "Architecture Decisions",
  dependencyModifications: "Dependency Modifications",
  testFailuresAndRetries: "Test Failures & Retries",
};

export function ProjectView() {
  const { projectId, phase: phaseSlug } = useParams<{ projectId: string; phase?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const dispatch = useAppDispatch();
  const redirectTo = projectId && !isValidPhaseSlug(phaseSlug) ? getProjectPhasePath(projectId, "spec") : null;

  const currentPhase = phaseFromSlug(phaseSlug);
  const selectedPlanId = useAppSelector((s) => s.plan.selectedPlanId);
  const selectedTaskId = useAppSelector((s) => s.execute.selectedTaskId);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const project = useAppSelector((s) => s.project.data);
  const projectLoading = useAppSelector((s) => s.project.loading);
  const projectError = useAppSelector((s) => s.project.error);
  const hilRequest = useAppSelector((s) => s.websocket.hilRequest);
  const hilNotification = useAppSelector((s) => s.websocket.hilNotification);

  // Upfront data loading for ALL phases on mount
  useEffect(() => {
    if (!projectId || redirectTo) return;

    dispatch(wsConnect({ projectId }));
    dispatch(fetchProject(projectId));
    dispatch(fetchSpecChat(projectId));
    dispatch(fetchPrd(projectId));
    dispatch(fetchPrdHistory(projectId));
    dispatch(fetchPlans(projectId));
    dispatch(fetchTasks(projectId));
    dispatch(fetchExecuteStatus(projectId));
    dispatch(fetchFeedback(projectId));
    dispatch(fetchDeployStatus(projectId));
    dispatch(fetchDeployHistory(projectId));

    return () => {
      dispatch(wsDisconnect());
      dispatch(resetProject());
      dispatch(resetWebsocket());
      dispatch(resetSpec());
      dispatch(resetPlan());
      dispatch(resetExecute());
      dispatch(resetEnsure());
      dispatch(resetDeploy());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, redirectTo]);

  if (!projectId) return null;
  if (redirectTo) return <Navigate to={redirectTo} replace />;

  // Sync URL search params → Redux on load / when URL changes (deep link support)
  useEffect(() => {
    const { plan, task } = parseDetailParams(location.search);
    if (plan && currentPhase === "plan") dispatch(setSelectedPlanId(plan));
    if (task && currentPhase === "execute") dispatch(setSelectedTaskId(task));
  }, [location.search, currentPhase, dispatch]);

  // Sync Redux selection → URL when user selects plan/task (shareable links)
  useEffect(() => {
    const path = getProjectPhasePath(projectId, currentPhase, {
      plan: currentPhase === "plan" ? selectedPlanId ?? undefined : undefined,
      task: currentPhase === "execute" ? selectedTaskId ?? undefined : undefined,
    });
    const currentPath = location.pathname + location.search;
    if (path !== currentPath) {
      navigate(path, { replace: true });
    }
  }, [projectId, currentPhase, selectedPlanId, selectedTaskId, location.pathname, location.search, navigate]);

  const handlePhaseChange = (phase: ProjectPhase) => {
    // Preserve detail panel selection when switching phases — include plan/task in URL so
    // returning to a phase restores the detail panel
    navigate(
      getProjectPhasePath(projectId, phase, {
        plan: phase === "plan" ? selectedPlanId ?? undefined : undefined,
        task: phase === "execute" ? selectedTaskId ?? undefined : undefined,
      }),
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

  const handleProjectSaved = () => {
    if (projectId) dispatch(fetchProject(projectId));
  };

  // Loading state
  if (projectLoading && !project) {
    return (
      <>
        <Layout>
          <div className="flex items-center justify-center h-full text-gray-400">Loading project...</div>
        </Layout>
        {hilRequest && <HilApprovalModal request={hilRequest} onRespond={handleRespondToHil} />}
        <HilNotificationToast notification={hilNotification} onDismiss={handleDismissNotification} />
      </>
    );
  }

  // Error state
  if (projectError || !project) {
    return (
      <>
        <Layout>
          <div className="flex items-center justify-center h-full text-red-500">
            {projectError ?? "Project not found"}
          </div>
        </Layout>
        {hilRequest && <HilApprovalModal request={hilRequest} onRespond={handleRespondToHil} />}
        <HilNotificationToast notification={hilNotification} onDismiss={handleDismissNotification} />
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
            className={phase === currentPhase ? "flex-1 min-h-0 min-w-0 overflow-hidden flex flex-col" : undefined}
          >
            {phase === "spec" && (
              <SpecPhase projectId={projectId} onNavigateToPlan={() => handlePhaseChange("plan")} />
            )}
            {phase === "plan" && <PlanPhase projectId={projectId} onNavigateToBuildTask={handleNavigateToBuildTask} />}
            {phase === "execute" && <ExecutePhase projectId={projectId} onNavigateToPlan={handleNavigateToPlan} />}
            {phase === "ensure" && (
              <EnsurePhase projectId={projectId} onNavigateToBuildTask={handleNavigateToBuildTask} />
            )}
            {phase === "deploy" && (
              <DeployPhase projectId={projectId} onOpenSettings={() => setSettingsOpen(true)} />
            )}
          </div>
        ))}
      </Layout>
      {hilRequest && <HilApprovalModal request={hilRequest} onRespond={handleRespondToHil} />}
      <HilNotificationToast notification={hilNotification} onDismiss={handleDismissNotification} />
    </>
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
    <div className="fixed bottom-4 right-4 z-40 max-w-md rounded-lg border border-gray-200 bg-white p-4 shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-gray-900">
            {CATEGORY_LABELS[notification.category] ?? notification.category}
          </p>
          <p className="mt-1 text-sm text-gray-600">{notification.description}</p>
          <p className="mt-2 text-xs text-gray-500">Proceeding automatically. You can review in the log.</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          aria-label="Dismiss"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
