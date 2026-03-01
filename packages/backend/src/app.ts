import express from "express";
import cors from "cors";
import { errorHandler } from "./middleware/error-handler.js";
import { apiErrorNotificationMiddleware } from "./middleware/api-error-notification.js";
import { projectsRouter } from "./routes/projects.js";
import { prdRouter } from "./routes/prd.js";
import { plansRouter } from "./routes/plans.js";
import { chatRouter } from "./routes/chat.js";
import { createExecuteRouter } from "./routes/execute.js";
import { deliverRouter } from "./routes/deliver.js";
import { agentsRouter } from "./routes/agents.js";
import { createTasksRouter } from "./routes/tasks.js";
import { createAppServices } from "./composition.js";
import { feedbackRouter } from "./routes/feedback.js";
import {
  projectNotificationsRouter,
  globalNotificationsRouter,
} from "./routes/notifications.js";
import { fsRouter } from "./routes/fs.js";
import { modelsRouter } from "./routes/models.js";
import { envRouter } from "./routes/env.js";
import { globalSettingsRouter } from "./routes/global-settings.js";
import { helpRouter } from "./routes/help.js";
import { API_PREFIX } from "@opensprint/shared";
import { requestIdMiddleware } from "./middleware/request-id.js";

export function createApp() {
  const app = express();
  const { taskService, projectService } = createAppServices();

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));
  app.use(requestIdMiddleware);

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // API routes
  app.use(`${API_PREFIX}/models`, modelsRouter);
  app.use(`${API_PREFIX}/env`, envRouter);
  app.use(`${API_PREFIX}/global-settings`, globalSettingsRouter);
  app.use(`${API_PREFIX}/help`, helpRouter);
  app.use(`${API_PREFIX}/projects`, projectsRouter);
  app.use(`${API_PREFIX}/projects/:projectId/prd`, prdRouter);
  app.use(`${API_PREFIX}/projects/:projectId/plans`, plansRouter);
  app.use(`${API_PREFIX}/projects/:projectId/chat`, chatRouter);
  app.use(`${API_PREFIX}/projects/:projectId/execute`, createExecuteRouter(taskService, projectService));
  app.use(`${API_PREFIX}/projects/:projectId/deliver`, deliverRouter);
  app.use(`${API_PREFIX}/projects/:projectId/agents`, agentsRouter);
  app.use(`${API_PREFIX}/projects/:projectId/tasks`, createTasksRouter(taskService));
  app.use(`${API_PREFIX}/projects/:projectId/feedback`, feedbackRouter);
  app.use(`${API_PREFIX}/projects/:projectId/notifications`, projectNotificationsRouter);
  app.use(`${API_PREFIX}/notifications`, globalNotificationsRouter);
  app.use(`${API_PREFIX}/fs`, fsRouter);

  // Error handling: API-error notification middleware runs first (creates human-blocked notifications)
  app.use(apiErrorNotificationMiddleware);
  app.use(errorHandler);

  return app;
}
