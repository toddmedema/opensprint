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

// POST /projects/:projectId/plans/:planId/mark-complete — Mark plan complete (set reviewedAt when all tasks closed)
// Registered before generic :planId so /mark-complete is not captured as a planId
plansRouter.post("/:planId/mark-complete", async (req: Request<PlanParams>, res, next) => {
  try {
    const plan = await planService.markPlanComplete(req.params.projectId, req.params.planId);
    const body: ApiResponse<Plan> = { data: plan };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

type VersionParams = PlanParams & { versionNumber: string };

// GET /projects/:projectId/plans/:planId/versions — List plan versions (newest first)
plansRouter.get("/:planId/versions", async (req: Request<PlanParams>, res, next) => {
  try {
    await planService.getPlan(req.params.projectId, req.params.planId);
    const list = await taskStore.listPlanVersions(req.params.projectId, req.params.planId);
    const versions = list.map((v) => ({
      id: v.id,
      version_number: v.version_number,
      created_at: v.created_at,
      is_executed_version: v.is_executed_version,
    }));
    const body: ApiResponse<{ versions: typeof versions }> = { data: { versions } };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/plans/:planId/versions/:versionNumber — Get plan version by number
plansRouter.get("/:planId/versions/:versionNumber", async (req: Request<VersionParams>, res, next) => {
  try {
    await planService.getPlan(req.params.projectId, req.params.planId);
    const versionNum = parseInt(req.params.versionNumber, 10);
    if (Number.isNaN(versionNum) || versionNum < 1) {
      res.status(404).json({
        error: { code: "PLAN_VERSION_NOT_FOUND", message: `Plan version ${req.params.versionNumber} not found` },
      });
      return;
    }
    const row = await taskStore.getPlanVersionByNumber(
      req.params.projectId,
      req.params.planId,
      versionNum
    );
    let metadata: Record<string, unknown> | null = null;
    if (row.metadata != null && row.metadata.trim() !== "") {
      try {
        metadata = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        metadata = null;
      }
    }
    const data = {
      version_number: row.version_number,
      title: row.title,
      content: row.content,
      metadata,
      created_at: row.created_at,
      is_executed_version: row.is_executed_version,
    };
    const body: ApiResponse<typeof data> = { data };
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
// Optional body: { prerequisitePlanIds?: string[]; version_number?: number }
// If version_number provided, run ship with that version's content and set as last_executed.
plansRouter.post(
  "/:planId/execute",
  async (
    req: Request<
      PlanParams,
      unknown,
      { prerequisitePlanIds?: string[]; version_number?: number }
    >,
    res,
    next
  ) => {
    try {
      const prerequisitePlanIds = req.body?.prerequisitePlanIds ?? [];
      const version_number = req.body?.version_number;
      const options =
        version_number != null ? { version_number } : undefined;
      const plan =
        prerequisitePlanIds.length > 0
          ? await planService.shipPlanWithPrerequisites(
              req.params.projectId,
              req.params.planId,
              prerequisitePlanIds,
              options
            )
          : await planService.shipPlan(req.params.projectId, req.params.planId, options);
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
// Optional body: { version_number?: number }. Else uses last_executed_version_number for version content.
plansRouter.post(
  "/:planId/re-execute",
  async (
    req: Request<PlanParams, unknown, { version_number?: number }>,
    res,
    next
  ) => {
    try {
      const version_number = req.body?.version_number;
      const options =
        version_number != null ? { version_number } : undefined;
      const plan = await planService.reshipPlan(
        req.params.projectId,
        req.params.planId,
        options
      );
      // Nudge orchestrator to pick up newly-available tasks (PRDv2 §5.7 event-driven dispatch)
      orchestratorService.nudge(req.params.projectId);
      const body: ApiResponse<Plan> = { data: plan };
      res.json(body);
    } catch (err) {
      next(err);
    }
  }
);

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
