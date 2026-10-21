import { runDurableRequest } from "../services/durable-request.service.js";
import { operationWorker } from "../services/operation-worker.service.js";
import { Router, Request } from "express";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateParams, validateBody } from "../middleware/validate.js";
import { projectIdParamSchema } from "../schemas/request-common.js";
import {
  planIdParamSchema,
  planVersionParamsSchema,
  plansGenerateBodySchema,
  createPlanBodySchema,
  planExecuteBodySchema,
  planReexecuteBodySchema,
  planExecuteBatchBodySchema,
  planExecuteBatchParamsSchema,
} from "../schemas/request-plans.js";
import {
  enqueuePlanExecuteBatch,
  getActivePlanExecuteBatch,
  getPlanExecuteBatchStatus,
} from "../services/plan-execute-batch.service.js";
import type { PlanService } from "../services/plan.service.js";
import { orchestratorService } from "../services/orchestrator.service.js";
import { taskStore } from "../services/task-store.service.js";
import { broadcastToProject } from "../websocket/index.js";
import type {
  ApiResponse,
  Plan,
  PlanDependencyGraph,
  SuggestPlansResponse,
  CrossEpicDependenciesResponse,
  GeneratePlanResult,
  PlanExecuteBatchItem,
  PlanExecuteBatchStatus,
  PlanHierarchyResponse,
} from "@opensprint/shared";

