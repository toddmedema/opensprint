import { Router, Request } from 'express';
import { OrchestratorService } from '../services/orchestrator.service.js';
import { TaskService } from '../services/task.service.js';
import type { ApiResponse, OrchestratorStatus } from '@opensprint/shared';

const orchestratorService = new OrchestratorService();
const taskService = new TaskService();

export const buildRouter = Router({ mergeParams: true });

type ProjectParams = { projectId: string };
type PrepareParams = { projectId: string; taskId: string };

// POST /projects/:projectId/build/tasks/:taskId/prepare — Create task directory and prompt (PRD §12.2)
buildRouter.post('/tasks/:taskId/prepare', async (req: Request<PrepareParams>, res, next) => {
  try {
    const { projectId, taskId } = req.params;
    const taskDir = await taskService.prepareTaskDirectory(projectId, taskId, {
      phase: (req.body?.phase as 'coding' | 'review') || 'coding',
      createBranch: req.body?.createBranch !== false,
      attempt: req.body?.attempt ?? 1,
    });
    const body: ApiResponse<{ taskDir: string }> = { data: { taskDir } };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/build/start — Start the build orchestrator
buildRouter.post('/start', async (req: Request<ProjectParams>, res, next) => {
  try {
    const status = await orchestratorService.start(req.params.projectId);
    const body: ApiResponse<OrchestratorStatus> = { data: status };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/build/pause — Pause the build orchestrator
buildRouter.post('/pause', async (req: Request<ProjectParams>, res, next) => {
  try {
    const status = await orchestratorService.pause(req.params.projectId);
    const body: ApiResponse<OrchestratorStatus> = { data: status };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/build/status — Get orchestrator status
buildRouter.get('/status', async (req: Request<ProjectParams>, res, next) => {
  try {
    const status = await orchestratorService.getStatus(req.params.projectId);
    const body: ApiResponse<OrchestratorStatus> = { data: status };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
