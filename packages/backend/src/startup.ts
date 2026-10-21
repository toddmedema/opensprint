import fs from "fs";
import { agentChatService } from "./services/agent-chat.service.js";
import { specPublicationService } from "./services/spec-publication.service.js";
import { operationWorker } from "./services/operation-worker.service.js";
import { validateDeploymentMode, getDeploymentMode } from "./services/deployment-mode.js";
import path from "path";
import { createLogger } from "./utils/logger.js";
import { getErrorMessage } from "./utils/error-utils.js";
import { ProjectService } from "./services/project.service.js";
import { taskStore } from "./services/task-store.service.js";
import { FeedbackService } from "./services/feedback.service.js";
import { orchestratorService } from "./services/orchestrator.service.js";
import { watchdogService } from "./services/watchdog.service.js";
import { sessionRetentionService } from "./services/session-retention.service.js";
import {
  startNightlyDeployScheduler,
  stopNightlyDeployScheduler,
} from "./services/nightly-deploy-scheduler.service.js";
import {
  startSelfImprovementScheduler,
  stopSelfImprovementScheduler,
} from "./services/self-improvement-scheduler.service.js";
import {
  startBlockedAutoRetry,
  stopBlockedAutoRetry,
} from "./services/blocked-auto-retry.service.js";
import {
  startTodoistSyncScheduler,
  stopTodoistSyncScheduler,
} from "./services/todoist-sync-scheduler.service.js";
import { initAppDb } from "./db/app-db.js";
import type { AppDb } from "./db/app-db.js";
import { databaseRuntime } from "./services/database-runtime.service.js";
import { PlanService } from "./services/plan.service.js";
import { resumePlanExecuteBatchesOnStartup } from "./services/plan-execute-batch.service.js";

const logOrchestrator = createLogger("orchestrator-startup");
const logShutdown = createLogger("shutdown");

let appDb: AppDb | null = null;
let databaseFeaturesStarted = false;
let databaseFeaturesStartPromise: Promise<void> | null = null;

function hasValidRepoPath(project: { repoPath: string }): boolean {
  return fs.existsSync(project.repoPath) && fs.existsSync(path.join(project.repoPath, ".git"));
}

/**
 * Initialize the always-on orchestrator for all projects with valid repo paths.
 * Starts the watchdog, blocked-auto-retry, and session retention services.
 * @param projectService - When provided (from composition root), use it; otherwise create a new instance.
 */
export async function initAlwaysOnOrchestrator(projectService?: ProjectService): Promise<void> {
  const projectServiceToUse = projectService ?? new ProjectService();
  const feedbackService = new FeedbackService();

  try {
    const projects = await projectServiceToUse.listProjects();
    if (projects.length === 0) {
      logOrchestrator.info("No projects found");
      return;
    }

    // Prune projects whose repoPath no longer contains a git repo (stale temp dirs, deleted repos)
    const validProjects = projects.filter((p) => {
      if (!hasValidRepoPath(p)) {
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
    sessionRetentionService.start();

    watchdogService.start(async () => {
      const projects = await projectServiceToUse.listProjects();
      return projects
        .filter(hasValidRepoPath)
        .map((p) => ({ projectId: p.id, repoPath: p.repoPath }));
    });

    startBlockedAutoRetry(async () => {
      const projects = await projectServiceToUse.listProjects();
      return projects
        .filter(hasValidRepoPath)
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
              err: getErrorMessage(err),
            });
          });
      } catch (err) {
        logOrchestrator.warn("Could not read tasks for project", {
          name: project.name,
          err: getErrorMessage(err),
        });
      }
    }
  } catch (err) {
    logOrchestrator.warn("Status check failed", { err: getErrorMessage(err) });
  }
}

/**
 * Stop all database-backed features: schedulers, watchdog, orchestrator, task store, app DB.
 */
export async function stopDatabaseFeatures(): Promise<void> {
  if (!databaseFeaturesStarted && !appDb) {
    return;
  }
  operationWorker.stop();
  specPublicationService.stop();
  stopNightlyDeployScheduler();
  stopSelfImprovementScheduler();
  stopTodoistSyncScheduler();
  stopBlockedAutoRetry();
  watchdogService.stop();
  sessionRetentionService.stop();
  orchestratorService.stopAll();
  await agentChatService.flush();
  await taskStore.closePool().catch((err) => {
    logShutdown.warn("Could not close task store pool", {
      err: getErrorMessage(err),
    });
  });
  if (appDb) {
    await appDb.close().catch((err) => {
      logShutdown.warn("Could not close app database", {
        err: getErrorMessage(err),
      });
    });
    appDb = null;
  }
  databaseFeaturesStarted = false;
}

/**
 * Start database-backed features: init app DB, task store, schedulers, and orchestrator.
 * @param databaseUrl - Database connection URL
 * @param projectService - Optional project service from composition root (avoids ad-hoc instances)
 */
export async function startDatabaseFeatures(
  databaseUrl: string,
  projectService?: ProjectService
): Promise<void> {
  if (databaseFeaturesStarted) {
    return;
  }
  if (databaseFeaturesStartPromise) {
    await databaseFeaturesStartPromise;
    return;
  }

  databaseFeaturesStartPromise = (async () => {
    let nextAppDb: AppDb | null = null;
    try {
      validateDeploymentMode();
      if (
        Number(process.env.OPENSPRINT_BACKEND_REPLICAS ?? 1) > 1 &&
        (!/^postgres(?:ql)?:/.test(databaseUrl) || getDeploymentMode() !== "isolated-hosted")
      )
        throw new Error("Multiple backends require isolated-hosted mode with PostgreSQL.");
      nextAppDb = await initAppDb(databaseUrl);
      await taskStore.init(databaseUrl, nextAppDb);
      appDb = nextAppDb;
      databaseFeaturesStarted = true;
      operationWorker.start();
      specPublicationService.start();
      startNightlyDeployScheduler();
      startSelfImprovementScheduler();
      startTodoistSyncScheduler();
      await initAlwaysOnOrchestrator(projectService);
      await resumePlanExecuteBatchesOnStartup(
        new PlanService(projectService ?? new ProjectService())
      );
    } catch (err) {
      if (nextAppDb) {
        await nextAppDb
          .close()
          .catch((e: unknown) =>
            logOrchestrator.warn("appDb close failed during startup rollback", {
              err: e instanceof Error ? e.message : String(e),
            })
          );
      }
      appDb = null;
      await taskStore
        .closePool()
        .catch((e: unknown) =>
          logOrchestrator.warn("taskStore pool close failed during startup rollback", {
            err: e instanceof Error ? e.message : String(e),
          })
        );
      databaseFeaturesStarted = false;
      databaseRuntime.handleOperationalFailure(err);
      throw err;
    } finally {
      databaseFeaturesStartPromise = null;
    }
  })();

  await databaseFeaturesStartPromise;
}

/** Services from composition root; when set, startup uses them to avoid ad-hoc instances. */
let lifecycleProjectService: ProjectService | undefined;

/**
 * Wire database runtime lifecycle handlers to start/stop database features.
 * @param services - Optional app services from composition root (provides projectService for startup)
 */
export function wireDatabaseLifecycle(services?: { projectService: ProjectService }): void {
  lifecycleProjectService = services?.projectService;
  databaseRuntime.setLifecycleHandlers({
    onConnected: async ({ databaseUrl }) => {
      await startDatabaseFeatures(databaseUrl, lifecycleProjectService);
    },
    onDisconnected: async () => {
      await stopDatabaseFeatures();
    },
  });
}
