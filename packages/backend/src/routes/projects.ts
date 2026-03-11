import { Router, Request } from "express";
import { wrapAsync } from "../middleware/wrap-async.js";
import { ProjectService } from "../services/project.service.js";
import { PlanService } from "../services/plan.service.js";
import { orchestratorService } from "../services/orchestrator.service.js";
import { taskStore } from "../services/task-store.service.js";
import type {
  CreateProjectRequest,
  ApiResponse,
  Project,
  ScaffoldProjectRequest,
  ScaffoldProjectResponse,
} from "@opensprint/shared";
import { createLogger } from "../utils/logger.js";

const log = createLogger("projects");
const projectService = new ProjectService();
const planService = new PlanService();

export const projectsRouter = Router();

type ProjectParams = { id: string };

/** Normalize Express param to string (params.id can be string | string[]). */
function getProjectId(req: Request): string {
  const id = req.params.id;
  return Array.isArray(id) ? id[0] ?? "" : id ?? "";
}

// GET /projects — List all projects
projectsRouter.get(
  "/",
  wrapAsync(async (_req, res) => {
    const projects = await projectService.listProjects();
    const body: ApiResponse<Project[]> = { data: projects };
    res.json(body);
  })
);

// POST /projects — Create a new project
projectsRouter.post(
  "/",
  wrapAsync(async (req, res) => {
    const request = req.body as CreateProjectRequest;
    const project = await projectService.createProject(request);
    const body: ApiResponse<Project> = { data: project };
    res.status(201).json(body);
  })
);

// POST /projects/scaffold — Scaffold new project from template (Create New wizard)
projectsRouter.post(
  "/scaffold",
  wrapAsync(async (req, res) => {
    const request = req.body as ScaffoldProjectRequest;
    const result = await projectService.scaffoldProject(request);
    const body: ApiResponse<ScaffoldProjectResponse> = { data: result };
    res.status(201).json(body);
  })
);

// GET /projects/:id/sketch — Sketch phase resource (returns project; chat/prd under /chat, /prd)
projectsRouter.get(
  "/:id/sketch",
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    const project = await projectService.getProject(req.params.id);
    const body: ApiResponse<Project> = { data: project };
    res.json(body);
  })
);

// GET /projects/:id/plan-status — Plan it / Replan it CTA visibility (PRD §7.1.5)
projectsRouter.get(
  "/:id/plan-status",
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    const status = await planService.getPlanStatus(req.params.id);
    res.json({ data: status });
  })
);

// GET /projects/:id/sketch-context — Sketch empty-state: hasExistingCode for "Generate from codebase" visibility
projectsRouter.get(
  "/:id/sketch-context",
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    const hasExistingCode = await planService.hasExistingCode(req.params.id);
    res.json({ data: { hasExistingCode } });
  })
);

// GET /projects/:id/self-improvement/history — List recent self-improvement runs (timestamp, status, tasksCreatedCount)
projectsRouter.get(
  "/:id/self-improvement/history",
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    const projectId = req.params.id;
    await projectService.getProject(projectId);
    const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
    const runs = await taskStore.listSelfImprovementRunHistory(projectId, limit);
    const data = runs.map((r) => ({
      timestamp: r.timestamp,
      status: r.status,
      tasksCreatedCount: r.tasksCreatedCount,
      ...(r.runId && { runId: r.runId }),
    }));
    res.json({ data });
  })
);

// GET /projects/:id — Get project details
projectsRouter.get(
  "/:id",
  wrapAsync(async (req, res) => {
    const project = await projectService.getProject(getProjectId(req));
    const body: ApiResponse<Project> = { data: project };
    res.json(body);
  })
);

// PUT /projects/:id — Update project
projectsRouter.put(
  "/:id",
  wrapAsync(async (req, res) => {
    const projectId = getProjectId(req);
    const { project, repoPathChanged } = await projectService.updateProject(
      projectId,
      req.body
    );

    // When repoPath changes, restart the orchestrator so it operates on the new directory.
    // Await ensureRunning so the orchestrator is fully initialized before responding;
    // otherwise subsequent requests may hit the old directory or a half-ready state.
    if (repoPathChanged) {
      log.info("repoPath changed, restarting orchestrator", { projectId });
      orchestratorService.stopProject(projectId);
      await orchestratorService.ensureRunning(projectId);
    }

    const body: ApiResponse<Project> = { data: project };
    res.json(body);
  })
);

// POST /projects/:id/archive — Archive project (remove from UI only, keep data)
projectsRouter.post(
  "/:id/archive",
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    const projectId = req.params.id;
    orchestratorService.stopProject(projectId);
    await projectService.archiveProject(projectId);
    res.status(204).send();
  })
);

// DELETE /projects/:id — Delete project (remove from UI and delete .opensprint directory)
projectsRouter.delete(
  "/:id",
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    const projectId = req.params.id;
    orchestratorService.stopProject(projectId);
    await projectService.deleteProject(projectId);
    res.status(204).send();
  })
);

// GET /projects/:id/settings — Get project settings (apiKeys not included; stored in global settings only)
projectsRouter.get(
  "/:id/settings",
  wrapAsync(async (req, res) => {
    const settings = await projectService.getSettingsWithRuntimeState(getProjectId(req));
    res.json({ data: settings });
  })
);

// PUT /projects/:id/settings — Update project settings (apiKeys not accepted; use global settings)
projectsRouter.put(
  "/:id/settings",
  wrapAsync(async (req, res) => {
    const projectId = getProjectId(req);
    const { apiKeys: _omit, ...bodyWithoutApiKeys } = req.body as Record<string, unknown>;
    const settings = await projectService.updateSettings(projectId, bodyWithoutApiKeys);
    await orchestratorService.refreshMaxSlotsAndNudge(projectId);
    res.json({ data: settings });
  })
);
