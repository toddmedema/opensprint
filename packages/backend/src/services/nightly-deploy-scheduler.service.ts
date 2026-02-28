import { execSync } from "child_process";
import cron from "node-cron";
import { ProjectService } from "./project.service.js";
import { triggerDeploy } from "./deploy-trigger.service.js";
import { deployStorageService } from "./deploy-storage.service.js";
import { getTargetsForNightlyDeploy } from "@opensprint/shared";
import { createLogger } from "../utils/logger.js";

const log = createLogger("nightly-deploy");
const DEFAULT_NIGHTLY_TIME = "02:00";

/**
 * Check if main branch has commits after the given ISO timestamp.
 * Returns true if commits exist, false if none or on error (treat error as "proceed" for first-deploy safety).
 */
function hasMainCommitsAfter(repoPath: string, afterTimestamp: string): boolean {
  try {
    const out = execSync(
      `git rev-list main --after="${afterTimestamp}" --count`,
      { cwd: repoPath, encoding: "utf-8" }
    );
    const count = parseInt(out.trim(), 10);
    return !Number.isNaN(count) && count > 0;
  } catch {
    return true; // On error (e.g. no main branch), proceed with deploy
  }
}

/** Parse HH:mm to { hour, minute } or null if invalid. */
function parseTime(hhmm: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm?.trim() ?? "");
  if (!match) return null;
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

/** Last run date (YYYY-MM-DD) per project to avoid duplicate runs in same day. */
const lastRunByProject = new Map<string, string>();

let cronTask: cron.ScheduledTask | null = null;
const projectService = new ProjectService();

/**
 * Run the nightly deploy tick: for each project with nightly targets,
 * if current time matches the project's nightlyDeployTime, trigger deploy for each target.
 * Uses lastRunByProject to run at most once per day per project.
 */
export async function runNightlyTick(
  now: Date = new Date()
): Promise<{ projectId: string; targetName: string; deployId: string | null }[]> {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const today = `${y}-${m}-${d}`; // YYYY-MM-DD (local)
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const results: { projectId: string; targetName: string; deployId: string | null }[] = [];

  const projects = await projectService.listProjects();

  for (const project of projects) {
    try {
      const settings = await projectService.getSettings(project.id);
      const deployment = settings.deployment;
      const nightlyTargets = getTargetsForNightlyDeploy(deployment);
      if (nightlyTargets.length === 0) continue;

      const timeStr = deployment.nightlyDeployTime ?? DEFAULT_NIGHTLY_TIME;
      const parsed = parseTime(timeStr);
      if (!parsed) continue;
      if (parsed.hour !== currentHour || parsed.minute !== currentMinute) continue;

      const lastRun = lastRunByProject.get(project.id);
      if (lastRun === today) continue; // Already ran today
      lastRunByProject.set(project.id, today);

      for (const targetName of nightlyTargets) {
        const lastSuccess = await deployStorageService.getLastSuccessfulDeployForTarget(
          project.id,
          targetName
        );
        const baselineTimestamp =
          lastSuccess?.completedAt ?? lastSuccess?.startedAt ?? null;
        if (baselineTimestamp) {
          const hasNewCommits = hasMainCommitsAfter(project.repoPath, baselineTimestamp);
          if (!hasNewCommits) {
            log.info("Skipping nightly deploy: no new commits on main since last successful deploy", {
              projectId: project.id,
              projectName: project.name,
              targetName,
            });
            results.push({ projectId: project.id, targetName, deployId: null });
            continue;
          }
        }
        const deployId = await triggerDeploy(project.id, targetName);
        results.push({ projectId: project.id, targetName, deployId });
        if (deployId) {
          log.info("Triggered nightly deploy", {
            projectId: project.id,
            projectName: project.name,
            targetName,
            deployId,
          });
        }
      }
    } catch (err) {
      log.warn("Nightly deploy tick failed for project", {
        projectId: project.id,
        err: (err as Error).message,
      });
    }
  }

  return results;
}

/**
 * Build cron expression for a given HH:mm. Cron: minute hour day month weekday.
 * We schedule to run every minute and let runNightlyTick filter by time.
 * This allows per-project nightlyDeployTime without multiple cron jobs.
 */
function getCronExpression(): string {
  return "* * * * *"; // Every minute
}

/**
 * Start the nightly deploy scheduler. Runs every minute; on each tick,
 * triggers deploys for projects whose nightlyDeployTime matches current time.
 */
export function startNightlyDeployScheduler(): void {
  if (cronTask) {
    log.warn("Nightly deploy scheduler already started");
    return;
  }

  cronTask = cron.schedule(getCronExpression(), () => {
    runNightlyTick().catch((err) => {
      log.error("Nightly deploy tick error", { err: (err as Error).message });
    });
  });

  log.info("Nightly deploy scheduler started");
}

/**
 * Stop the nightly deploy scheduler.
 */
export function stopNightlyDeployScheduler(): void {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
    log.info("Nightly deploy scheduler stopped");
  }
}
