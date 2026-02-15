import { Router, Request } from 'express';
import type { ApiResponse, ActiveAgent } from '@opensprint/shared';

export const agentsRouter = Router({ mergeParams: true });

type ProjectParams = { projectId: string };

// GET /projects/:projectId/agents/active — List active agents (stub until opensprint.dev-brz)
agentsRouter.get('/active', async (req: Request<ProjectParams>, res, next) => {
  try {
    const body: ApiResponse<ActiveAgent[]> = { data: [] };
    res.json(body);
  } catch (err) {
    next(err);
  }
});
