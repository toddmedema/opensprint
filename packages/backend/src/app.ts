import path from "path";
import fs from "fs/promises";
import { randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import { localhostCors } from "./middleware/cors.js";
import { errorHandler } from "./middleware/error-handler.js";
import { apiErrorNotificationMiddleware } from "./middleware/api-error-notification.js";
import { createProjectsRouter } from "./routes/projects.js";
import { createPrdRouter } from "./routes/prd.js";
import { createPlansRouter } from "./routes/plans.js";
import { createChatRouter } from "./routes/chat.js";
import { createExecuteRouter } from "./routes/execute.js";
import { createDeliverRouter } from "./routes/deliver.js";
import { createAgentsRouter } from "./routes/agents.js";
import { createTasksRouter } from "./routes/tasks.js";
import { createAppServices, type AppServices } from "./composition.js";
import { createFeedbackRouter } from "./routes/feedback.js";
import {
  createProjectNotificationsRouter,
  createGlobalNotificationsRouter,
} from "./routes/notifications.js";
import { fsRouter } from "./routes/fs.js";
import { modelsRouter } from "./routes/models.js";
import { envRouter } from "./routes/env.js";
import { wsUpgradeTicketRouter } from "./routes/ws-upgrade-ticket.js";
import { globalSettingsRouter } from "./routes/global-settings.js";
import { helpRouter } from "./routes/help.js";
import { dbStatusRouter } from "./routes/db-status.js";
import { createTodoistIntegrationRouter } from "./routes/integrations-todoist.js";
import { createGitHubIntegrationRouter } from "./routes/integrations-github.js";
import { createIntakeRouter } from "./routes/intake.js";
import { createCommandsRouter } from "./routes/commands.js";
import { createCollaborationRouter } from "./routes/collaboration.js";
import { createSpecPublicationRouter } from "./routes/spec-publication.js";
import { integrationStore } from "./services/integration-store.service.js";
import { tokenEncryption } from "./services/token-encryption.service.js";
import { intakeIngestion } from "./services/intake-ingestion.service.js";
import "./services/adapters/index.js";
import { API_PREFIX } from "@opensprint/shared";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { wrapAsync } from "./middleware/wrap-async.js";
import { requireDatabase } from "./middleware/require-database.js";
import { orchestratorService } from "./services/orchestrator.service.js";
import { projectAccess } from "./middleware/project-access.js";
import { createIdentityRouter, createMembershipRouter } from "./routes/identity.js";
import { createRuntimeRouter } from "./routes/runtime-state.js";
import { identityService } from "./services/identity.service.js";
import { getDeploymentMode, validateDeploymentMode } from "./services/deployment-mode.js";
import {
  getLocalSessionToken,
  ensureLocalSessionToken,
} from "./services/local-session-auth.service.js";
import { buildSpaContentSecurityPolicyProduction } from "@opensprint/shared";
import { allowDesktopLocalSessionScriptRequest } from "./desktop-local-session-guard.js";
import { agentChatService } from "./services/agent-chat.service.js";
import { AppError } from "./middleware/error-handler.js";
import { executionOwnershipService } from "./services/execution-ownership.service.js";

export function createApp(services?: AppServices) {
  validateDeploymentMode();
  ensureLocalSessionToken();
  const app = express();
  const svc = services ?? createAppServices();
  const {
    taskService,
    projectService,
    planService,
    prdService,
    chatService,
    feedbackService,
    agentInstructionsService,
    sessionManager,
  } = svc;

  app.use(localhostCors);
  app.use(express.json({ limit: "10mb" }));
  app.use(requestIdMiddleware);

  // Health check (no auth — must remain before the API auth gate)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.use(`${API_PREFIX}/auth`, createIdentityRouter());
  // Collaboration resolves the same authenticated project identity as the other
  // APIs, with read/discuss/control authorization inside its command routes.
  app.use(
    `${API_PREFIX}/projects/:projectId/collaboration`,
    requireDatabase,
    createCollaborationRouter({
      access: {
        resolve: (authorization, projectId) => identityService.resolve(authorization, projectId),
        canControlActor: async (projectId, actorId) => {
          try {
            return (await identityService.member(actorId, projectId)).permissions.includes(
              "control"
            );
          } catch {
            return false;
          }
        },
      },
      assertProjectExists: (projectId) => projectService.getProject(projectId),
      getActiveRun: async (projectId, taskId) => {
        const local = agentChatService.getActiveRun(projectId, taskId);
        if (local) return local;
        const runs = await executionOwnershipService.observe(projectId, taskId);
        const current = runs
          .filter((run) => ["queued", "running", "stop_requested", "uncertain"].includes(run.state))
          .sort((a, b) => b.generation - a.generation)[0];
        return current
          ? {
              ...current,
              attempt: current.generation,
              supported: false,
              backend: "isolated",
              reason:
                "This isolated worker supports durable stop requests; live between-turn guidance is unavailable.",
            }
          : null;
      },
      getGuidanceHistory: async (projectId, taskId) =>
        (await agentChatService.getHistory(projectId, taskId)).slice(-200),
      handleGuidance: async (input) => {
        const active = agentChatService.getActiveRun(input.projectId, input.taskId);
        if (!active || active.attemptId !== input.attemptId)
          throw new AppError(
            409,
            "AGENT_ATTEMPT_CHANGED",
            "The active attempt changed. Refresh before sending guidance."
          );
        return agentChatService.sendMessage(
          input.projectId,
          input.taskId,
          input.content,
          active.attempt,
          { clientMessageId: input.clientMessageId, actorId: input.actorId }
        );
      },
    })
  );

  // Other API routes require the local installation's Bearer token.
  app.use(API_PREFIX, projectAccess);
  app.use(`${API_PREFIX}/projects/:projectId/members`, requireDatabase, createMembershipRouter());
  app.use(`${API_PREFIX}/projects/:projectId/runtime`, requireDatabase, createRuntimeRouter());

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
  app.use(`${API_PREFIX}/ws-upgrade-ticket`, wsUpgradeTicketRouter);
  app.use(`${API_PREFIX}/env`, envRouter);
  app.use(`${API_PREFIX}/global-settings`, globalSettingsRouter);
  app.use(`${API_PREFIX}/help`, requireDatabase, helpRouter);
  app.use(`${API_PREFIX}/projects/:projectId/plan-status`, requireDatabase);
  app.use(`${API_PREFIX}/projects`, createProjectsRouter(projectService, planService));
  app.use(
    `${API_PREFIX}/projects/:projectId/prd`,
    requireDatabase,
    createPrdRouter({ prdService, chatService })
  );
  app.use(
    `${API_PREFIX}/projects/:projectId/plans`,
    requireDatabase,
    createPlansRouter(planService)
  );
  app.use(
    `${API_PREFIX}/projects/:projectId/chat`,
    requireDatabase,
    createChatRouter({ chatService })
  );
  app.use(
    `${API_PREFIX}/projects/:projectId/execute`,
    requireDatabase,
    createExecuteRouter(projectService, sessionManager)
  );
  app.use(
    `${API_PREFIX}/projects/:projectId/deliver`,
    requireDatabase,
    createDeliverRouter(projectService)
  );
  app.use(
    `${API_PREFIX}/projects/:projectId/agents`,
    requireDatabase,
    createAgentsRouter({ projectService, orchestratorService, agentInstructionsService })
  );
  app.use(
    `${API_PREFIX}/projects/:projectId/tasks`,
    requireDatabase,
    createTasksRouter(taskService)
  );
  app.use(
    `${API_PREFIX}/projects/:projectId/feedback`,
    requireDatabase,
    createFeedbackRouter({ feedbackService, orchestratorService })
  );
  app.use(
    `${API_PREFIX}/projects/:projectId/integrations/todoist`,
    requireDatabase,
    createTodoistIntegrationRouter({ integrationStore, tokenEncryption })
  );
  app.use(
    `${API_PREFIX}/projects/:projectId/integrations/github`,
    requireDatabase,
    createGitHubIntegrationRouter({ integrationStore, tokenEncryption, intakeIngestion })
  );
  app.use(`${API_PREFIX}/projects/:projectId/intake`, requireDatabase, createIntakeRouter());
  app.use(`${API_PREFIX}/projects/:projectId/commands`, requireDatabase, createCommandsRouter());
  app.use(
    `${API_PREFIX}/projects/:projectId/publication`,
    requireDatabase,
    createSpecPublicationRouter()
  );
  app.use(
    `${API_PREFIX}/projects/:projectId/notifications`,
    requireDatabase,
    createProjectNotificationsRouter({ projectService, orchestratorService })
  );
  app.use(`${API_PREFIX}/notifications`, requireDatabase, createGlobalNotificationsRouter());
  app.use(`${API_PREFIX}/fs`, fsRouter);

  // Desktop mode: serve built frontend and SPA fallback (after all API routes so /api and /ws are untouched)
  if (process.env.OPENSPRINT_DESKTOP === "1" || process.env.OPENSPRINT_FRONTEND_DIST) {
    const frontendDist = process.env.OPENSPRINT_FRONTEND_DIST;
    if (frontendDist) {
      const sendDesktopSpaIndexHtml = async (req: Request, res: Response) => {
        if (
          getDeploymentMode() === "trusted-local" &&
          !allowDesktopLocalSessionScriptRequest(req)
        ) {
          res
            .status(403)
            .setHeader("Cache-Control", "no-store")
            .type("text/plain")
            .send("Forbidden");
          return;
        }
        const indexPath = path.join(frontendDist, "index.html");
        const html = await fs.readFile(indexPath, "utf8");
        const token = getLocalSessionToken();
        const nonce = randomBytes(16).toString("base64url");
        const spaCsp = buildSpaContentSecurityPolicyProduction({
          desktopSessionScriptNonce: nonce,
        });
        const inject = `<script nonce="${nonce}">window.__OPENSPRINT_LOCAL_SESSION__=${JSON.stringify(token)};</script>`;
        const body =
          getDeploymentMode() !== "trusted-local"
            ? html.replace("</head>", '<meta name="opensprint-shared-host" content="true"></head>')
            : html.includes("</head>")
              ? html.replace("</head>", `${inject}</head>`)
              : `${inject}${html}`;
        res.setHeader("Content-Security-Policy", spaCsp);
        res.setHeader("Cache-Control", "no-store");
        res.type("html").send(body);
      };

      app.get("/__opensprint_local_session.js", (req, res) => {
        if (
          getDeploymentMode() !== "trusted-local" ||
          !allowDesktopLocalSessionScriptRequest(req)
        ) {
          res
            .status(403)
            .setHeader("Cache-Control", "no-store")
            .type("text/plain")
            .send("Forbidden");
          return;
        }
        const token = getLocalSessionToken();
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.send(`window.__OPENSPRINT_LOCAL_SESSION__=${JSON.stringify(token)};`);
      });

      app.get(
        "/",
        wrapAsync(async (req, res) => sendDesktopSpaIndexHtml(req, res))
      );
      app.get(
        "/index.html",
        wrapAsync(async (req, res) => sendDesktopSpaIndexHtml(req, res))
      );

      app.use(
        express.static(frontendDist, {
          index: false,
        })
      );

      app.get(
        "*",
        wrapAsync(async (req, res, next) => {
          if (req.path.startsWith("/api/") || req.path.startsWith("/ws")) {
            next();
            return;
          }
          try {
            await sendDesktopSpaIndexHtml(req, res);
          } catch (err) {
            next(err);
          }
        })
      );
    }
  }

  // Error handling: API-error notification middleware runs first (creates human-blocked notifications)
  app.use(apiErrorNotificationMiddleware);
  app.use(errorHandler);

  return app;
}