export function createPlansRouter(planService: PlanService): Router {
  const router = Router({ mergeParams: true });
  operationWorker.register("plan.decompose", (op) => planService.decomposeFromPrd(op.projectId));
  operationWorker.register("plan.suggest", (op) => planService.suggestPlans(op.projectId));
  operationWorker.register("plan.generate", (op) => {
    const payload = op.payload as {
      description: string;
      attachments?: import("@opensprint/shared").PlanAttachment[];
    };
    return planService.generatePlanFromDescription(
      op.projectId,
      payload.description,
      payload.attachments
    );
  });
  operationWorker.register("plan.tasks", (op) => planService.planTasks(op.projectId, op.target));
  operationWorker.register("plan.execute", (op) => {
    const payload = op.payload as { prerequisitePlanIds?: string[]; version_number?: number };
    const options =
      payload.version_number == null ? undefined : { version_number: payload.version_number };
    return payload.prerequisitePlanIds?.length
      ? planService.shipPlanWithPrerequisites(
          op.projectId,
          op.target,
          payload.prerequisitePlanIds,
          options
        )
      : planService.shipPlan(op.projectId, op.target, options);
  });
  operationWorker.register("plan.reexecute", (op) => {
    const payload = op.payload as { version_number?: number };
    return planService.reshipPlan(
      op.projectId,
      op.target,
      payload.version_number == null ? undefined : { version_number: payload.version_number }
    );
  });

  type ProjectParams = { projectId: string };
  type PlanParams = { projectId: string; planId: string };

  // POST /projects/:projectId/plans/decompose — AI decompose PRD into plans + tasks (must be before :planId)
  router.post(
    "/decompose",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const result = await runDurableRequest(
        req.params.projectId,
        "plan.decompose",
        "plans",
        req.body ?? {},
        () => planService.decomposeFromPrd(req.params.projectId)
      );
      const body: ApiResponse<{ created: number; plans: Plan[] }> = { data: result };
      res.status(201).json(body);
    })
  );

  // POST /projects/:projectId/plans/generate — AI generate a plan from freeform feature description
  router.post(
    "/generate",
    validateParams(projectIdParamSchema),
    validateBody(plansGenerateBodySchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const { description, attachments } = req.body as {
        description: string;
        attachments?: import("@opensprint/shared").PlanAttachment[];
      };
      const result = await runDurableRequest(
        req.params.projectId,
        "plan.generate",
        "plans",
        { description: description.trim(), attachments },
        () =>
          planService.generatePlanFromDescription(
            req.params.projectId,
            description.trim(),
            attachments
          )
      );
      const body: ApiResponse<GeneratePlanResult> = { data: result };
      res.status(result.status === "created" ? 201 : 202).json(body);
    })
  );

  // POST /projects/:projectId/plans/suggest — AI suggest plans from PRD (no creation; for user to accept/modify)
  router.post(
    "/suggest",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const result = await runDurableRequest(
        req.params.projectId,
        "plan.suggest",
        "plans",
        {},
        () => planService.suggestPlans(req.params.projectId)
      );
      const body: ApiResponse<SuggestPlansResponse> = { data: result };
      res.json(body);
    })
  );

  // GET /projects/:projectId/plans — List all Plans with dependency graph (single call)
  router.get(
    "/",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const graph = await planService.listPlansWithDependencyGraph(req.params.projectId);
      const body: ApiResponse<PlanDependencyGraph> = { data: graph };
      res.json(body);
    })
  );

  // POST /projects/:projectId/plans — Create a new Plan
  router.post(
    "/",
    validateParams(projectIdParamSchema),
    validateBody(createPlanBodySchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const plan = await planService.createPlan(req.params.projectId, req.body);
      const body: ApiResponse<Plan> = { data: plan };
      res.status(201).json(body);
    })
  );

  // POST /projects/:projectId/plans/execute-batch — Queue Execute-all (persists; survives UI refresh)
  router.post(
    "/execute-batch",
    validateParams(projectIdParamSchema),
    validateBody(planExecuteBatchBodySchema),
    wrapAsync(
      async (req: Request<ProjectParams, unknown, { items: PlanExecuteBatchItem[] }>, res) => {
        const result = await enqueuePlanExecuteBatch(
          planService,
          req.params.projectId,
          req.body.items
        );
        const body: ApiResponse<{ batchId: string }> = { data: result };
        res.status(202).json(body);
      }
    )
  );

  // GET /projects/:projectId/plans/execute-batch/active — Running batch for this project, if any
  router.get(
    "/execute-batch/active",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const active = await getActivePlanExecuteBatch(req.params.projectId);
      const body: ApiResponse<PlanExecuteBatchStatus | null> = { data: active };
      res.json(body);
    })
  );

  // GET /projects/:projectId/plans/execute-batch/:batchId — Poll batch status
  router.get(
    "/execute-batch/:batchId",
    validateParams(planExecuteBatchParamsSchema),
    wrapAsync(async (req: Request<ProjectParams & { batchId: string }>, res) => {
      const status = await getPlanExecuteBatchStatus(req.params.projectId, req.params.batchId);
      if (!status) {
        res.status(404).json({
          error: {
            code: "NOT_FOUND",
            message: "Execute batch not found",
          },
        });
        return;
      }
      const body: ApiResponse<PlanExecuteBatchStatus> = { data: status };
      res.json(body);
    })
  );

  // GET /projects/:projectId/plans/:planId/cross-epic-dependencies — Prerequisites still in Planning
  router.get(
    "/:planId/cross-epic-dependencies",
    validateParams(planIdParamSchema),
    wrapAsync(async (req: Request<PlanParams>, res) => {
      const result = await planService.getCrossEpicDependencies(
        req.params.projectId,
        req.params.planId
      );
      const body: ApiResponse<CrossEpicDependenciesResponse> = { data: result };
      res.json(body);
    })
  );

  // GET /projects/:projectId/plans/:planId/hierarchy — Sub-plan tree (bulk-loaded; 404 if plan missing)
  router.get(
    "/:planId/hierarchy",
    validateParams(planIdParamSchema),
    wrapAsync(async (req: Request<PlanParams>, res) => {
      const data = await planService.getPlanHierarchy(req.params.projectId, req.params.planId);
      const body: ApiResponse<PlanHierarchyResponse> = { data };
      res.json(body);
    })
  );

  // GET /projects/:projectId/plans/:planId/auditor-runs — List Auditor runs for a plan (plan-centric lookup)
  router.get(
    "/:planId/auditor-runs",
    validateParams(planIdParamSchema),
    wrapAsync(async (req: Request<PlanParams>, res) => {
      const runs = await taskStore.listAuditorRunsByPlanId(req.params.projectId, req.params.planId);
      const body: ApiResponse<typeof runs> = { data: runs };
      res.json(body);
    })
  );

  // POST /projects/:projectId/plans/:planId/mark-complete — Mark plan complete (set reviewedAt when all tasks closed)
  // Registered before generic :planId so /mark-complete is not captured as a planId
  router.post(
    "/:planId/mark-complete",
    validateParams(planIdParamSchema),
    wrapAsync(async (req: Request<PlanParams>, res) => {
      const plan = await planService.markPlanComplete(req.params.projectId, req.params.planId);
      const body: ApiResponse<Plan> = { data: plan };
      res.json(body);
    })
  );

  type VersionParams = PlanParams & { versionNumber: string };

  // GET /projects/:projectId/plans/:planId/versions — List plan versions (newest first).
  // When the plan has no versions (first load), create version 1 from current content so UI and execute flow are consistent.
  router.get(
    "/:planId/versions",
    validateParams(planIdParamSchema),
    wrapAsync(async (req: Request<PlanParams>, res) => {
      await planService.getPlan(req.params.projectId, req.params.planId);
      await planService.ensurePlanHasAtLeastOneVersion(req.params.projectId, req.params.planId);
      const list = await taskStore.listPlanVersions(req.params.projectId, req.params.planId);
      const versions = list.map((v) => ({
        id: v.id,
        version_number: v.version_number,
        created_at: v.created_at,
        is_executed_version: v.is_executed_version,
      }));
      const body: ApiResponse<{ versions: typeof versions }> = { data: { versions } };
      res.json(body);
    })
  );

  // GET /projects/:projectId/plans/:planId/versions/:versionNumber — Get plan version by number
  router.get(
    "/:planId/versions/:versionNumber",
    validateParams(planVersionParamsSchema),
    wrapAsync(async (req: Request<VersionParams>, res) => {
      await planService.getPlan(req.params.projectId, req.params.planId);
      const versionNum = parseInt(req.params.versionNumber, 10);
      if (Number.isNaN(versionNum) || versionNum < 1) {
        res.status(404).json({
          error: {
            code: "PLAN_VERSION_NOT_FOUND",
            message: `Plan version ${req.params.versionNumber} not found`,
          },
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
    })
  );

  // GET /projects/:projectId/plans/:planId — Get Plan details
  router.get(
    "/:planId",
    validateParams(planIdParamSchema),
    wrapAsync(async (req: Request<PlanParams>, res) => {
      const plan = await planService.getPlan(req.params.projectId, req.params.planId);
      const body: ApiResponse<Plan> = { data: plan };
      res.json(body);
    })
  );

  // PUT /projects/:projectId/plans/:planId — Update Plan markdown
  router.put(
    "/:planId",
    validateParams(planIdParamSchema),
    validateBody(createPlanBodySchema),
    wrapAsync(async (req: Request<PlanParams>, res) => {
      const plan = await planService.updatePlan(req.params.projectId, req.params.planId, req.body);
      const body: ApiResponse<Plan> = { data: plan };
      res.json(body);
    })
  );

  // POST /projects/:projectId/plans/:planId/plan-tasks — Plan Tasks (create epic if missing, then AI-generate tasks).
  // On success, `data` includes optional `totalTasksCreated`, `failedPlanIds`, and `successPlanIds` when useful (recursive sub-plans).
  router.post(
    "/:planId/plan-tasks",
    validateParams(planIdParamSchema),
    wrapAsync(async (req: Request<PlanParams>, res) => {
      const plan = await runDurableRequest(
        req.params.projectId,
        "plan.tasks",
        req.params.planId,
        {},
        () => planService.planTasks(req.params.projectId, req.params.planId)
      );
      const body: ApiResponse<Plan> = { data: plan };
      res.json(body);
    })
  );

  // POST /projects/:projectId/plans/:planId/execute — Execute! (approve Plan for execution)
  // Optional body: { prerequisitePlanIds?: string[]; version_number?: number }
  // If version_number provided, run ship with that version's content and set as last_executed.
  router.post(
    "/:planId/execute",
    validateParams(planIdParamSchema),
    validateBody(planExecuteBodySchema),
    wrapAsync(
      async (
        req: Request<
          PlanParams,
          unknown,
          { prerequisitePlanIds?: string[]; version_number?: number }
        >,
        res
      ) => {
        const prerequisitePlanIds = req.body.prerequisitePlanIds ?? [];
        const version_number = req.body.version_number;
        const options = version_number != null ? { version_number } : undefined;
        const plan = await runDurableRequest(
          req.params.projectId,
          "plan.execute",
          req.params.planId,
          req.body,
          async () =>
            prerequisitePlanIds.length > 0
              ? await planService.shipPlanWithPrerequisites(
                  req.params.projectId,
                  req.params.planId,
                  prerequisitePlanIds,
                  options
                )
              : await planService.shipPlan(req.params.projectId, req.params.planId, options)
        );
        for (const updatedPlanId of new Set([req.params.planId, ...prerequisitePlanIds])) {
          broadcastToProject(req.params.projectId, {
            type: "plan.updated",
            planId: updatedPlanId,
          });
        }
        // Nudge orchestrator to pick up newly-available tasks (PRDv2 §5.7 event-driven dispatch)
        orchestratorService.nudge(req.params.projectId);
        const body: ApiResponse<Plan> = { data: plan };
        res.json(body);
      }
    )
  );

  // POST /projects/:projectId/plans/:planId/re-execute — Re-execute an updated Plan
  // Optional body: { version_number?: number }. Else uses last_executed_version_number for version content.
  router.post(
    "/:planId/re-execute",
    validateParams(planIdParamSchema),
    validateBody(planReexecuteBodySchema),
    wrapAsync(async (req: Request<PlanParams, unknown, { version_number?: number }>, res) => {
      const version_number = req.body.version_number;
      const options = version_number != null ? { version_number } : undefined;
      const plan = await runDurableRequest(
        req.params.projectId,
        "plan.reexecute",
        req.params.planId,
        req.body,
        () => planService.reshipPlan(req.params.projectId, req.params.planId, options)
      );
      broadcastToProject(req.params.projectId, {
        type: "plan.updated",
        planId: req.params.planId,
      });
      // Nudge orchestrator to pick up newly-available tasks (PRDv2 §5.7 event-driven dispatch)
      orchestratorService.nudge(req.params.projectId);
      const body: ApiResponse<Plan> = { data: plan };
      res.json(body);
    })
  );

  // POST /projects/:projectId/plans/:planId/archive — Archive plan (close all ready/open tasks)
  router.post(
    "/:planId/archive",
    validateParams(planIdParamSchema),
    wrapAsync(async (req: Request<PlanParams>, res) => {
      const plan = await planService.archivePlan(req.params.projectId, req.params.planId);
      const body: ApiResponse<Plan> = { data: plan };
      res.json(body);
    })
  );

  // DELETE /projects/:projectId/plans/:planId — Delete plan from database
  router.delete(
    "/:planId",
    validateParams(planIdParamSchema),
    wrapAsync(async (req: Request<PlanParams>, res) => {
      await planService.deletePlan(req.params.projectId, req.params.planId);
      res.status(204).send();
    })
  );

  return router;
}
