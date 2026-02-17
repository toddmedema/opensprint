import { useEffect } from "react";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import type { ProjectPhase } from "@opensprint/shared";
import { phaseFromSlug, getProjectPhasePath, isValidPhaseSlug, VALID_PHASES } from "../lib/phaseRouting";
import { useAppDispatch, useAppSelector } from "../store";
import { fetchProject, resetProject } from "../store/slices/projectSlice";
import { resetWebsocket, clearHilRequest, clearHilNotification } from "../store/slices/websocketSlice";
import { fetchDesignChat, fetchPrd, fetchPrdHistory, resetDesign } from "../store/slices/designSlice";
import { fetchPlans, resetPlan } from "../store/slices/planSlice";
import { fetchTasks, fetchBuildStatus, resetBuild, setSelectedTaskId } from "../store/slices/buildSlice";
import { fetchFeedback, resetValidate } from "../store/slices/validateSlice";
import { wsConnect, wsDisconnect, wsSend } from "../store/middleware/websocketMiddleware";
import { Layout } from "../components/layout/Layout";
import { HilApprovalModal } from "../components/HilApprovalModal";
import { DreamPhase } from "./phases/DreamPhase";
import { PlanPhase } from "./phases/PlanPhase";
import { BuildPhase } from "./phases/BuildPhase";
import { VerifyPhase } from "./phases/VerifyPhase";

const CATEGORY_LABELS: Record<string, string> = {
  scopeChanges: "Scope Changes",
  architectureDecisions: "Architecture Decisions",
  dependencyModifications: "Dependency Modifications",
  testFailuresAndRetries: "Test Failures & Retries",
};

export function ProjectView() {
  const { projectId, phase: phaseSlug } = useParams<{ projectId: string; phase?: string }>();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const redirectTo = projectId && !isValidPhaseSlug(phaseSlug) ? getProjectPhasePath(projectId, "dream") : null;

  const currentPhase = phaseFromSlug(phaseSlug);

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
    dispatch(fetchDesignChat(projectId));
    dispatch(fetchPrd(projectId));
    dispatch(fetchPrdHistory(projectId));
    dispatch(fetchPlans(projectId));
    dispatch(fetchTasks(projectId));
    dispatch(fetchBuildStatus(projectId));
    dispatch(fetchFeedback(projectId));

    return () => {
      dispatch(wsDisconnect());
      dispatch(resetProject());
      dispatch(resetWebsocket());
      dispatch(resetDesign());
      dispatch(resetPlan());
      dispatch(resetBuild());
      dispatch(resetValidate());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, redirectTo]);

  if (!projectId) return null;
  if (redirectTo) return <Navigate to={redirectTo} replace />;

  const handlePhaseChange = (phase: ProjectPhase) => {
    if (phase !== "build") dispatch(setSelectedTaskId(null));
    navigate(getProjectPhasePath(projectId, phase));
  };

  const handleNavigateToBuildTask = (taskId: string) => {
    dispatch(setSelectedTaskId(taskId));
    navigate(getProjectPhasePath(projectId, "build"));
  };

  const handleRespondToHil = (requestId: string, approved: boolean, notes?: string) => {
    dispatch(wsSend({ type: "hil.respond", requestId, approved, notes }));
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
      >
        {/* Mount ALL phases simultaneously, toggle visibility with CSS */}
        {VALID_PHASES.map((phase) => (
          <div
            key={phase}
            data-testid={`phase-${phase}`}
            style={{ display: phase === currentPhase ? "contents" : "none" }}
          >
            {phase === "dream" && (
              <DreamPhase projectId={projectId} onNavigateToPlan={() => handlePhaseChange("plan")} />
            )}
            {phase === "plan" && <PlanPhase projectId={projectId} onNavigateToBuildTask={handleNavigateToBuildTask} />}
            {phase === "build" && <BuildPhase projectId={projectId} />}
            {phase === "verify" && (
              <VerifyPhase projectId={projectId} onNavigateToBuildTask={handleNavigateToBuildTask} />
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
