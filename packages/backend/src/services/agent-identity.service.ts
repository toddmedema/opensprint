/**
 * Agent identity and performance tracking service.
 *
 * Records task attempt outcomes and uses that history to make smarter retry
 * decisions — including model escalation when the same failure type repeats.
 * Stats are persisted in the SQL DB (agent_stats table).
 */

import crypto from "crypto";
import type { AgentConfig, ProjectSettings } from "@opensprint/shared";
import { getAgentForComplexity } from "@opensprint/shared";
import type { PlanComplexity } from "@opensprint/shared";
import { createLogger } from "../utils/logger.js";
import { taskStore } from "./task-store.service.js";
import { ProjectService } from "./project.service.js";

const log = createLogger("agent-identity");
const projectService = new ProjectService();

async function repoPathToProjectId(repoPath: string): Promise<string> {
  const project = await projectService.getProjectByRepoPath(repoPath);
  if (project) return project.id;
  return "repo:" + crypto.createHash("sha256").update(repoPath).digest("hex").slice(0, 12);
}

export type AttemptOutcome =
  | "success"
  | "test_failure"
  | "review_rejection"
  | "crash"
  | "timeout"
  | "no_result"
  | "coding_failure";

export interface TaskAttemptRecord {
  taskId: string;
  agentId: string;
  model: string;
  attempt: number;
  startedAt: string;
  completedAt: string;
  outcome: AttemptOutcome;
  durationMs: number;
}

export interface AgentProfile {
  id: string;
  model: string;
  stats: {
    tasksAttempted: number;
    tasksSucceeded: number;
    tasksFailed: number;
    avgTimeToComplete: number;
    failuresByType: Record<string, number>;
  };
}

/** Known model escalation ladder (from faster/cheaper to more capable) */
const MODEL_ESCALATION: string[] = ["claude-sonnet-4-20250514", "claude-opus-4-20250514"];

export class AgentIdentityService {
  async recordAttempt(repoPath: string, record: TaskAttemptRecord): Promise<void> {
    const projectId = await repoPathToProjectId(repoPath);
    await taskStore.runWrite(async (client) => {
      await client.execute(
        `INSERT INTO agent_stats (project_id, task_id, agent_id, model, attempt, started_at, completed_at, outcome, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          projectId,
          record.taskId,
          record.agentId,
          record.model,
          record.attempt,
          record.startedAt,
          record.completedAt,
          record.outcome,
          record.durationMs,
        ]
      );
      const countRow = await client.queryOne(
        "SELECT COUNT(*)::int as c FROM agent_stats WHERE project_id = $1",
        [projectId]
      );
      const count = (countRow?.c as number) ?? 0;
      if (count > 500) {
        await client.execute(
          `DELETE FROM agent_stats WHERE id IN (
            SELECT id FROM agent_stats WHERE project_id = $1 ORDER BY id ASC LIMIT $2
          )`,
          [projectId, count - 500]
        );
      }
    });
  }

  async getProfile(repoPath: string, agentId: string): Promise<AgentProfile> {
    const projectId = await repoPathToProjectId(repoPath);
    const records = await this.loadAttempts(projectId);
    const byAgent = records.filter((a) => a.agentId === agentId);

    const succeeded = byAgent.filter((r) => r.outcome === "success");
    const failed = byAgent.filter((r) => r.outcome !== "success");
    const failuresByType: Record<string, number> = {};
    for (const r of failed) {
      failuresByType[r.outcome] = (failuresByType[r.outcome] || 0) + 1;
    }

    const totalDuration = succeeded.reduce((sum, r) => sum + r.durationMs, 0);

    return {
      id: agentId,
      model: byAgent.at(-1)?.model ?? "unknown",
      stats: {
        tasksAttempted: byAgent.length,
        tasksSucceeded: succeeded.length,
        tasksFailed: failed.length,
        avgTimeToComplete: succeeded.length > 0 ? totalDuration / succeeded.length : 0,
        failuresByType,
      },
    };
  }

  /**
   * Select the best agent config for a retry attempt.
   * Escalates to a more capable model when the same failure type repeats.
   */
  selectAgentForRetry(
    settings: ProjectSettings,
    taskId: string,
    attempt: number,
    failureType: string,
    complexity: PlanComplexity | undefined,
    recentAttempts: TaskAttemptRecord[]
  ): AgentConfig {
    const baseConfig = getAgentForComplexity(settings, complexity);

    // Attempt 1-2: use the configured model
    if (attempt <= 2) return baseConfig;

    // Count consecutive same-type failures for this task
    const taskAttempts = recentAttempts
      .filter((a) => a.taskId === taskId)
      .sort((a, b) => a.attempt - b.attempt);

    const consecutiveSameType = taskAttempts
      .slice()
      .reverse()
      .findIndex((a) => a.outcome !== failureType);
    const sameTypeCount = consecutiveSameType === -1 ? taskAttempts.length : consecutiveSameType;

    // 3+ consecutive failures of the same type: escalate model (Claude only)
    // Cursor and custom agents only accept their own model IDs; do not substitute Claude models.
    if (
      sameTypeCount >= 2 &&
      baseConfig.model &&
      (baseConfig.type === "claude" || baseConfig.type === "claude-cli")
    ) {
      const escalated = this.escalateModel(baseConfig.model);
      if (escalated && escalated !== baseConfig.model) {
        log.info("Escalating model", {
          taskId,
          from: baseConfig.model,
          to: escalated,
          sameTypeCount,
          failureType,
        });
        return { ...baseConfig, model: escalated };
      }
    }

    return baseConfig;
  }

  async getRecentAttempts(repoPath: string, taskId: string): Promise<TaskAttemptRecord[]> {
    const projectId = await repoPathToProjectId(repoPath);
    const records = await this.loadAttempts(projectId);
    return records.filter((a) => a.taskId === taskId);
  }

  private async loadAttempts(projectId: string): Promise<TaskAttemptRecord[]> {
    const client = await taskStore.getDb();
    const rows = await client.query(
      "SELECT task_id, agent_id, model, attempt, started_at, completed_at, outcome, duration_ms FROM agent_stats WHERE project_id = $1 ORDER BY id ASC",
      [projectId]
    );
    return rows.map((r) => ({
      taskId: r.task_id as string,
      agentId: r.agent_id as string,
      model: r.model as string,
      attempt: r.attempt as number,
      startedAt: r.started_at as string,
      completedAt: r.completed_at as string,
      outcome: r.outcome as AttemptOutcome,
      durationMs: r.duration_ms as number,
    }));
  }

  private escalateModel(currentModel: string): string | null {
    const idx = MODEL_ESCALATION.findIndex((m) => currentModel.includes(m.split("-")[1]!));
    if (idx >= 0 && idx < MODEL_ESCALATION.length - 1) {
      return MODEL_ESCALATION[idx + 1]!;
    }
    // If model not in ladder or already at max, return the last (most capable)
    if (idx === -1) return MODEL_ESCALATION.at(-1) ?? null;
    return null;
  }
}

export const agentIdentityService = new AgentIdentityService();
