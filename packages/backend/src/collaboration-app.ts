import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler, type Router } from "express";
import { API_PREFIX, buildSpaContentSecurityPolicyProduction } from "@opensprint/shared";
import type { AppServices } from "./composition.js";
import { createCollaborationRouter } from "./routes/collaboration.js";
import { CollaborationTaskContextService } from "./services/collaboration-task-context.service.js";
import { taskStore } from "./services/task-store.service.js";
import { orchestratorService } from "./services/orchestrator.service.js";
import { agentChatService } from "./services/agent-chat.service.js";
import { AppError, errorHandler } from "./middleware/error-handler.js";
import { requireDatabase } from "./middleware/require-database.js";
import { wrapAsync } from "./middleware/wrap-async.js";
import { createLogger } from "./utils/logger.js";
import { getApiPort } from "./utils/api-port.js";

const log = createLogger("collaboration-guest");

export interface CollaborationSharingConfig {
  port: number;
  origin: string;
  frontendDist: string;
}

/** Explicit, separate guest listener. Never turn the desktop bootstrap into a public endpoint. */
export function getCollaborationSharingConfig(
  environment: NodeJS.ProcessEnv = process.env
): CollaborationSharingConfig | null {
  const rawPort = environment.OPENSPRINT_COLLABORATION_PORT;
  const rawOrigin = environment.OPENSPRINT_COLLABORATION_ORIGIN;
  if (!rawPort && !rawOrigin) return null;
  if (!rawPort || !/^\d+$/.test(rawPort) || !rawOrigin)
    throw new Error("Set both OPENSPRINT_COLLABORATION_PORT and OPENSPRINT_COLLABORATION_ORIGIN.");
  const port = Number(rawPort);
  const hostPort = getApiPort(environment);
  if (port < 1 || port > 65535 || port === hostPort)
    throw new Error("The collaboration port must be a separate port between 1 and 65535.");
  const url = new URL(rawOrigin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const originPort = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (loopback && originPort === hostPort)
  )
    throw new Error(
      "Use a guest HTTPS origin (HTTP is allowed on loopback), separate from the host API origin."
    );
  return {
    port,
    origin: url.origin,
    frontendDist:
      environment.OPENSPRINT_FRONTEND_DIST ??
      fileURLToPath(new URL("../../frontend/dist", import.meta.url)),
  };
}

/** The same scoped read and guidance contracts back both local and invited experiences. */
export function createProjectCollaborationRouter(services: AppServices): Router {
  const { projectService } = services;
  const sharing = getCollaborationSharingConfig();
  const context = new CollaborationTaskContextService({
    projectService,
    taskStore,
    getActiveRun: (projectId, taskId) => agentChatService.getActiveRun(projectId, taskId),
    readExecution: (projectId, taskId) => {
      const slot = orchestratorService.getState(projectId).slots.get(taskId);
      if (!slot) return null;
      return {
        attemptId: slot.agent.attemptId ?? slot.attemptId,
        attempt: slot.attempt,
        branchName: slot.branchName,
        worktreePath: slot.worktreePath,
        output: slot.agent.outputLog,
        outputTruncated: Boolean(slot.agent.outputLogTruncated),
        outputFromFile: Boolean(slot.agent.outputLogFromFile),
        uncertain: slot.agent.activeProcess?.ownership === "recovered_unverified",
      };
    },
  });
  return createCollaborationRouter({
    assertProjectExists: (projectId) => projectService.getProject(projectId),
    assertTaskExists: (projectId, taskId) => context.assertTaskExists(projectId, taskId),
    getOverview: async (projectId) => ({
      ...(await context.getOverview(projectId)),
      ...(sharing ? { shareOrigin: sharing.origin } : {}),
    }),
    getTaskContext: (projectId, taskId) => context.getTaskContext(projectId, taskId),
    getActiveRun: (projectId, taskId) => agentChatService.getActiveRun(projectId, taskId),
    getGuidanceHistory: (projectId, taskId) =>
      agentChatService.getHistory(projectId, taskId).slice(-200),
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
        {
          clientMessageId: input.clientMessageId,
          actorId: input.actorId,
        }
      );
    },
  });
}

const guestParserErrors = new Map([
  [
    "entity.parse.failed",
    { status: 400, code: "INVALID_JSON", message: "Invalid JSON request body." },
  ],
  [
    "entity.too.large",
    { status: 413, code: "REQUEST_TOO_LARGE", message: "The request body is too large." },
  ],
  [
    "charset.unsupported",
    { status: 415, code: "UNSUPPORTED_CHARSET", message: "Unsupported request charset." },
  ],
  [
    "encoding.unsupported",
    {
      status: 415,
      code: "UNSUPPORTED_CONTENT_ENCODING",
      message: "Unsupported request content encoding.",
    },
  ],
  [
    "request.aborted",
    { status: 400, code: "INVALID_REQUEST_BODY", message: "Invalid request body." },
  ],
  [
    "request.size.invalid",
    { status: 400, code: "INVALID_REQUEST_BODY", message: "Invalid request body." },
  ],
]);

/**
 * Keep unexpected guest-facing errors opaque in every deployment mode. Intentional
 * application errors retain their public contract; diagnostics remain server-side.
 */
const guestErrorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  if (error instanceof AppError) {
    errorHandler(error, req, res, next);
    return;
  }
  const parserError =
    error instanceof Error && "type" in error && typeof error.type === "string"
      ? guestParserErrors.get(error.type)
      : undefined;
  if (parserError) {
    res.status(parserError.status).json({
      error: { code: parserError.code, message: parserError.message },
    });
    return;
  }
  log.error("Guest request error", {
    requestId: req.requestId,
    message: error instanceof Error ? error.message : "Unknown error",
    stack: error instanceof Error ? error.stack : undefined,
  });
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    },
  });
};

/** Serve only scoped collaboration APIs and guest assets, without desktop session bootstrap. */
export function createCollaborationSharingApp(
  config: CollaborationSharingConfig,
  router: Router
): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Security-Policy", buildSpaContentSecurityPolicyProduction());
    res.set("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (origin && origin !== config.origin) {
      res.status(403).json({
        error: { code: "COLLABORATION_FORBIDDEN", message: "This origin is not allowed." },
      });
      return;
    }
    res.vary("Origin");
    if (origin) res.set("Access-Control-Allow-Origin", config.origin);
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  app.use(`${API_PREFIX}/projects/:projectId/collaboration`, requireDatabase, router);
  // Never fall through to a host bootstrap, settings API, or arbitrary SPA route.
  app.use("/api", (_req, res) => res.status(404).end());
  app.use((req, res, next) => {
    // Static serving decodes paths and macOS/Windows can match case insensitively.
    // Deny the reserved bootstrap name using the same canonical interpretation.
    let normalized: string;
    try {
      normalized = path.posix
        .normalize(decodeURIComponent(req.path).replace(/\\/g, "/"))
        .normalize("NFKC")
        .toLowerCase();
    } catch {
      res.status(400).end();
      return;
    }
    if (normalized.split("/").includes("__opensprint_local_session.js")) {
      res.status(404).end();
      return;
    }
    next();
  });
  app.use(express.static(config.frontendDist, { index: false, dotfiles: "deny" }));
  app.get(
    "/collaborate/:projectId",
    wrapAsync(async (_req, res) => {
      const html = await fs.readFile(path.join(config.frontendDist, "index.html"), "utf8");
      res.type("html").send(html);
    })
  );
  app.use((_req, res) => res.status(404).end());
  app.use(guestErrorHandler);
  return app;
}
