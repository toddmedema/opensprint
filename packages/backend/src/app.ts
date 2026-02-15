import express from "express";
import cors from "cors";
import { errorHandler } from "./middleware/error-handler.js";
import { authRouter } from "./routes/auth.js";
import { projectsRouter } from "./routes/projects.js";
import { prdRouter } from "./routes/prd.js";
import { plansRouter } from "./routes/plans.js";
import { chatRouter } from "./routes/chat.js";
import { buildRouter } from "./routes/build.js";
import { agentsRouter } from "./routes/agents.js";
import { tasksRouter } from "./routes/tasks.js";
import { feedbackRouter } from "./routes/feedback.js";
import { fsRouter } from "./routes/fs.js";
import { modelsRouter } from "./routes/models.js";
import { envRouter } from "./routes/env.js";
import { API_PREFIX } from "@opensprint/shared";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // API routes
  app.use(`${API_PREFIX}/auth`, authRouter);
  app.use(`${API_PREFIX}/models`, modelsRouter);
  app.use(`${API_PREFIX}/env`, envRouter);
  app.use(`${API_PREFIX}/projects`, projectsRouter);
  app.use(`${API_PREFIX}/projects/:projectId/prd`, prdRouter);
  app.use(`${API_PREFIX}/projects/:projectId/plans`, plansRouter);
  app.use(`${API_PREFIX}/projects/:projectId/chat`, chatRouter);
  app.use(`${API_PREFIX}/projects/:projectId/build`, buildRouter);
  app.use(`${API_PREFIX}/projects/:projectId/agents`, agentsRouter);
  app.use(`${API_PREFIX}/projects/:projectId/tasks`, tasksRouter);
  app.use(`${API_PREFIX}/projects/:projectId/feedback`, feedbackRouter);
  app.use(`${API_PREFIX}/fs`, fsRouter);

  // Error handling
  app.use(errorHandler);

  return app;
}
