import { Router, Request } from "express";
import type { TaskService } from "../services/task.service.js";
import type { ApiResponse, Task, AgentSession } from "@opensprint/shared";
import { createLogger } from "../utils/logger.js";
import {
  projectIdParamSchema,
  taskIdParamSchema,
  taskDependencyParamsSchema,
  sessionParamsSchema,
  paginationQuerySchema,
  taskPatchBodySchema,
  dependencyBodySchema,
  unblockBodySchema,
  chatAttemptQuerySchema,
} from "../schemas/request-common.js";
import { validateParams, validateQuery, validateBody } from "../middleware/validate.js";
import { wrapAsync } from "../middleware/wrap-async.js";
import { resolveOpenEditor, type OpenEditorResult } from "../services/open-editor.service.js";
import { agentChatService } from "../services/agent-chat.service.js";

const log = createLogger("tasks");

export function createTasksRouter(taskService: TaskService): Router {
  const router = Router({ mergeParams: true });

  type ProjectParams = { projectId: string };
  type TaskParams = { projectId: string; taskId: string };
  type TaskDependencyParams = { projectId: string; taskId: string; parentTaskId: string };
  type SessionParams = { projectId: string; taskId: string; attempt: string };

  // GET /projects/:projectId/tasks — List all tasks (supports ?limit=&offset= for pagination)
  router.get(
    "/",
    validateParams(projectIdParamSchema),
    validateQuery(paginationQuerySchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const start = performance.now();
      const { limit, offset } = req.query as { limit?: number; offset?: number };
      const options = limit != null && offset != null ? { limit, offset } : undefined;

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
    })
  );

  // GET /projects/:projectId/tasks/ready — Get ready tasks
  router.get(
    "/ready",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const tasks = await taskService.getReadyTasks(req.params.projectId);
      const body: ApiResponse<Task[]> = { data: tasks };
      res.json(body);
    })
  );

  // POST /projects/:projectId/tasks/:taskId/unblock — Unblock task (set task status to open)
  router.post(
    "/:taskId/unblock",
    validateParams(taskIdParamSchema),
    validateBody(unblockBodySchema),
    wrapAsync(async (req: Request<TaskParams>, res) => {
      const resetAttempts = req.body.resetAttempts === true;
      const result = await taskService.unblock(req.params.projectId, req.params.taskId, {
        resetAttempts,
      });
      const body: ApiResponse<{ taskUnblocked: boolean }> = { data: result };
      res.json(body);
    })
  );

  // POST /projects/:projectId/tasks/:taskId/force-retry — Force-retry a task (kill agent, clean state, reset to open)
  router.post(
    "/:taskId/force-retry",
    validateParams(taskIdParamSchema),
    wrapAsync(async (req: Request<TaskParams>, res) => {
      const task = await taskService.forceRetry(req.params.projectId, req.params.taskId);
      const body: ApiResponse<Task> = { data: task };
      res.json(body);
    })
  );

  // POST /projects/:projectId/tasks/:taskId/done — Manually mark task done (and epic if last)
  router.post(
    "/:taskId/done",
    validateParams(taskIdParamSchema),
    wrapAsync(async (req: Request<TaskParams>, res) => {
      const result = await taskService.markDone(req.params.projectId, req.params.taskId);
      const body: ApiResponse<{ taskClosed: boolean; epicClosed?: boolean }> = { data: result };
      res.json(body);
    })
  );

  // DELETE /projects/:projectId/tasks/:taskId — Delete task with cascading reference cleanup
  router.delete(
    "/:taskId",
    validateParams(taskIdParamSchema),
    wrapAsync(async (req: Request<TaskParams>, res) => {
      const result = await taskService.deleteTask(req.params.projectId, req.params.taskId);
      const body: ApiResponse<{ taskDeleted: boolean }> = { data: result };
      res.json(body);
    })
  );

  // POST /projects/:projectId/tasks/:taskId/dependencies — Add dependency (child depends on parent)
  router.post(
    "/:taskId/dependencies",
    validateParams(taskIdParamSchema),
    validateBody(dependencyBodySchema),
    wrapAsync(async (req: Request<TaskParams>, res) => {
      const { parentTaskId, type } = req.body as {
        parentTaskId: string;
        type: "blocks" | "parent-child" | "related";
      };
      await taskService.addDependency(req.params.projectId, req.params.taskId, parentTaskId, type);
      res.status(204).send();
    })
  );

  // DELETE /projects/:projectId/tasks/:taskId/dependencies/:parentTaskId — Remove dependency
  router.delete(
    "/:taskId/dependencies/:parentTaskId",
    validateParams(taskDependencyParamsSchema),
    wrapAsync(async (req: Request<TaskDependencyParams>, res) => {
      await taskService.removeDependency(
        req.params.projectId,
        req.params.taskId,
        req.params.parentTaskId
      );
      res.status(204).send();
    })
  );

  // PATCH /projects/:projectId/tasks/:taskId — Update task (priority, complexity)
  router.patch(
    "/:taskId",
    validateParams(taskIdParamSchema),
    validateBody(taskPatchBodySchema),
    wrapAsync(async (req: Request<TaskParams>, res) => {
      const { priority, complexity, assignee } = req.body as {
        priority?: number;
        complexity?: number;
        assignee?: string | null;
      };
      const updates: { priority?: number; complexity?: number; assignee?: string | null } = {};
      if (priority !== undefined) updates.priority = priority;
      if (complexity !== undefined) updates.complexity = complexity;
      if (assignee !== undefined) updates.assignee = assignee;
      const task = await taskService.updateTask(req.params.projectId, req.params.taskId, updates);
      const body: ApiResponse<Task> = { data: task };
      res.json(body);
    })
  );

  // Register all GET /:taskId/... routes before GET /:taskId so paths like …/chat-support are never
  // mistaken for a task id (defensive across Express / path-to-regexp versions).

  // GET /projects/:projectId/tasks/:taskId/sessions — Get agent sessions
  router.get(
    "/:taskId/sessions",
    validateParams(taskIdParamSchema),
    wrapAsync(async (req: Request<TaskParams>, res) => {
      const sessions = await taskService.getTaskSessions(req.params.projectId, req.params.taskId);
      const body: ApiResponse<AgentSession[]> = { data: sessions };
      res.json(body);
    })
  );

  // GET /projects/:projectId/tasks/:taskId/sessions/:attempt — Get specific session
  router.get(
    "/:taskId/sessions/:attempt",
    validateParams(sessionParamsSchema),
    wrapAsync(async (req: Request<SessionParams>, res) => {
      const session = await taskService.getTaskSession(
        req.params.projectId,
        req.params.taskId,
        parseInt(req.params.attempt, 10)
      );
      const body: ApiResponse<AgentSession> = { data: session };
      res.json(body);
    })
  );

  // GET /projects/:projectId/tasks/:taskId/chat-history — Chat messages for the current or specified attempt
  router.get(
    "/:taskId/chat-history",
    validateParams(taskIdParamSchema),
    validateQuery(chatAttemptQuerySchema),
    wrapAsync(async (req: Request<TaskParams>, res) => {
      const { projectId, taskId } = req.params;
      const attemptParam = (req.query as { attempt?: number }).attempt;

      let messages;
      let attempt: number;

      if (attemptParam !== undefined) {
        messages = await agentChatService.getHistory(projectId, taskId, attemptParam);
        attempt = attemptParam;
      } else {
        const allMessages = await agentChatService.getHistory(projectId, taskId);
        attempt = allMessages.length > 0 ? Math.max(...allMessages.map((m) => m.attempt)) : 1;
        messages = allMessages.filter((m) => m.attempt === attempt);
      }

      const support = agentChatService.supportsChat(taskId, req.params.projectId);

      res.json({
        data: { messages, attempt, chatSupported: support.supported },
      });
    })
  );

  // GET /projects/:projectId/tasks/:taskId/chat-support — Whether the active agent backend supports live chat
  router.get(
    "/:taskId/chat-support",
    validateParams(taskIdParamSchema),
    wrapAsync(async (req: Request<TaskParams>, res) => {
      const { taskId } = req.params;
      const support = agentChatService.supportsChat(taskId, req.params.projectId);

      res.json({
        data: {
          supported: support.supported,
          backend: support.backend,
          reason: support.reason,
        },
      });
    })
  );

  // GET /projects/:projectId/tasks/:taskId — Get task details
  router.get(
    "/:taskId",
    validateParams(taskIdParamSchema),
    wrapAsync(async (req: Request<TaskParams>, res) => {
      const start = performance.now();
      const task = await taskService.getTask(req.params.projectId, req.params.taskId);
      const durationMs = Math.round(performance.now() - start);
      res.set("Server-Timing", `task-detail;dur=${durationMs};desc="Task detail load"`);
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
    })
  );

  // POST /projects/:projectId/tasks/:taskId/open-editor — Resolve worktree path and editor for opening in desktop editor
  router.post(
    "/:taskId/open-editor",
    validateParams(taskIdParamSchema),
    wrapAsync(async (req: Request<TaskParams>, res) => {
      const { projectId, taskId } = req.params;
      const result: OpenEditorResult = await resolveOpenEditor(projectId, taskId);
      const body: ApiResponse<OpenEditorResult> = { data: result };
      res.json(body);
    })
  );

  return router;
}
