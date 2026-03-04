import { Router, Request } from "express";
import path from "path";
import fs from "fs/promises";
import type { ApiResponse, ActiveAgent } from "@opensprint/shared";
import { AGENT_ROLE_CANONICAL_ORDER, OPENSPRINT_PATHS } from "@opensprint/shared";
import type { AgentRole } from "@opensprint/shared";
import { orchestratorService } from "../services/orchestrator.service.js";
import { ProjectService } from "../services/project.service.js";

export const agentsRouter = Router({ mergeParams: true });

const projectService = new ProjectService();

type ProjectParams = { projectId: string };
type RoleParams = ProjectParams & { role: string };
type KillParams = ProjectParams & { agentId: string };

function isValidRole(role: string): role is AgentRole {
  return (AGENT_ROLE_CANONICAL_ORDER as readonly string[]).includes(role);
}

// GET /projects/:projectId/agents/instructions — Read AGENTS.md
agentsRouter.get("/instructions", async (req: Request<ProjectParams>, res, next) => {
  try {
    const project = await projectService.getProject(req.params.projectId);
    const filePath = path.join(project.repoPath, "AGENTS.md");
    let content = "";
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    const body: ApiResponse<{ content: string }> = { data: { content } };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// PUT /projects/:projectId/agents/instructions — Write AGENTS.md
agentsRouter.put("/instructions", async (req: Request<ProjectParams>, res, next) => {
  try {
    if (req.body?.content === undefined) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "content is required", details: undefined },
      });
      return;
    }
    const project = await projectService.getProject(req.params.projectId);
    const filePath = path.join(project.repoPath, "AGENTS.md");
    await fs.writeFile(filePath, String(req.body.content), "utf-8");
    res.status(200).json({ data: { saved: true } });
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/agents/instructions/:role — Read .opensprint/agents/<role>.md
agentsRouter.get("/instructions/:role", async (req: Request<RoleParams>, res, next) => {
  try {
    if (!isValidRole(req.params.role)) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: `Invalid role. Must be one of: ${AGENT_ROLE_CANONICAL_ORDER.join(", ")}`,
          details: undefined,
        },
      });
      return;
    }
    const project = await projectService.getProject(req.params.projectId);
    const filePath = path.join(project.repoPath, OPENSPRINT_PATHS.agents, `${req.params.role}.md`);
    let content = "";
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
    const body: ApiResponse<{ content: string }> = { data: { content } };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// PUT /projects/:projectId/agents/instructions/:role — Write .opensprint/agents/<role>.md
agentsRouter.put("/instructions/:role", async (req: Request<RoleParams>, res, next) => {
  try {
    if (!isValidRole(req.params.role)) {
      res.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: `Invalid role. Must be one of: ${AGENT_ROLE_CANONICAL_ORDER.join(", ")}`,
          details: undefined,
        },
      });
      return;
    }
    if (req.body?.content === undefined) {
      res.status(400).json({
        error: { code: "VALIDATION_ERROR", message: "content is required", details: undefined },
      });
      return;
    }
    const project = await projectService.getProject(req.params.projectId);
    const agentsDir = path.join(project.repoPath, OPENSPRINT_PATHS.agents);
    await fs.mkdir(agentsDir, { recursive: true });
    const filePath = path.join(agentsDir, `${req.params.role}.md`);
    await fs.writeFile(filePath, String(req.body.content), "utf-8");
    res.status(200).json({ data: { saved: true } });
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/agents/active — List active agents (Build phase from orchestrator)
agentsRouter.get("/active", async (req: Request<ProjectParams>, res, next) => {
  try {
    const agents: ActiveAgent[] = await orchestratorService.getActiveAgents(req.params.projectId);
    const body: ApiResponse<ActiveAgent[]> = { data: agents };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/agents/:agentId/kill — Terminate agent process (Execute phase only)
agentsRouter.post("/:agentId/kill", async (req: Request<KillParams>, res, next) => {
  try {
    const { projectId, agentId } = req.params;
    const killed = await orchestratorService.killAgent(projectId, agentId);
    if (!killed) {
      res.status(404).json({ error: "Agent not found or not killable" });
      return;
    }
    res.status(200).json({ data: { killed: true } });
  } catch (err) {
    next(err);
  }
});
