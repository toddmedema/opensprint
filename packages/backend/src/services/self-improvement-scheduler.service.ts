/**
 * Self-improvement scheduler — runs on a fixed interval (every minute). On each tick,
 * for projects with selfImprovementFrequency 'daily' or 'weekly': daily = at most once
 * per calendar day (midnight UTC); weekly = at most once per week (Sunday 00:00 UTC).
 * For each project due, calls SelfImprovementService.runIfDue(projectId, { trigger: 'scheduled' }).
 * Uses selfImprovementLastRunAt from project settings to avoid duplicate runs.
 */

import { ProjectService } from "./project.service.js";
import { selfImprovementService } from "./self-improvement.service.js";
import { createLogger } from "../utils/logger.js";
import { runGovernanceCongress } from "./congress.service.js";
import { governanceService } from "./governance.service.js";

const log = createLogger("self-improvement-scheduler");

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let schedulerRunning = false;
const projectService = new ProjectService();

/** Start of current calendar day in UTC (00:00:00.000). */
function startOfTodayUTC(now: Date): Date {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  return new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
}

/** Start of current week in UTC (Sunday 00:00:00.000). */
function startOfThisWeekUTC(now: Date): Date {
  const day = now.getUTCDay(); // 0 = Sunday
  const startOfToday = startOfTodayUTC(now);
  const msPerDay = 24 * 60 * 60 * 1000;
  return new Date(startOfToday.getTime() - day * msPerDay);
}

/**
 * Run the self-improvement scheduler tick: for each project with frequency 'daily' or 'weekly',
 * if current UTC time matches the schedule and the project has not yet run in the current period,
 * call runIfDue(projectId, { trigger: 'scheduled' }).
 */
export async function runSelfImprovementTick(
  now: Date = new Date()
): Promise<{ projectId: string; triggered: boolean }[]> {
  const results: { projectId: string; triggered: boolean }[] = [];
  const utcHour = now.getUTCHours();
  const utcMinute = now.getUTCMinutes();
  const utcDay = now.getUTCDay(); // 0 = Sunday

  const isMidnightUTC = utcHour === 0 && utcMinute === 0;
  const isSundayMidnightUTC = utcDay === 0 && isMidnightUTC;

  const projects = await projectService.listProjects();

  for (const project of projects) {
    try {
      // Governance has an independent decision-event cursor and cadence.
      try {
        if (!(await governanceService.isGovernanceInactive(project.id)))
          await runGovernanceCongress(project.id);
      } catch (err) {
        log.warn("Governance congress failed; continuing self-improvement", {
          projectId: project.id,
          err,
        });
      }
      const settings = await projectService.getSettings(project.id);
      const frequency = settings.selfImprovementFrequency ?? "never";
      if (frequency !== "daily" && frequency !== "weekly") continue;

      const lastRunAt = settings.selfImprovementLastRunAt;
      const lastRunTime = lastRunAt ? new Date(lastRunAt).getTime() : 0;

      if (frequency === "daily") {
        if (!isMidnightUTC) continue;
        const todayStart = startOfTodayUTC(now).getTime();
        if (lastRunTime >= todayStart) continue; // already ran today
      } else {
        // weekly
        if (!isSundayMidnightUTC) continue;
        const weekStart = startOfThisWeekUTC(now).getTime();
        if (lastRunTime >= weekStart) continue; // already ran this week
      }

      const outcome = await selfImprovementService.runIfDue(project.id, {
        trigger: "scheduled",
      });
      results.push({ projectId: project.id, triggered: true });
      if ("tasksCreated" in outcome && outcome.tasksCreated > 0) {
        log.info("Scheduled self-improvement run completed", {
          projectId: project.id,
          projectName: project.name,
          tasksCreated: outcome.tasksCreated,
        });
      }
    } catch (err) {
      log.warn("Self-improvement tick failed for project", {
        projectId: project.id,
        err: (err as Error).message,
      });
      results.push({ projectId: project.id, triggered: false });
    }
  }

  return results;
}

function getDelayUntilNextMinute(now: Date = new Date()): number {
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);
  return next.getTime() - now.getTime();
}

function scheduleNextTick(): void {
  if (!schedulerRunning) return;

  schedulerTimer = setTimeout(async () => {
    schedulerTimer = null;
    if (!schedulerRunning) return;

    try {
      await runSelfImprovementTick();
    } catch (err) {
      log.error("Self-improvement scheduler tick error", { err: (err as Error).message });
    } finally {
      if (schedulerRunning) {
        scheduleNextTick();
      }
    }
  }, getDelayUntilNextMinute());
}

/**
 * Start the self-improvement scheduler. Runs every minute; on each tick,
 * triggers runIfDue for projects with daily/weekly frequency when due (midnight UTC / Sunday 00:00 UTC).
 */
export function startSelfImprovementScheduler(): void {
  if (schedulerRunning) {
    log.warn("Self-improvement scheduler already started");
    return;
  }

  schedulerRunning = true;
  scheduleNextTick();
  log.info("Self-improvement scheduler started");
}

/**
 * Stop the self-improvement scheduler.
 */
export function stopSelfImprovementScheduler(): void {
  const hadActiveScheduler = schedulerRunning || schedulerTimer !== null;
  schedulerRunning = false;

  if (schedulerTimer !== null) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }

  if (hadActiveScheduler) {
    log.info("Self-improvement scheduler stopped");
  }
}
