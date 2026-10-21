import path from "path";
import crypto from "crypto";
import { config } from "dotenv";
import { createServer } from "http";
import { createApp } from "./app.js";
import { createAppServices } from "./composition.js";
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
import { createLogger, setLogSessionId } from "./utils/logger.js";
import { getErrorMessage } from "./utils/error-utils.js";
import { eventLogService } from "./services/event-log.service.js";
import { databaseRuntime } from "./services/database-runtime.service.js";
import { openBrowser } from "./utils/open-browser.js";
import { appendCrashLog } from "./utils/crash-log.js";
import { appendRuntimeTrace } from "./utils/runtime-trace.js";
import { startBackendDeathSentinel } from "./utils/backend-death-sentinel.js";
import { isIntegrationEncryptionKeyConfigured } from "./services/token-encryption.service.js";
import { CollaborationService } from "./services/collaboration.service.js";

// Electron launches backend with ELECTRON_RUN_AS_NODE=1 so process.execPath can run JS.
// Clear it immediately so backend child processes (agent CLIs) are not forced into Node mode.
if (process.env.OPENSPRINT_DESKTOP === "1") {
  delete process.env.ELECTRON_RUN_AS_NODE;
}

const logStartup = createLogger("startup");
const logShutdown = createLogger("shutdown");
const runtimeSessionId = crypto.randomUUID();
setLogSessionId(runtimeSessionId);
eventLogService.setInstanceId(runtimeSessionId);

const port = parseInt(process.env.PORT || String(DEFAULT_API_PORT), 10);

acquirePidFile(port);

const services = createAppServices();
const app = createApp(services);
const server = createServer(app);

wireDatabaseLifecycle(services);

// Attach WebSocket server (inject getLiveOutput for push-backfill on agent.subscribe)
setupWebSocket(server, {
  getLiveOutput: (projectId, taskId) => orchestratorService.getLiveOutput(projectId, taskId),
  executeAgentGuidance: (projectId, _taskId, attemptId, send) =>
    new CollaborationService().withControl(
      projectId,
      { actorId: "local-user", displayName: "Local user", role: "controller" },
      attemptId,
      async () => send()
    ),
});

// Wire TaskStoreService to emit task create/update/close events via WebSocket
wireTaskStoreEvents(broadcastToProject);

const FLUSH_PERSIST_TIMEOUT_MS = 15000;
const RUNTIME_HEARTBEAT_MS = 15_000;
let shuttingDown = false;
let runtimeHeartbeatTimer: NodeJS.Timeout | null = null;

function getActiveHandleCount(): number | null {
  try {
    const getHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })
      ._getActiveHandles;
    if (typeof getHandles !== "function") return null;
    return getHandles().length;
  } catch {
    return null;
  }
}

function startRuntimeHeartbeat(): void {
  if (runtimeHeartbeatTimer) return;
  runtimeHeartbeatTimer = setInterval(() => {
    const mem = process.memoryUsage();
    appendRuntimeTrace("process.heartbeat", runtimeSessionId, {
      uptimeSec: Math.round(process.uptime()),
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      activeHandles: getActiveHandleCount(),
      dbState: databaseRuntime.getSnapshot().state,
      dbMessage: databaseRuntime.getSnapshot().message,
    });
  }, RUNTIME_HEARTBEAT_MS);
  runtimeHeartbeatTimer.unref();
}

function stopRuntimeHeartbeat(): void {
  if (!runtimeHeartbeatTimer) return;
  clearInterval(runtimeHeartbeatTimer);
  runtimeHeartbeatTimer = null;
}

