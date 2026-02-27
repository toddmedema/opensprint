import { Router, Request } from "express";
import { TaskService } from "../services/task.service.js";
import type { ApiResponse, Task, AgentSession } from "@opensprint/shared";
import { createLogger } from "../utils/logger.js";

const log = createLogger("tasks");
const taskService = new TaskService();

export const tasksRouter = Router({ mergeParams: true });

type ProjectParams = { projectId: string };
type TaskParams = { projectId: string; taskId: string };
type SessionParams = { projectId: string; taskId: string; attempt: string };

// GET /projects/:projectId/tasks — List all tasks (supports ?limit=&offset= for pagination)
tasksRouter.get("/", async (req: Request<ProjectParams>, res, next) => {
  try {
    const limit = req.query.limit != null ? parseInt(String(req.query.limit), 10) : undefined;
    const offset = req.query.offset != null ? parseInt(String(req.query.offset), 10) : undefined;
    const options =
      limit != null && offset != null && !Number.isNaN(limit) && !Number.isNaN(offset)
        ? { limit, offset }
        : undefined;

    const result = await taskService.listTasks(req.params.projectId, options);
    const body: ApiResponse<Task[] | { items: Task[]; total: number }> = { data: result };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/tasks/ready — Get ready tasks
tasksRouter.get("/ready", async (req: Request<ProjectParams>, res, next) => {
  try {
    const tasks = await taskService.getReadyTasks(req.params.projectId);
    const body: ApiResponse<Task[]> = { data: tasks };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/tasks/:taskId/unblock — Unblock task (set task status to open)
tasksRouter.post("/:taskId/unblock", async (req: Request<TaskParams>, res, next) => {
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
});

// POST /projects/:projectId/tasks/:taskId/done — Manually mark task done (and epic if last)
tasksRouter.post("/:taskId/done", async (req: Request<TaskParams>, res, next) => {
  try {
    const result = await taskService.markDone(req.params.projectId, req.params.taskId);
    const body: ApiResponse<{ taskClosed: boolean; epicClosed?: boolean }> = { data: result };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/tasks/:taskId/dependencies — Add dependency (child depends on parent)
tasksRouter.post("/:taskId/dependencies", async (req: Request<TaskParams>, res, next) => {
  try {
    const { parentTaskId, type } = req.body ?? {};
    if (typeof parentTaskId !== "string" || !parentTaskId.trim()) {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "parentTaskId is required" },
      });
    }
    const depType =
      type === "blocks" || type === "parent-child" || type === "related"
        ? type
        : "blocks";
    await taskService.addDependency(
      req.params.projectId,
      req.params.taskId,
      parentTaskId.trim(),
      depType
    );
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// PATCH /projects/:projectId/tasks/:taskId — Update task (e.g. priority)
tasksRouter.patch("/:taskId", async (req: Request<TaskParams>, res, next) => {
  try {
    const { priority } = req.body ?? {};
    if (typeof priority !== "number" || priority < 0 || priority > 4) {
      return res.status(400).json({
        error: { code: "BAD_REQUEST", message: "priority must be a number 0–4" },
      });
    }
    const task = await taskService.updatePriority(
      req.params.projectId,
      req.params.taskId,
      priority
    );
    const body: ApiResponse<Task> = { data: task };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/tasks/:taskId — Get task details
tasksRouter.get("/:taskId", async (req: Request<TaskParams>, res, next) => {
  const start = performance.now();
  try {
    const task = await taskService.getTask(req.params.projectId, req.params.taskId);
    const durationMs = Math.round(performance.now() - start);
    res.set("Server-Timing", `task-detail;dur=${durationMs};desc="Task detail load"`);
    if (durationMs > 500) {
      log.warn("GET /:taskId slow", { durationMs, taskId: req.params.taskId });
    }
    const body: ApiResponse<Task> = { data: task };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/tasks/:taskId/sessions — Get agent sessions
tasksRouter.get("/:taskId/sessions", async (req: Request<TaskParams>, res, next) => {
  try {
    const sessions = await taskService.getTaskSessions(req.params.projectId, req.params.taskId);
    const body: ApiResponse<AgentSession[]> = { data: sessions };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/tasks/:taskId/sessions/:attempt — Get specific session
tasksRouter.get("/:taskId/sessions/:attempt", async (req: Request<SessionParams>, res, next) => {
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
