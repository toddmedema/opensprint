import path from "path";
import { config } from "dotenv";
import { createServer } from "http";
import { createApp } from "./app.js";
import { acquirePidFile, removePidFile } from "./pid-file.js";
import { wireDatabaseLifecycle, stopDatabaseFeatures } from "./startup.js";

// Load .env from monorepo root (must run before any code that reads process.env)
config({ path: path.resolve(process.cwd(), ".env") });
config({ path: path.resolve(process.cwd(), "../.env") });
config({ path: path.resolve(process.cwd(), "../../.env") });
import {
  setupWebSocket,
  closeWebSocket,
  hasClientConnected,
  broadcastToProject,
} from "./websocket/index.js";
import { DEFAULT_API_PORT } from "@opensprint/shared";
import { taskStore } from "./services/task-store.service.js";
import { wireTaskStoreEvents } from "./task-store-events.js";
import { orchestratorService } from "./services/orchestrator.service.js";
import { startProcessReaper, stopProcessReaper } from "./services/process-reaper.js";
import {
  killAllTrackedAgentProcesses,
  clearAgentProcessRegistry,
} from "./services/agent-process-registry.js";
import { createLogger } from "./utils/logger.js";
import { getErrorMessage } from "./utils/error-utils.js";
import { databaseRuntime } from "./services/database-runtime.service.js";
import { openBrowser } from "./utils/open-browser.js";

const logStartup = createLogger("startup");
const logShutdown = createLogger("shutdown");

const port = parseInt(process.env.PORT || String(DEFAULT_API_PORT), 10);

acquirePidFile(port);

const app = createApp();
const server = createServer(app);

// Attach WebSocket server (inject getLiveOutput for push-backfill on agent.subscribe)
setupWebSocket(server, {
  getLiveOutput: (projectId, taskId) => orchestratorService.getLiveOutput(projectId, taskId),
});

// Wire TaskStoreService to emit task create/update/close events via WebSocket
wireTaskStoreEvents(broadcastToProject);

wireDatabaseLifecycle();

const FLUSH_PERSIST_TIMEOUT_MS = 15000;

// Graceful shutdown
const shutdown = async () => {
  logShutdown.info("Shutting down...");
  if (process.env.OPENSPRINT_PRESERVE_AGENTS === "1") {
    logShutdown.info("OPENSPRINT_PRESERVE_AGENTS=1 — preserving agent processes");
    clearAgentProcessRegistry();
  } else {
    await killAllTrackedAgentProcesses();
  }
  stopProcessReaper();
  await stopDatabaseFeatures();

  const flushDone = taskStore.flushPersist();
  const flushTimeout = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error("flush timeout")), FLUSH_PERSIST_TIMEOUT_MS)
  );
  await Promise.race([flushDone, flushTimeout]).catch((err) => {
    logShutdown.warn("Task store flush timed out or failed", { err: getErrorMessage(err) });
  });

  await taskStore.closePool();

  removePidFile(port);
  closeWebSocket();
  server.close(() => {
    logShutdown.info("Server closed.");
    process.exit(0);
  });
  setTimeout(() => {
    logShutdown.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 5000);
};

// Handle server errors (especially EADDRINUSE) before calling listen
server.on("error", (err: NodeJS.ErrnoException) => {
  removePidFile(port);
  if (err.code === "EADDRINUSE") {
    logStartup.error("Port already in use", {
      port,
      hint: `Kill the existing process (lsof -ti :${port} | xargs kill -9) or use a different PORT.`,
    });
    process.exit(1);
  }
  logStartup.error("Server error", { err });
  process.exit(1);
});

const FRONTEND_PORT = parseInt(process.env.FRONTEND_PORT || "5173", 10);

server.listen(port, () => {
  logStartup.info("OpenSprint backend listening", { url: `http://localhost:${port}` });
  logStartup.info("WebSocket server ready", { url: `ws://localhost:${port}/ws` });
  startProcessReaper();
  databaseRuntime.start();

  // Auto-open frontend if no browser reconnects within 15s (skip when running under Electron desktop)
  if (process.env.OPENSPRINT_DESKTOP !== "1") {
    setTimeout(() => {
      if (hasClientConnected()) return;
      const url = `http://localhost:${FRONTEND_PORT}`;
      logStartup.info("No WebSocket client connected — opening frontend", { url });
      void openBrowser(url).then((result) => {
        if (result.status === "failed") {
          logStartup.warn("Could not open browser", { url, err: result.error });
        }
        if (result.status === "logged") {
          logStartup.info("Open the frontend manually if it did not launch automatically", { url });
        }
      });
    }, 15_000);
  }
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Safety net: prevent unhandled rejections from crashing the server
process.on("unhandledRejection", (reason) => {
  logStartup.error("Unhandled promise rejection", { reason });
});

process.on("uncaughtException", (err) => {
  logStartup.error("Uncaught exception", { err });
  shutdown();
});
