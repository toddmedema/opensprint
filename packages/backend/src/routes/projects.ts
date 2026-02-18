import { Router, Request } from "express";
import { ProjectService } from "../services/project.service.js";
import { PlanService } from "../services/plan.service.js";
import { orchestratorService } from "../services/orchestrator.service.js";
import type { CreateProjectRequest, ApiResponse, Project } from "@opensprint/shared";

const projectService = new ProjectService();
const planService = new PlanService();

export const projectsRouter = Router();

type ProjectParams = { id: string };

// GET /projects — List all projects
projectsRouter.get("/", async (_req, res, next) => {
  try {
    const projects = await projectService.listProjects();
    const body: ApiResponse<Project[]> = { data: projects };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects — Create a new project
projectsRouter.post("/", async (req, res, next) => {
  try {
    const request = req.body as CreateProjectRequest;
    const project = await projectService.createProject(request);
    const body: ApiResponse<Project> = { data: project };
    res.status(201).json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:id/spec — 301 redirect to sketch (backwards compatibility, one version cycle)
projectsRouter.get("/:id/spec", (req: Request<ProjectParams>, res) => {
  res.redirect(301, `${req.baseUrl}/${req.params.id}/sketch`);
});

// GET /projects/:id/sketch — Sketch phase resource (returns project; chat/prd under /chat, /prd)
projectsRouter.get("/:id/sketch", async (req: Request<ProjectParams>, res, next) => {
  try {
    const project = await projectService.getProject(req.params.id);
    const body: ApiResponse<Project> = { data: project };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:id/plan-status — Plan it / Replan it CTA visibility (PRD §7.1.5)
projectsRouter.get("/:id/plan-status", async (req: Request<ProjectParams>, res, next) => {
  try {
    const status = await planService.getPlanStatus(req.params.id);
    res.json({ data: status });
  } catch (err) {
    next(err);
  }
});

// GET /projects/:id — Get project details
projectsRouter.get("/:id", async (req, res, next) => {
  try {
    const project = await projectService.getProject(req.params.id);
    const body: ApiResponse<Project> = { data: project };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// PUT /projects/:id — Update project
projectsRouter.put("/:id", async (req, res, next) => {
  try {
    const { project, repoPathChanged } = await projectService.updateProject(req.params.id, req.body);

    // When repoPath changes, restart the orchestrator so it operates on the new directory.
    // Await ensureRunning so the orchestrator is fully initialized before responding;
    // otherwise subsequent requests may hit the old directory or a half-ready state.
    if (repoPathChanged) {
      const projectId = req.params.id;
      console.log(`[projects] repoPath changed for ${projectId}, restarting orchestrator`);
      orchestratorService.stopProject(projectId);
      await orchestratorService.ensureRunning(projectId);
    }

    const body: ApiResponse<Project> = { data: project };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// DELETE /projects/:id — Delete a project
projectsRouter.delete("/:id", async (req, res, next) => {
  try {
    await projectService.deleteProject(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// GET /projects/:id/settings — Get project settings
projectsRouter.get("/:id/settings", async (req, res, next) => {
  try {
    const settings = await projectService.getSettings(req.params.id);
    res.json({ data: settings });
  } catch (err) {
    next(err);
  }
});

// PUT /projects/:id/settings — Update project settings
projectsRouter.put("/:id/settings", async (req, res, next) => {
  try {
    const settings = await projectService.updateSettings(req.params.id, req.body);
    res.json({ data: settings });
  } catch (err) {
    next(err);
  }
});
