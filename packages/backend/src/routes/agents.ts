import { Router, Request } from "express";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateParams, validateBody } from "../middleware/validate.js";
import {
  projectIdParamSchema,
  agentRoleParamsSchema,
  agentKillParamsSchema,
  agentInstructionsBodySchema,
} from "../schemas/request-common.js";
import type { ApiResponse, ActiveAgent, AgentRole } from "@opensprint/shared";
import { orchestratorService } from "../services/orchestrator.service.js";
import { ProjectService } from "../services/project.service.js";
import { agentInstructionsService } from "../services/agent-instructions.service.js";

export const agentsRouter = Router({ mergeParams: true });

const projectService = new ProjectService();

type ProjectParams = { projectId: string };
type RoleParams = ProjectParams & { role: string };
type KillParams = ProjectParams & { agentId: string };

// GET /projects/:projectId/agents/instructions — Read AGENTS.md
agentsRouter.get(
  "/instructions",
  validateParams(projectIdParamSchema),
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    await projectService.getProject(req.params.projectId);
    const content = await agentInstructionsService.getGeneralInstructions(req.params.projectId);
    const body: ApiResponse<{ content: string }> = { data: { content } };
    res.json(body);
  })
);

// PUT /projects/:projectId/agents/instructions — Write AGENTS.md
agentsRouter.put(
  "/instructions",
  validateParams(projectIdParamSchema),
  validateBody(agentInstructionsBodySchema),
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    await projectService.getProject(req.params.projectId);
    await agentInstructionsService.setGeneralInstructions(req.params.projectId, req.body.content);
    res.status(200).json({ data: { saved: true } });
  })
);

// GET /projects/:projectId/agents/instructions/:role — Read DB-backed role instructions
agentsRouter.get(
  "/instructions/:role",
  validateParams(agentRoleParamsSchema),
  wrapAsync(async (req: Request<RoleParams>, res) => {
    await projectService.getProject(req.params.projectId);
    const content = await agentInstructionsService.getRoleInstructions(
      req.params.projectId,
      req.params.role as AgentRole
    );
    const body: ApiResponse<{ content: string }> = { data: { content } };
    res.json(body);
  })
);

// PUT /projects/:projectId/agents/instructions/:role — Write DB-backed role instructions
agentsRouter.put(
  "/instructions/:role",
  validateParams(agentRoleParamsSchema),
  validateBody(agentInstructionsBodySchema),
  wrapAsync(async (req: Request<RoleParams>, res) => {
    await projectService.getProject(req.params.projectId);
    await agentInstructionsService.setRoleInstructions(
      req.params.projectId,
      req.params.role as AgentRole,
      req.body.content
    );
    res.status(200).json({ data: { saved: true } });
  })
);

// GET /projects/:projectId/agents/active — List active agents (Build phase from orchestrator)
agentsRouter.get(
  "/active",
  validateParams(projectIdParamSchema),
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    const agents: ActiveAgent[] = await orchestratorService.getActiveAgents(req.params.projectId);
    const body: ApiResponse<ActiveAgent[]> = { data: agents };
    res.json(body);
  })
);

// POST /projects/:projectId/agents/:agentId/kill — Terminate agent process (Execute phase only)
agentsRouter.post(
  "/:agentId/kill",
  validateParams(agentKillParamsSchema),
  wrapAsync(async (req: Request<KillParams>, res) => {
    const { projectId, agentId } = req.params;
    const killed = await orchestratorService.killAgent(projectId, agentId);
    if (!killed) {
      res.status(404).json({ error: "Agent not found or not killable" });
      return;
    }
    res.status(200).json({ data: { killed: true } });
  })
);
