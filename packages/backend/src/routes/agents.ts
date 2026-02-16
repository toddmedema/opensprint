import { Router, Request } from 'express';
import type { ApiResponse, ActiveAgent } from '@opensprint/shared';
import { orchestratorService } from '../services/orchestrator.service.js';

export const agentsRouter = Router({ mergeParams: true });

type ProjectParams = { projectId: string };

// GET /projects/:projectId/agents/active — List active agents (Build phase from orchestrator)
agentsRouter.get('/active', async (req: Request<ProjectParams>, res, next) => {
  try {
    const agents: ActiveAgent[] = await orchestratorService.getActiveAgents(req.params.projectId);
    const body: ApiResponse<ActiveAgent[]> = { data: agents };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