// Graceful shutdown
const shutdown = async (trigger: string) => {
  if (shuttingDown) {
    logShutdown.warn("Shutdown already in progress", { trigger });
    appendCrashLog("shutdown.reentrant", { trigger });
    return;
  }
  shuttingDown = true;
  stopRuntimeHeartbeat();
  appendRuntimeTrace("shutdown.begin", runtimeSessionId, {
    trigger,
    uptimeSec: Math.round(process.uptime()),
    activeHandles: getActiveHandleCount(),
  });
  appendCrashLog("shutdown.begin", { trigger });
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
    appendCrashLog("shutdown.flush_failed", {
      trigger,
      err: getErrorMessage(err),
    });
  });

  await taskStore.closePool();

  removePidFile(port);
  closeWebSocket();
  server.close(() => {
    logShutdown.info("Server closed.");
    appendRuntimeTrace("shutdown.server_closed", runtimeSessionId, { trigger });
    appendCrashLog("shutdown.server_closed", { trigger });
    process.exit(0);
  });
  setTimeout(() => {
    logShutdown.error("Forced shutdown after timeout.");
    appendRuntimeTrace("shutdown.forced_timeout", runtimeSessionId, { trigger });
    appendCrashLog("shutdown.forced_timeout", { trigger });
    process.exit(1);
  }, 5000);
};

// Handle server errors (especially EADDRINUSE) before calling listen
server.on("error", (err: NodeJS.ErrnoException) => {
  removePidFile(port);
  appendCrashLog("server.error", {
    code: err.code ?? null,
    message: err.message,
    stack: err.stack,
  });
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

server.listen(port, "127.0.0.1", () => {
  logStartup.info("Open Sprint backend listening", { url: `http://localhost:${port}` });
  logStartup.info("WebSocket server ready", { url: `ws://localhost:${port}/ws` });
  if (process.env.NODE_ENV !== "test" && !isIntegrationEncryptionKeyConfigured()) {
    logStartup.warn(
      "INTEGRATION_ENCRYPTION_KEY is not set. Integration OAuth tokens are encrypted with a key derived from this hostname and ~/.opensprint/encryption-salt. For shared servers or any host where other users can read ~/.opensprint, set INTEGRATION_ENCRYPTION_KEY to a base64-encoded 32-byte random key (see README).",
      { readmeSection: "integration-token-encryption" }
    );
  }
  appendRuntimeTrace("process.start", runtimeSessionId, {
    port,
    frontendPort: FRONTEND_PORT,
    cwd: process.cwd(),
    argv: process.argv,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    desktop: process.env.OPENSPRINT_DESKTOP ?? null,
  });
  startBackendDeathSentinel({
    sessionId: runtimeSessionId,
    backendPid: process.pid,
    parentPid: process.ppid,
  });
  startRuntimeHeartbeat();
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

process.on("SIGINT", () => {
  appendRuntimeTrace("signal.SIGINT", runtimeSessionId);
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  appendRuntimeTrace("signal.SIGTERM", runtimeSessionId);
  void shutdown("SIGTERM");
});

// Safety net: prevent unhandled rejections from crashing the server
process.on("unhandledRejection", (reason) => {
  appendRuntimeTrace("process.unhandledRejection", runtimeSessionId, { reason });
  appendCrashLog("process.unhandledRejection", { reason });
  logStartup.error("Unhandled promise rejection", { reason });
});

process.on("uncaughtExceptionMonitor", (err, origin) => {
  appendRuntimeTrace("process.uncaughtExceptionMonitor", runtimeSessionId, {
    origin,
    err,
  });
});

process.on("uncaughtException", (err) => {
  appendRuntimeTrace("process.uncaughtException", runtimeSessionId, { err });
  appendCrashLog("process.uncaughtException", { err });
  logStartup.error("Uncaught exception", { err });
  void shutdown("uncaughtException");
});

process.on("multipleResolves", (type, _promise, reason) => {
  appendRuntimeTrace("process.multipleResolves", runtimeSessionId, {
    type,
    reason,
  });
});

process.on("beforeExit", (code) => {
  appendRuntimeTrace("process.beforeExit", runtimeSessionId, { code });
});

process.on("exit", (code) => {
  appendRuntimeTrace("process.exit", runtimeSessionId, { code });
});

process.on("warning", (warning) => {
  appendRuntimeTrace("process.warning", runtimeSessionId, { warning });
});

process.on("disconnect", () => {
  appendRuntimeTrace("process.disconnect", runtimeSessionId);
});
