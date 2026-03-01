import { Router, Request } from "express";
import { orchestratorService } from "../services/orchestrator.service.js";
import type { TaskService } from "../services/task.service.js";
import { eventLogService, type OrchestratorEvent } from "../services/event-log.service.js";
import type { ProjectService } from "../services/project.service.js";
import type { ApiResponse, OrchestratorStatus } from "@opensprint/shared";

export function createExecuteRouter(
  taskService: TaskService,
  projectService: ProjectService
): Router {
  const router = Router({ mergeParams: true });

type ProjectParams = { projectId: string };
type PrepareParams = { projectId: string; taskId: string };

  // POST /projects/:projectId/execute/tasks/:taskId/prepare — Create task directory and prompt (PRD §12.2)
  router.post("/tasks/:taskId/prepare", async (req: Request<PrepareParams>, res, next) => {
  try {
    const { projectId, taskId } = req.params;
    const taskDir = await taskService.prepareTaskDirectory(projectId, taskId, {
      phase: (req.body?.phase as "coding" | "review") || "coding",
      createBranch: req.body?.createBranch !== false,
      attempt: req.body?.attempt ?? 1,
    });
    const body: ApiResponse<{ taskDir: string }> = { data: { taskDir } };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
  });

  // POST /projects/:projectId/execute/nudge — Event-driven dispatch trigger (PRDv2 §5.7)
  router.post("/nudge", async (req: Request<ProjectParams>, res, next) => {
  try {
    const { projectId } = req.params;
    orchestratorService.nudge(projectId);
    const status = await orchestratorService.getStatus(projectId);
    const body: ApiResponse<OrchestratorStatus> = { data: status };
    res.json(body);
  } catch (err) {
    next(err);
  }
  });

  // GET /projects/:projectId/execute/status — Get orchestrator status
  router.get("/status", async (req: Request<ProjectParams>, res, next) => {
  try {
    const status = await orchestratorService.getStatus(req.params.projectId);
    const body: ApiResponse<OrchestratorStatus> = { data: status };
    res.json(body);
  } catch (err) {
    next(err);
  }
  });

  // GET /projects/:projectId/execute/tasks/:taskId/output — Get live output for in-progress task (backfill)
  router.get("/tasks/:taskId/output", async (req: Request<PrepareParams>, res, next) => {
  try {
    const { projectId, taskId } = req.params;
    const output = await orchestratorService.getLiveOutput(projectId, taskId);
    const body: ApiResponse<{ output: string }> = { data: { output } };
    res.json(body);
  } catch (err) {
    next(err);
  }
  });

  // GET /projects/:projectId/execute/events — Query event log for debugging/audit
  router.get("/events", async (req: Request<ProjectParams>, res, next) => {
  try {
    const { projectId } = req.params;
    const repoPath = await projectService.getRepoPath(projectId);
    const since = req.query.since as string | undefined;
    const taskId = req.query.taskId as string | undefined;
    const count = req.query.count ? parseInt(req.query.count as string, 10) : undefined;

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
  } catch (err) {
    next(err);
  }
  });

  // POST /projects/:projectId/execute/pause — Pause orchestrator (placeholder; PRD §5.7 always-on)
  router.post("/pause", async (req: Request<ProjectParams>, res) => {
    res.status(501).json({
      error: {
        code: "NOT_IMPLEMENTED",
        message: "Pause not yet supported; orchestrator is always-on",
      },
    });
  });

  return router;
}
