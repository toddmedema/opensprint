import { Router, Request } from "express";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateParams, validateBody, validateQuery } from "../middleware/validate.js";
import {
  projectIdParamSchema,
  taskIdParamSchema,
  executePrepareBodySchema,
  executeEventsQuerySchema,
  executeFailureMetricsQuerySchema,
} from "../schemas/request-common.js";
import { orchestratorService } from "../services/orchestrator.service.js";
import type { TaskService } from "../services/task.service.js";
import { eventLogService, type OrchestratorEvent } from "../services/event-log.service.js";
import type { ProjectService } from "../services/project.service.js";
import type { SessionManager } from "../services/session-manager.js";
import type {
  ApiResponse,
  FailureMetricsSummary,
  OrchestratorStatus,
  TaskExecutionDiagnostics,
} from "@opensprint/shared";
import { taskStore } from "../services/task-store.service.js";
import { TaskExecutionDiagnosticsService } from "../services/task-execution-diagnostics.service.js";
import {
  rollupOrchestratorEvents,
  resolveFailureMetricsWindow,
} from "../services/orchestrator-failure-metrics.service.js";

export function createExecuteRouter(
  taskService: TaskService,
  projectService: ProjectService,
  sessionManager: SessionManager
): Router {
  const router = Router({ mergeParams: true });
  const diagnosticsService = new TaskExecutionDiagnosticsService(
    projectService,
    taskStore,
    sessionManager
  );

  type ProjectParams = { projectId: string };
  type PrepareParams = { projectId: string; taskId: string };

  // POST /projects/:projectId/execute/tasks/:taskId/prepare — Create task directory and prompt (PRD §12.2)
  router.post(
    "/tasks/:taskId/prepare",
    validateParams(taskIdParamSchema),
    validateBody(executePrepareBodySchema),
    wrapAsync(async (req: Request<PrepareParams>, res) => {
      const { projectId, taskId } = req.params;
      const b = req.body as {
        phase?: "coding" | "review";
        createBranch?: boolean;
        attempt?: number;
      };
      const taskDir = await taskService.prepareTaskDirectory(projectId, taskId, {
        phase: b.phase ?? "coding",
        createBranch: b.createBranch !== false,
        attempt: b.attempt ?? 1,
      });
      const body: ApiResponse<{ taskDir: string }> = { data: { taskDir } };
      res.status(201).json(body);
    })
  );

  // POST /projects/:projectId/execute/nudge — Event-driven dispatch trigger (PRDv2 §5.7)
  router.post(
    "/nudge",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const { projectId } = req.params;
      orchestratorService.nudge(projectId);
      const status = await orchestratorService.getStatus(projectId);
      const body: ApiResponse<OrchestratorStatus> = { data: status };
      res.json(body);
    })
  );

  // GET /projects/:projectId/execute/status — Get orchestrator status
  router.get(
    "/status",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const status = await orchestratorService.getStatus(req.params.projectId);
      const body: ApiResponse<OrchestratorStatus> = { data: status };
      res.json(body);
    })
  );

  // GET /projects/:projectId/execute/tasks/:taskId/output — Get live output for in-progress task (backfill)
  router.get(
    "/tasks/:taskId/output",
    validateParams(taskIdParamSchema),
    wrapAsync(async (req: Request<PrepareParams>, res) => {
      const { projectId, taskId } = req.params;
      const output = await orchestratorService.getLiveOutput(projectId, taskId);
      const body: ApiResponse<{ output: string }> = { data: { output } };
      res.json(body);
    })
  );

  router.get(
    "/tasks/:taskId/diagnostics",
    validateParams(taskIdParamSchema),
    wrapAsync(async (req: Request<PrepareParams>, res) => {
      const { projectId, taskId } = req.params;
      const diagnostics = await diagnosticsService.getDiagnostics(projectId, taskId);
      const body: ApiResponse<TaskExecutionDiagnostics> = { data: diagnostics };
      res.json(body);
    })
  );

  // GET /projects/:projectId/execute/events — Query event log for debugging/audit
  router.get(
    "/events",
    validateParams(projectIdParamSchema),
    validateQuery(executeEventsQuerySchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const { projectId } = req.params;
      const repoPath = await projectService.getRepoPath(projectId);
      const { since, taskId, count } = req.query as {
        since?: string;
        taskId?: string;
        count?: number;
      };

      let events: OrchestratorEvent[];
      if (taskId) {
        events = await eventLogService.readForTask(repoPath, taskId);
      } else if (since) {
        events = await eventLogService.readSince(repoPath, since);
      } else {
        events = await eventLogService.readRecent(repoPath, count ?? 100);
      }

      const body: ApiResponse<OrchestratorEvent[]> = { data: events };
      res.json(body);
    })
  );

  // GET /projects/:projectId/execute/failure-metrics — Ranked orchestrator failure signatures (audit log)
  router.get(
    "/failure-metrics",
    validateParams(projectIdParamSchema),
    validateQuery(executeFailureMetricsQuerySchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const { projectId } = req.params;
      const q = req.query as { days?: number };
      const { sinceIso, untilIso } = resolveFailureMetricsWindow(q.days);
      const events = await eventLogService.readSinceByProjectId(projectId, sinceIso);
      const summary: FailureMetricsSummary = rollupOrchestratorEvents(
        projectId,
        sinceIso,
        untilIso,
        events
      );
      const body: ApiResponse<FailureMetricsSummary> = { data: summary };
      res.json(body);
    })
  );

  // POST /projects/:projectId/execute/pause — Pause orchestrator (placeholder; PRD §5.7 always-on)
  router.post(
    "/pause",
    validateParams(projectIdParamSchema),
    wrapAsync(async (_req: Request<ProjectParams>, res) => {
      res.status(501).json({
        error: {
          code: "NOT_IMPLEMENTED",
          message: "Pause not yet supported; orchestrator is always-on",
        },
      });
    })
  );

  return router;
}
