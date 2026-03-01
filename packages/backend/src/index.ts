import path from "path";
import fs from "fs";
import { config } from "dotenv";
import { createServer } from "http";
import { createApp } from "./app.js";

// Load .env from monorepo root (must run before any code that reads process.env)
config({ path: path.resolve(process.cwd(), ".env") });
config({ path: path.resolve(process.cwd(), "../.env") });
config({ path: path.resolve(process.cwd(), "../../.env") });

import { exec } from "child_process";
import { setupWebSocket, closeWebSocket, hasClientConnected, broadcastToProject } from "./websocket/index.js";
import { DEFAULT_API_PORT } from "@opensprint/shared";
import { getDatabaseUrl } from "./services/global-settings.service.js";
import { ProjectService } from "./services/project.service.js";
import { taskStore } from "./services/task-store.service.js";
import { wireTaskStoreEvents } from "./task-store-events.js";
import { FeedbackService } from "./services/feedback.service.js";
import { orchestratorService } from "./services/orchestrator.service.js";
import { watchdogService } from "./services/watchdog.service.js";
import { sessionRetentionService } from "./services/session-retention.service.js";
import { startProcessReaper, stopProcessReaper } from "./services/process-reaper.js";
import {
  startNightlyDeployScheduler,
  stopNightlyDeployScheduler,
} from "./services/nightly-deploy-scheduler.service.js";
import {
  startBlockedAutoRetry,
  stopBlockedAutoRetry,
} from "./services/blocked-auto-retry.service.js";
import {
  killAllTrackedAgentProcesses,
  clearAgentProcessRegistry,
} from "./services/agent-process-registry.js";
import { createLogger } from "./utils/logger.js";
import { getGlobalSettings } from "./services/global-settings.service.js";
import { isLocalDatabaseUrl } from "@opensprint/shared";
import { initAppDb } from "./db/app-db.js";

const logStartup = createLogger("startup");
const logOrchestrator = createLogger("orchestrator");
const logShutdown = createLogger("shutdown");

const port = parseInt(process.env.PORT || String(DEFAULT_API_PORT), 10);

// --- PID file management ---
const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
const pidDir = path.join(home, ".opensprint");
const pidFile = path.join(pidDir, `server-${port}.pid`);

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually kill
    return true;
  } catch {
    return false;
  }
}

function waitForProcessExit(pid: number, timeoutMs: number): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return !isProcessAlive(pid);
}

function acquirePidFile(): void {
  try {
    const content = fs.readFileSync(pidFile, "utf-8").trim();
    const oldPid = parseInt(content, 10);
    if (!isNaN(oldPid) && isProcessAlive(oldPid)) {
      if (oldPid === process.pid) return; // re-entrant call
      // During tsx watch restarts, the old process may still be in its exit sequence.
      // Wait briefly before giving up.
      logStartup.info("Waiting for previous process to exit", { pid: oldPid });
      if (!waitForProcessExit(oldPid, 3000)) {
        logStartup.error("Another OpenSprint server is already running", {
          port,
          pid: oldPid,
          hint: `Kill it with: kill ${oldPid} or kill -9 ${oldPid}`,
        });
        process.exit(1);
      }
      logStartup.info("Previous process has exited", { pid: oldPid });
    } else if (!isNaN(oldPid)) {
      logStartup.info("Removing stale PID file", { pid: oldPid });
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logStartup.warn("Could not read PID file", { err: (err as Error).message });
    }
  }

  // Write our PID
  fs.mkdirSync(pidDir, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid), "utf-8");
}

function removePidFile(): void {
  try {
    const content = fs.readFileSync(pidFile, "utf-8").trim();
    // Only remove if it's our PID (guard against race conditions)
    if (parseInt(content, 10) === process.pid) {
      fs.unlinkSync(pidFile);
    }
  } catch {
    // Best effort — file may already be gone
  }
}

acquirePidFile();

const app = createApp();
const server = createServer(app);

// Attach WebSocket server (inject getLiveOutput for push-backfill on agent.subscribe)
setupWebSocket(server, {
  getLiveOutput: (projectId, taskId) => orchestratorService.getLiveOutput(projectId, taskId),
});

// Wire TaskStoreService to emit task create/update/close events via WebSocket
wireTaskStoreEvents(broadcastToProject);

// Resolve database URL from env (DATABASE_URL) then global settings then default. Use this
// single source so we never accidentally use the test DB (e.g. via .env or misconfigured file).
const databaseUrl = await getDatabaseUrl();

// Refuse to run the app against the test database. Tests run DELETE FROM tasks in setup;
// if the app used opensprint_test, running tests (e.g. in another terminal) would wipe
// the app's tasks and cause "all tasks disappear" (see docs/task-disappearance.md).
const TEST_DB_NAME = "opensprint_test";
let resolvedDbName = "opensprint";
try {
  resolvedDbName = new URL(databaseUrl).pathname.replace(/^\/+|\/+$/g, "") || "opensprint";
  if (resolvedDbName === TEST_DB_NAME) {
    logStartup.error("App must not use the test database", {
      database: resolvedDbName,
      hint: `Use the app database "opensprint" (default). Unset DATABASE_URL if set to test DB; set databaseUrl in ~/.opensprint/global-settings.json to a non-test database. Tests use ${TEST_DB_NAME} and wipe task data.`,
    });
    process.exit(1);
  }
} catch {
  // URL parse failed; initAppDb or getDatabaseUrl validation will fail later
}
logStartup.info("Using database", { database: resolvedDbName });

