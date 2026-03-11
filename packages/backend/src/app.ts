import path from "path";
import express from "express";
import cors from "cors";
import { errorHandler } from "./middleware/error-handler.js";
import { apiErrorNotificationMiddleware } from "./middleware/api-error-notification.js";
import { createProjectsRouter } from "./routes/projects.js";
import { prdRouter } from "./routes/prd.js";
import { createPlansRouter } from "./routes/plans.js";
import { chatRouter } from "./routes/chat.js";
import { createExecuteRouter } from "./routes/execute.js";
import { createDeliverRouter } from "./routes/deliver.js";
import { agentsRouter } from "./routes/agents.js";
import { createTasksRouter } from "./routes/tasks.js";
import { createTasksAnalyticsRouter } from "./routes/tasks-analytics.js";
import { createAppServices, type AppServices } from "./composition.js";
import { feedbackRouter } from "./routes/feedback.js";
import { projectNotificationsRouter, globalNotificationsRouter } from "./routes/notifications.js";
import { fsRouter } from "./routes/fs.js";
import { modelsRouter } from "./routes/models.js";
import { envRouter } from "./routes/env.js";
import { globalSettingsRouter } from "./routes/global-settings.js";
import { helpRouter } from "./routes/help.js";
import { dbStatusRouter } from "./routes/db-status.js";
import { API_PREFIX } from "@opensprint/shared";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { wrapAsync } from "./middleware/wrap-async.js";
import { requireDatabase } from "./middleware/require-database.js";
import { orchestratorService } from "./services/orchestrator.service.js";

export function createApp(services?: AppServices) {
  const app = express();
  const svc = services ?? createAppServices();
  const { taskService, projectService, planService, sessionManager } = svc;

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));
  app.use(requestIdMiddleware);

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // API routes (global agents count for desktop tray; must be before /projects so :projectId does not capture "agents")
  // Uses same logic as UI: list projects, then getActiveAgents(projectId) per project and sum (orchestrator + planning agents).
  app.get(
    `${API_PREFIX}/agents/active-count`,
    wrapAsync(async (_req, res) => {
      const projects = await projectService.listProjects();
      let count = 0;
      for (const p of projects) {
        try {
          const agents = await orchestratorService.getActiveAgents(p.id);
          count += agents.length;
        } catch {
          // Skip project if getActiveAgents fails (e.g. project no longer valid)
        }
      }
      res.json({ data: { count } });
    })
  );

  app.use(`${API_PREFIX}/db-status`, dbStatusRouter);
  app.use(`${API_PREFIX}/models`, modelsRouter);
  app.use(`${API_PREFIX}/env`, envRouter);
  app.use(`${API_PREFIX}/tasks`, createTasksAnalyticsRouter(taskService));
  app.use(`${API_PREFIX}/global-settings`, globalSettingsRouter);
  app.use(`${API_PREFIX}/help`, requireDatabase, helpRouter);
  app.use(`${API_PREFIX}/projects/:projectId/plan-status`, requireDatabase);
  app.use(`${API_PREFIX}/projects`, createProjectsRouter(projectService, planService));
  app.use(`${API_PREFIX}/projects/:projectId/prd`, requireDatabase, prdRouter);
  app.use(`${API_PREFIX}/projects/:projectId/plans`, requireDatabase, createPlansRouter(planService));
  app.use(`${API_PREFIX}/projects/:projectId/chat`, requireDatabase, chatRouter);
  app.use(
    `${API_PREFIX}/projects/:projectId/execute`,
    requireDatabase,
    createExecuteRouter(taskService, projectService, sessionManager)
  );
  app.use(`${API_PREFIX}/projects/:projectId/deliver`, requireDatabase, createDeliverRouter(projectService));
  app.use(`${API_PREFIX}/projects/:projectId/agents`, requireDatabase, agentsRouter);
  app.use(
    `${API_PREFIX}/projects/:projectId/tasks`,
    requireDatabase,
    createTasksRouter(taskService)
  );
  app.use(`${API_PREFIX}/projects/:projectId/feedback`, requireDatabase, feedbackRouter);
  app.use(
    `${API_PREFIX}/projects/:projectId/notifications`,
    requireDatabase,
    projectNotificationsRouter
  );
  app.use(`${API_PREFIX}/notifications`, requireDatabase, globalNotificationsRouter);
  app.use(`${API_PREFIX}/fs`, fsRouter);

  // Desktop mode: serve built frontend and SPA fallback (after all API routes so /api and /ws are untouched)
  if (process.env.OPENSPRINT_DESKTOP === "1") {
    const frontendDist = process.env.OPENSPRINT_FRONTEND_DIST;
    if (frontendDist) {
      app.use(express.static(frontendDist));
      app.get("*", (_req, res) => {
        res.sendFile(path.join(frontendDist, "index.html"));
      });
    }
  }

  // Error handling: API-error notification middleware runs first (creates human-blocked notifications)
  app.use(apiErrorNotificationMiddleware);
  app.use(errorHandler);

  return app;
}
