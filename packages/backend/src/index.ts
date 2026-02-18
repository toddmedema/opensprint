import path from "path";
import fs from "fs";
import { config } from "dotenv";
import { createServer } from "http";
import { createApp } from "./app.js";

// Load .env from monorepo root (must run before any code that reads process.env)
config({ path: path.resolve(process.cwd(), ".env") });
config({ path: path.resolve(process.cwd(), "../.env") });
config({ path: path.resolve(process.cwd(), "../../.env") });
import { setupWebSocket, closeWebSocket } from "./websocket/index.js";
import { DEFAULT_API_PORT } from "@opensprint/shared";
import { ProjectService } from "./services/project.service.js";
import { BeadsService } from "./services/beads.service.js";
import { FeedbackService } from "./services/feedback.service.js";
import { orchestratorService } from "./services/orchestrator.service.js";

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
      console.log(`[startup] Waiting for previous process (PID ${oldPid}) to exit...`);
      if (!waitForProcessExit(oldPid, 3000)) {
        console.error(
          `[FATAL] Another OpenSprint server is already running on port ${port} (PID ${oldPid}).\n` +
            `  Kill it with: kill ${oldPid}\n` +
            `  Or force:     kill -9 ${oldPid}`
        );
        process.exit(1);
      }
      console.log(`[startup] Previous process (PID ${oldPid}) has exited`);
    } else if (!isNaN(oldPid)) {
      console.log(`[startup] Removing stale PID file (old PID ${oldPid} is no longer running)`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[startup] Could not read PID file: ${(err as Error).message}`);
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

// Attach WebSocket server
setupWebSocket(server);

async function initAlwaysOnOrchestrator(): Promise<void> {
  const projectService = new ProjectService();
  const beads = new BeadsService();
  const feedbackService = new FeedbackService();

  try {
    const projects = await projectService.listProjects();
    if (projects.length === 0) {
      console.log("[orchestrator] No projects found");
      return;
    }

    console.log(
      `[orchestrator] ${projects.length} project(s) registered — starting always-on orchestrator`
    );

    for (const project of projects) {
      try {
        // Auto-start always-on orchestrator for each project (PRDv2 §5.7)
        await orchestratorService.ensureRunning(project.id);

        const allTasks = await beads.list(project.repoPath);
        const nonEpicTasks = allTasks.filter(
          (t) => (t.issue_type ?? (t as Record<string, unknown>).type) !== "epic"
        );
        const inProgress = nonEpicTasks.filter((t) => t.status === "in_progress");
        const open = nonEpicTasks.filter((t) => t.status === "open");

        const status = await orchestratorService.getStatus(project.id);
        const agentRunning = status.currentTask !== null;

        const parts: string[] = [
          `[orchestrator] "${project.name}"`,
          `${open.length} open task(s)`,
          `${inProgress.length} in-progress`,
          agentRunning ? "1 agent running" : "0 agents running",
        ];
        console.log(parts.join(" | "));

        if (inProgress.length > 0) {
          for (const task of inProgress) {
            const assignee = task.assignee ?? "unassigned";
            console.log(`  → in_progress: ${task.id} "${task.title}" (${assignee})`);
          }
        }
        // Retry any pending feedback categorizations that failed during a previous run
        feedbackService.retryPendingCategorizations(project.id).catch((err) => {
          console.warn(
            `[feedback] Pending categorization retry failed for "${project.name}": ${(err as Error).message}`
          );
        });
      } catch (err) {
        console.warn(
          `[orchestrator] Could not read tasks for "${project.name}": ${(err as Error).message}`
        );
      }
    }
  } catch (err) {
    console.warn(`[orchestrator] Status check failed: ${(err as Error).message}`);
  }
}

// Graceful shutdown
const shutdown = () => {
  console.log("\nShutting down...");
  orchestratorService.stopAll();
  removePidFile();
  closeWebSocket();
  server.close(() => {
    console.log("Server closed.");
    process.exit(0);
  });
  setTimeout(() => {
    console.error("Forced shutdown after timeout.");
    process.exit(1);
  }, 3000);
};

// Handle server errors (especially EADDRINUSE) before calling listen
server.on("error", (err: NodeJS.ErrnoException) => {
  removePidFile();
  if (err.code === "EADDRINUSE") {
    console.error(
      `[FATAL] Port ${port} is already in use. ` +
        `Kill the existing process (lsof -ti :${port} | xargs kill -9) or use a different PORT.`
    );
    process.exit(1);
  }
  console.error("[FATAL] Server error:", err);
  process.exit(1);
});

server.listen(port, () => {
  console.log(`OpenSprint backend listening on http://localhost:${port}`);
  console.log(`WebSocket server ready on ws://localhost:${port}/ws`);
  initAlwaysOnOrchestrator().catch((err) => {
    console.error("[orchestrator] Always-on init failed:", err);
  });
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Safety net: prevent unhandled rejections from crashing the server
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  shutdown();
});