const dbSource = isLocalDatabaseUrl(databaseUrl) ? "local" : "remote";
logStartup.info("Database source", { source: dbSource });

// Single DB pool owner; task store and other services use it
const appDb = await initAppDb(databaseUrl);
await taskStore.init(databaseUrl, appDb);

async function initAlwaysOnOrchestrator(): Promise<void> {
  const projectService = new ProjectService();
  const feedbackService = new FeedbackService();

  try {
    const projects = await projectService.listProjects();
    if (projects.length === 0) {
      logOrchestrator.info("No projects found");
      return;
    }

    // Prune projects whose repoPath no longer contains a git repo (stale temp dirs, deleted repos)
    const validProjects = projects.filter((p) => {
      if (!fs.existsSync(p.repoPath) || !fs.existsSync(path.join(p.repoPath, ".git"))) {
        logOrchestrator.warn("Skipping project — repoPath is not a valid git repo", {
          name: p.name,
          repoPath: p.repoPath,
        });
        return false;
      }
      return true;
    });

    if (validProjects.length === 0) {
      logOrchestrator.info("No projects with valid repo paths found");
      return;
    }

    logOrchestrator.info("Starting always-on orchestrator", {
      projectCount: validProjects.length,
    });

    // Start independent watchdog; targets refreshed each cycle so deleted projects are not patrolled
    const projectServiceForWatchdog = new ProjectService();
    sessionRetentionService.start();

    watchdogService.start(async () => {
      const projects = await projectServiceForWatchdog.listProjects();
      return projects
        .filter((p) => fs.existsSync(p.repoPath) && fs.existsSync(path.join(p.repoPath, ".git")))
        .map((p) => ({ projectId: p.id, repoPath: p.repoPath }));
    });

    startBlockedAutoRetry(async () => {
      const projects = await projectServiceForWatchdog.listProjects();
      return projects
        .filter((p) => fs.existsSync(p.repoPath) && fs.existsSync(path.join(p.repoPath, ".git")))
        .map((p) => ({ projectId: p.id, repoPath: p.repoPath }));
    });

    for (const project of validProjects) {
      try {
        // Auto-start always-on orchestrator for each project (PRDv2 §5.7)
        await orchestratorService.ensureRunning(project.id);

        const allTasks = await taskStore.list(project.id);
        const nonEpicTasks = allTasks.filter(
          (t) => (t.issue_type ?? (t as Record<string, unknown>).type) !== "epic"
        );
        const inProgress = nonEpicTasks.filter((t) => t.status === "in_progress");
        const open = nonEpicTasks.filter((t) => t.status === "open");

        const status = await orchestratorService.getStatus(project.id);
        const agentRunning = status.activeTasks.length > 0;

        logOrchestrator.info("Project status", {
          name: project.name,
          openCount: open.length,
          inProgressCount: inProgress.length,
          agentRunning,
        });

        if (inProgress.length > 0) {
          for (const task of inProgress) {
            const assignee = task.assignee ?? "unassigned";
            logOrchestrator.info("In-progress task", {
              taskId: task.id,
              title: task.title,
              assignee,
            });
          }
        }
        // Enqueue any pending feedback for orchestrator (Gastown-style mailbox); nudge to process
        feedbackService
          .retryPendingCategorizations(project.id)
          .then((enqueued) => {
            if (enqueued > 0) orchestratorService.nudge(project.id);
          })
          .catch((err) => {
            logOrchestrator.warn("Pending feedback enqueue failed", {
              name: project.name,
              err: (err as Error).message,
            });
          });
      } catch (err) {
        logOrchestrator.warn("Could not read tasks for project", {
          name: project.name,
          err: (err as Error).message,
        });
      }
    }
  } catch (err) {
    logOrchestrator.warn("Status check failed", { err: (err as Error).message });
  }
}

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
  sessionRetentionService.stop();
  stopNightlyDeployScheduler();
  stopBlockedAutoRetry();
  watchdogService.stop();
  orchestratorService.stopAll();

  const flushDone = taskStore.flushPersist();
  const flushTimeout = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error("flush timeout")), FLUSH_PERSIST_TIMEOUT_MS)
  );
  await Promise.race([flushDone, flushTimeout]).catch((err) => {
    logShutdown.warn("Task store flush timed out or failed", { err: (err as Error).message });
  });

  await taskStore.closePool();
  await appDb.close();

  removePidFile();
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
  removePidFile();
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
  startNightlyDeployScheduler();
  initAlwaysOnOrchestrator().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err && typeof (err as { code?: string }).code === "string"
        ? (err as { code: string }).code
        : undefined;
    logOrchestrator.error("Always-on init failed", {
      message,
      code,
      stack: err instanceof Error ? err.stack : undefined,
    });
  });

  // Auto-open frontend if no browser reconnects within 15s
  setTimeout(() => {
    if (hasClientConnected()) return;
    const url = `http://localhost:${FRONTEND_PORT}`;
    logStartup.info("No WebSocket client connected — opening frontend", { url });
    const cmd =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${cmd} ${url}`, (err) => {
      if (err) logStartup.warn("Could not open browser", { err: err.message });
    });
  }, 15_000);
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
