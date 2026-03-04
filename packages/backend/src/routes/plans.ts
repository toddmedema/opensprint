import { Router, Request } from "express";
import { PlanService } from "../services/plan.service.js";
import { orchestratorService } from "../services/orchestrator.service.js";
import { taskStore } from "../services/task-store.service.js";
import type {
  ApiResponse,
  Plan,
  PlanDependencyGraph,
  SuggestPlansResponse,
  CrossEpicDependenciesResponse,
  GeneratePlanResult,
} from "@opensprint/shared";

const planService = new PlanService();

export const plansRouter = Router({ mergeParams: true });

type ProjectParams = { projectId: string };
type PlanParams = { projectId: string; planId: string };

// POST /projects/:projectId/plans/decompose — AI decompose PRD into plans + tasks (must be before :planId)
plansRouter.post("/decompose", async (req: Request<ProjectParams>, res, next) => {
  try {
    const result = await planService.decomposeFromPrd(req.params.projectId);
    const body: ApiResponse<{ created: number; plans: Plan[] }> = { data: result };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/plans/generate — AI generate a plan from freeform feature description
plansRouter.post("/generate", async (req: Request<ProjectParams>, res, next) => {
  try {
    const { description } = req.body as { description?: string };
    if (!description?.trim()) {
      res.status(400).json({ error: { code: "VALIDATION", message: "description is required" } });
      return;
    }
    const result = await planService.generatePlanFromDescription(
      req.params.projectId,
      description.trim()
    );
    const body: ApiResponse<GeneratePlanResult> = { data: result };
    res.status(result.status === "created" ? 201 : 202).json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/plans/suggest — AI suggest plans from PRD (no creation; for user to accept/modify)
plansRouter.post("/suggest", async (req: Request<ProjectParams>, res, next) => {
  try {
    const result = await planService.suggestPlans(req.params.projectId);
    const body: ApiResponse<SuggestPlansResponse> = { data: result };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/plans — List all Plans with dependency graph (single call)
plansRouter.get("/", async (req: Request<ProjectParams>, res, next) => {
  try {
    const graph = await planService.listPlansWithDependencyGraph(req.params.projectId);
    const body: ApiResponse<PlanDependencyGraph> = { data: graph };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/plans — Create a new Plan
plansRouter.post("/", async (req: Request<ProjectParams>, res, next) => {
  try {
    const plan = await planService.createPlan(req.params.projectId, req.body);
    const body: ApiResponse<Plan> = { data: plan };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/plans/dependencies — Get dependency graph
plansRouter.get("/dependencies", async (req: Request<ProjectParams>, res, next) => {
  try {
    const graph = await planService.getDependencyGraph(req.params.projectId);
    const body: ApiResponse<PlanDependencyGraph> = { data: graph };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/plans/:planId/cross-epic-dependencies — Prerequisites still in Planning
plansRouter.get("/:planId/cross-epic-dependencies", async (req: Request<PlanParams>, res, next) => {
  try {
    const result = await planService.getCrossEpicDependencies(
      req.params.projectId,
      req.params.planId
    );
    const body: ApiResponse<CrossEpicDependenciesResponse> = { data: result };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/plans/:planId/auditor-runs — List Auditor runs for a plan (plan-centric lookup)
plansRouter.get("/:planId/auditor-runs", async (req: Request<PlanParams>, res, next) => {
  try {
    const runs = await taskStore.listAuditorRunsByPlanId(
      req.params.projectId,
      req.params.planId
    );
    const body: ApiResponse<typeof runs> = { data: runs };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/plans/:planId — Get Plan details
plansRouter.get("/:planId", async (req: Request<PlanParams>, res, next) => {
  try {
    const plan = await planService.getPlan(req.params.projectId, req.params.planId);
    const body: ApiResponse<Plan> = { data: plan };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// PUT /projects/:projectId/plans/:planId — Update Plan markdown
plansRouter.put("/:planId", async (req: Request<PlanParams>, res, next) => {
  try {
    const plan = await planService.updatePlan(req.params.projectId, req.params.planId, req.body);
    const body: ApiResponse<Plan> = { data: plan };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/plans/:planId/plan-tasks — Plan Tasks (create epic if missing, then AI-generate tasks)
plansRouter.post("/:planId/plan-tasks", async (req: Request<PlanParams>, res, next) => {
  try {
    const plan = await planService.planTasks(req.params.projectId, req.params.planId);
    const body: ApiResponse<Plan> = { data: plan };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/plans/:planId/execute — Execute! (approve Plan for execution)
// Optional body: { prerequisitePlanIds?: string[] } — auto-queue these plans first in dependency order
plansRouter.post(
  "/:planId/execute",
  async (req: Request<PlanParams & { body?: { prerequisitePlanIds?: string[] } }>, res, next) => {
    try {
      const prerequisitePlanIds = req.body?.prerequisitePlanIds ?? [];
      const plan =
        prerequisitePlanIds.length > 0
          ? await planService.shipPlanWithPrerequisites(
              req.params.projectId,
              req.params.planId,
              prerequisitePlanIds
            )
          : await planService.shipPlan(req.params.projectId, req.params.planId);
      // Nudge orchestrator to pick up newly-available tasks (PRDv2 §5.7 event-driven dispatch)
      orchestratorService.nudge(req.params.projectId);
      const body: ApiResponse<Plan> = { data: plan };
      res.json(body);
    } catch (err) {
      next(err);
    }
  }
);

// POST /projects/:projectId/plans/:planId/re-execute — Re-execute an updated Plan
plansRouter.post("/:planId/re-execute", async (req: Request<PlanParams>, res, next) => {
  try {
    const plan = await planService.reshipPlan(req.params.projectId, req.params.planId);
    // Nudge orchestrator to pick up newly-available tasks (PRDv2 §5.7 event-driven dispatch)
    orchestratorService.nudge(req.params.projectId);
    const body: ApiResponse<Plan> = { data: plan };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/plans/:planId/archive — Archive plan (close all ready/open tasks)
plansRouter.post("/:planId/archive", async (req: Request<PlanParams>, res, next) => {
  try {
    const plan = await planService.archivePlan(req.params.projectId, req.params.planId);
    const body: ApiResponse<Plan> = { data: plan };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// DELETE /projects/:projectId/plans/:planId — Delete plan from database
plansRouter.delete("/:planId", async (req: Request<PlanParams>, res, next) => {
  try {
    await planService.deletePlan(req.params.projectId, req.params.planId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});
