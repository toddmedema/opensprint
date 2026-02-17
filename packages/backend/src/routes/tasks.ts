import { Router, Request } from 'express';
import { TaskService } from '../services/task.service.js';
import type { ApiResponse, Task, AgentSession } from '@opensprint/shared';

const taskService = new TaskService();

export const tasksRouter = Router({ mergeParams: true });

type ProjectParams = { projectId: string };
type TaskParams = { projectId: string; taskId: string };
type SessionParams = { projectId: string; taskId: string; attempt: string };

// GET /projects/:projectId/tasks — List all tasks
tasksRouter.get('/', async (req: Request<ProjectParams>, res, next) => {
  try {
    const tasks = await taskService.listTasks(req.params.projectId);
    const body: ApiResponse<Task[]> = { data: tasks };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/tasks/ready — Get ready tasks
tasksRouter.get('/ready', async (req: Request<ProjectParams>, res, next) => {
  try {
    const tasks = await taskService.getReadyTasks(req.params.projectId);
    const body: ApiResponse<Task[]> = { data: tasks };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/tasks/:taskId/unblock — Unblock task (set beads status to open)
tasksRouter.post('/:taskId/unblock', async (req: Request<TaskParams>, res, next) => {
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
tasksRouter.post('/:taskId/done', async (req: Request<TaskParams>, res, next) => {
  try {
    const result = await taskService.markDone(req.params.projectId, req.params.taskId);
    const body: ApiResponse<{ taskClosed: boolean; epicClosed?: boolean }> = { data: result };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/tasks/:taskId — Get task details
tasksRouter.get('/:taskId', async (req: Request<TaskParams>, res, next) => {
  try {
    const task = await taskService.getTask(req.params.projectId, req.params.taskId);
    const body: ApiResponse<Task> = { data: task };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/tasks/:taskId/sessions — Get agent sessions
tasksRouter.get('/:taskId/sessions', async (req: Request<TaskParams>, res, next) => {
  try {
    const sessions = await taskService.getTaskSessions(req.params.projectId, req.params.taskId);
    const body: ApiResponse<AgentSession[]> = { data: sessions };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/tasks/:taskId/sessions/:attempt — Get specific session
tasksRouter.get('/:taskId/sessions/:attempt', async (req: Request<SessionParams>, res, next) => {
  try {
    const session = await taskService.getTaskSession(
      req.params.projectId,
      req.params.taskId,
      parseInt(req.params.attempt, 10),
    );
    const body: ApiResponse<AgentSession> = { data: session };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
