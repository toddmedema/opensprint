import { useEffect, lazy, Suspense } from "react";
import { useParams, useNavigate, useLocation, Navigate } from "react-router-dom";
import type { ProjectPhase } from "@opensprint/shared";
import {
  phaseFromSlug,
  getProjectPhasePath,
  isValidPhaseSlug,
  parseDetailParams,
} from "../lib/phaseRouting";
import { useAppDispatch, useAppSelector } from "../store";
import { setSelectedPlanId } from "../store/slices/planSlice";
import { setSelectedTaskId } from "../store/slices/executeSlice";
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

/**
 * Phase content (Sketch, Plan, Execute, Evaluate, Deliver). Renders inside ProjectShell.
 * Project state is managed by ProjectShell and persists when navigating to Help/Settings.
 */
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

  // Sync URL search params → Redux on load / when URL changes (deep link support).
  useEffect(() => {
    if (!projectId) return;
    const { plan, task } = parseDetailParams(location.search);
    if (plan && currentPhase === "plan") dispatch(setSelectedPlanId(plan));
    if (task && currentPhase === "execute") dispatch(setSelectedTaskId(task));
  }, [projectId, location.search, currentPhase, dispatch]);

  // Sync Redux selection → URL when user selects plan/task (shareable links).
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
      feedback: currentPhase === "eval" ? (urlFeedback ?? undefined) : undefined,
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

  return (
    <div
      key={`${projectId}-${currentPhase}`}
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
          <LazyPlanPhase projectId={projectId} onNavigateToBuildTask={handleNavigateToBuildTask} />
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
            onOpenSettings={() => navigate(`/projects/${projectId}/settings`)}
          />
        )}
      </Suspense>
    </div>
  );
}
