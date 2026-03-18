import { Router, Request } from "express";
import { wrapAsync } from "../middleware/wrap-async.js";
import { validateParams, validateBody, validateQuery } from "../middleware/validate.js";
import {
  projectIdParamSchema,
  createProjectBodySchema,
  scaffoldProjectBodySchema,
  updateProjectBodySchema,
  selfImprovementHistoryQuerySchema,
  updateSettingsBodySchema,
} from "../schemas/request-projects.js";
import type { ProjectService } from "../services/project.service.js";
import type { PlanService } from "../services/plan.service.js";
import { orchestratorService } from "../services/orchestrator.service.js";
import { selfImprovementService } from "../services/self-improvement.service.js";
import { taskStore } from "../services/task-store.service.js";
import type { ApiResponse, Project, ScaffoldProjectResponse } from "@opensprint/shared";
import { createLogger } from "../utils/logger.js";

const log = createLogger("projects");

export function createProjectsRouter(
  projectService: ProjectService,
  planService: PlanService
): Router {
  const router = Router();

  type ProjectParams = { id: string };

  /** Normalize Express param to string (params.id can be string | string[]). */
  function getProjectId(req: Request): string {
    const id = req.params.id;
    return Array.isArray(id) ? (id[0] ?? "") : (id ?? "");
  }

  // GET /projects — List all projects
  router.get(
    "/",
    wrapAsync(async (_req, res) => {
      const projects = await projectService.listProjects();
      const body: ApiResponse<Project[]> = { data: projects };
      res.json(body);
    })
  );

  // POST /projects — Create a new project
  router.post(
    "/",
    validateBody(createProjectBodySchema),
    wrapAsync(async (req, res) => {
      const project = await projectService.createProject(req.body);
      const body: ApiResponse<Project> = { data: project };
      res.status(201).json(body);
    })
  );

  // POST /projects/scaffold — Scaffold new project from template (Create New wizard)
  router.post(
    "/scaffold",
    validateBody(scaffoldProjectBodySchema),
    wrapAsync(async (req, res) => {
      const result = await projectService.scaffoldProject(req.body);
      const body: ApiResponse<ScaffoldProjectResponse> = { data: result };
      res.status(201).json(body);
    })
  );

  // GET /projects/:id/sketch — Sketch phase resource (returns project; chat/prd under /chat, /prd)
  router.get(
    "/:id/sketch",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const project = await projectService.getProject(req.params.id);
      const body: ApiResponse<Project> = { data: project };
      res.json(body);
    })
  );

  // GET /projects/:id/plan-status — Plan it / Replan it CTA visibility (PRD §7.1.5)
  router.get(
    "/:id/plan-status",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const status = await planService.getPlanStatus(req.params.id);
      res.json({ data: status });
    })
  );

  // GET /projects/:id/sketch-context — Sketch empty-state: hasExistingCode for "Generate from codebase" visibility
  router.get(
    "/:id/sketch-context",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const hasExistingCode = await planService.hasExistingCode(req.params.id);
      res.json({ data: { hasExistingCode } });
    })
  );

  // GET /projects/:id/self-improvement/history — List recent self-improvement runs (timestamp, status, tasksCreatedCount)
  router.get(
    "/:id/self-improvement/history",
    validateParams(projectIdParamSchema),
    validateQuery(selfImprovementHistoryQuerySchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const projectId = req.params.id;
      await projectService.getProject(projectId);
      const limit = (req.query as { limit?: number }).limit;
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

  // POST /projects/:id/self-improvement/run — Manually trigger one self-improvement check (same flow as scheduled run)
  router.post(
    "/:id/self-improvement/run",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const projectId = getProjectId(req);
      await projectService.getProject(projectId);
      const result = await selfImprovementService.run(projectId);
      res.json({ data: result });
    })
  );

  // GET /projects/:id — Get project details
  router.get(
    "/:id",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req, res) => {
      const project = await projectService.getProject(getProjectId(req));
      const body: ApiResponse<Project> = { data: project };
      res.json(body);
    })
  );

  // PUT /projects/:id — Update project
  router.put(
    "/:id",
    validateParams(projectIdParamSchema),
    validateBody(updateProjectBodySchema),
    wrapAsync(async (req, res) => {
      const projectId = getProjectId(req);
      const { project, repoPathChanged } = await projectService.updateProject(projectId, req.body);

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
  router.post(
    "/:id/archive",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const projectId = req.params.id;
      orchestratorService.stopProject(projectId);
      await projectService.archiveProject(projectId);
      res.status(204).send();
    })
  );

  // DELETE /projects/:id — Delete project (remove from UI and delete .opensprint directory)
  router.delete(
    "/:id",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req: Request<ProjectParams>, res) => {
      const projectId = req.params.id;
      orchestratorService.stopProject(projectId);
      await projectService.deleteProject(projectId);
      res.status(204).send();
    })
  );

  // GET /projects/:id/settings — Get project settings (apiKeys not included; stored in global settings only)
  router.get(
    "/:id/settings",
    validateParams(projectIdParamSchema),
    wrapAsync(async (req, res) => {
      const settings = await projectService.getSettingsWithRuntimeState(getProjectId(req));
      res.json({ data: settings });
    })
  );

  // PUT /projects/:id/settings — Update project settings (apiKeys not accepted; use global settings)
  router.put(
    "/:id/settings",
    validateParams(projectIdParamSchema),
    validateBody(updateSettingsBodySchema),
    wrapAsync(async (req, res) => {
      const projectId = getProjectId(req);
      const { apiKeys: _omit, ...bodyWithoutApiKeys } = req.body as Record<string, unknown>;
      const settings = await projectService.updateSettings(projectId, bodyWithoutApiKeys);
      await orchestratorService.refreshMaxSlotsAndNudge(projectId);
      res.json({ data: settings });
    })
  );

  return router;
}
