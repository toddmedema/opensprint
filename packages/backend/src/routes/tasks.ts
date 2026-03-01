import { Router, Request } from "express";
import type { TaskService } from "../services/task.service.js";
import type { ApiResponse, Task, AgentSession } from "@opensprint/shared";
import { createLogger } from "../utils/logger.js";
import {
  projectIdParamSchema,
  taskIdParamSchema,
  paginationQuerySchema,
  taskPatchBodySchema,
  dependencyBodySchema,
} from "../schemas/request-common.js";
import { validateParams, validateQuery, validateBody } from "../middleware/validate.js";

const log = createLogger("tasks");

export function createTasksRouter(taskService: TaskService): Router {
  const router = Router({ mergeParams: true });

type ProjectParams = { projectId: string };
type TaskParams = { projectId: string; taskId: string };
type SessionParams = { projectId: string; taskId: string; attempt: string };

  // GET /projects/:projectId/tasks — List all tasks (supports ?limit=&offset= for pagination)
  router.get(
  "/",
  validateParams(projectIdParamSchema),
  validateQuery(paginationQuerySchema),
  async (req: Request<ProjectParams>, res, next) => {
    const start = performance.now();
    try {
      const { limit, offset } = req.query as { limit?: number; offset?: number };
      const options =
        limit != null && offset != null ? { limit, offset } : undefined;

      const result = await taskService.listTasks(req.params.projectId, options);
    const durationMs = Math.round(performance.now() - start);
    res.set("Server-Timing", `list;dur=${durationMs};desc="Task list"`);
    log.info("GET / list", {
      requestId: req.requestId,
      projectId: req.params.projectId,
      durationMs,
    });
    const body: ApiResponse<Task[] | { items: Task[]; total: number }> = { data: result };
    res.json(body);
  } catch (err) {
    next(err);
  }
  }
);

// GET /projects/:projectId/tasks/ready — Get ready tasks
  router.get(
  "/ready",
  validateParams(projectIdParamSchema),
  async (req: Request<ProjectParams>, res, next) => {
  try {
    const tasks = await taskService.getReadyTasks(req.params.projectId);
    const body: ApiResponse<Task[]> = { data: tasks };
    res.json(body);
  } catch (err) {
    next(err);
  }
  }
);

// POST /projects/:projectId/tasks/:taskId/unblock — Unblock task (set task status to open)
  router.post(
  "/:taskId/unblock",
  validateParams(taskIdParamSchema),
  async (req: Request<TaskParams>, res, next) => {
  try {
    const resetAttempts = req.body?.resetAttempts === true;
    const result = await taskService.unblock(req.params.projectId, req.params.taskId, {
      resetAttempts,
    });
    const body: ApiResponse<{ taskUnblocked: boolean }> = { data: result };
    res.json(body);
  } catch (err) {
    next(err);
  }
  }
);

// POST /projects/:projectId/tasks/:taskId/done — Manually mark task done (and epic if last)
  router.post(
  "/:taskId/done",
  validateParams(taskIdParamSchema),
  async (req: Request<TaskParams>, res, next) => {
  try {
    const result = await taskService.markDone(req.params.projectId, req.params.taskId);
    const body: ApiResponse<{ taskClosed: boolean; epicClosed?: boolean }> = { data: result };
    res.json(body);
  } catch (err) {
    next(err);
  }
  });

  // POST /projects/:projectId/tasks/:taskId/dependencies — Add dependency (child depends on parent)
  router.post(
  "/:taskId/dependencies",
  validateParams(taskIdParamSchema),
  validateBody(dependencyBodySchema),
  async (req: Request<TaskParams>, res, next) => {
  try {
    const { parentTaskId, type } = req.body as { parentTaskId: string; type: "blocks" | "parent-child" | "related" };
    await taskService.addDependency(
      req.params.projectId,
      req.params.taskId,
      parentTaskId,
      type
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
  }
);

// PATCH /projects/:projectId/tasks/:taskId — Update task (priority, complexity)
  router.patch(
  "/:taskId",
  validateParams(taskIdParamSchema),
  validateBody(taskPatchBodySchema),
  async (req: Request<TaskParams>, res, next) => {
  try {
    const { priority, complexity } = req.body as { priority?: number; complexity?: number };
    const updates: { priority?: number; complexity?: number } = {};
    if (priority !== undefined) updates.priority = priority;
    if (complexity !== undefined) updates.complexity = complexity;
    const task = await taskService.updateTask(
      req.params.projectId,
      req.params.taskId,
      updates
    );
    const body: ApiResponse<Task> = { data: task };
    res.json(body);
  } catch (err) {
    next(err);
  }
  }
);

// GET /projects/:projectId/tasks/:taskId — Get task details
  router.get(
  "/:taskId",
  validateParams(taskIdParamSchema),
  async (req: Request<TaskParams>, res, next) => {
  const start = performance.now();
  try {
    const task = await taskService.getTask(req.params.projectId, req.params.taskId);
    const durationMs = Math.round(performance.now() - start);
    res.set("Server-Timing", `task-detail;dur=${durationMs};desc="Task detail load"`);
    log.info("GET /:taskId", {
      requestId: req.requestId,
      projectId: req.params.projectId,
      taskId: req.params.taskId,
      durationMs,
    });
    if (durationMs > 500) {
      log.warn("GET /:taskId slow", {
        requestId: req.requestId,
        projectId: req.params.projectId,
        durationMs,
        taskId: req.params.taskId,
      });
    }
    const body: ApiResponse<Task> = { data: task };
    res.json(body);
  } catch (err) {
    next(err);
  }
  }
);

// GET /projects/:projectId/tasks/:taskId/sessions — Get agent sessions
  router.get(
  "/:taskId/sessions",
  validateParams(taskIdParamSchema),
  async (req: Request<TaskParams>, res, next) => {
  try {
    const sessions = await taskService.getTaskSessions(req.params.projectId, req.params.taskId);
    const body: ApiResponse<AgentSession[]> = { data: sessions };
    res.json(body);
  } catch (err) {
    next(err);
  }
  }
);

  // GET /projects/:projectId/tasks/:taskId/sessions/:attempt — Get specific session
  router.get("/:taskId/sessions/:attempt", async (req: Request<SessionParams>, res, next) => {
    try {
      const session = await taskService.getTaskSession(
        req.params.projectId,
        req.params.taskId,
        parseInt(req.params.attempt, 10)
      );
      const body: ApiResponse<AgentSession> = { data: session };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
