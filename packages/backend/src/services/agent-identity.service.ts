/**
 * Agent identity and performance tracking service.
 *
 * Records task attempt outcomes and uses that history to make smarter retry
 * decisions — including model escalation when the same failure type repeats.
 * Stats are persisted in the SQL DB (agent_stats table).
 */

import crypto from "crypto";
import type { AgentConfig, AgentRole, ProjectSettings } from "@opensprint/shared";
import { getAgentForComplexity } from "@opensprint/shared";
import type { PlanComplexity } from "@opensprint/shared";
import { createLogger } from "../utils/logger.js";
import { taskStore } from "./task-store.service.js";
import { ProjectService } from "./project.service.js";

const log = createLogger("agent-identity");
const projectService = new ProjectService();
const repoPathProjectIdCache = new Map<string, string>();
const agentStatsCountCache = new Map<string, number>();

async function repoPathToProjectId(repoPath: string): Promise<string> {
  const cached = repoPathProjectIdCache.get(repoPath);
  if (cached) return cached;

  const project = await projectService.getProjectByRepoPath(repoPath);
  const projectId =
    project?.id ??
    "repo:" + crypto.createHash("sha256").update(repoPath).digest("hex").slice(0, 12);
  repoPathProjectIdCache.set(repoPath, projectId);
  return projectId;
}

export type AttemptOutcome =
  | "success"
  | "test_failure"
  | "review_rejection"
  | "crash"
  | "repo_preflight"
  | "environment_setup"
  | "timeout"
  | "no_result"
  | "coding_failure";

export interface TaskAttemptRecord {
  taskId: string;
  agentId: string;
  /** Agent role/type (e.g. coder, reviewer) for display in Agent log */
  role?: AgentRole;
  model: string;
  attempt: number;
  startedAt: string;
  completedAt: string;
  outcome: AttemptOutcome;
  durationMs: number;
}

export interface TaskAttemptStartRecord {
  taskId: string;
  agentId: string;
  role?: AgentRole;
  model: string;
  attempt: number;
  startedAt: string;
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
const MODEL_ESCALATION: string[] = ["claude-sonnet-5-5", "claude-opus-5-5"];

export function buildAgentAttemptId(
  agentConfig: { type: string; model?: string | null },
  role: AgentRole,
  options?: { reviewScope?: string }
): string {
  const baseId = `${agentConfig.type}-${agentConfig.model ?? "default"}`;
  if (role !== "reviewer") return baseId;
  return `${baseId}-review-${options?.reviewScope ?? "general"}`;
}

export class AgentIdentityService {
  private async upsertAttempt(
    client: Awaited<ReturnType<typeof taskStore.getDb>>,
    projectId: string,
    record: TaskAttemptRecord
  ): Promise<boolean> {
    const existing = await client.queryOne(
      `SELECT id
         FROM agent_stats
        WHERE project_id = $1
          AND task_id = $2
          AND attempt = $3
          AND agent_id = $4
          AND COALESCE(role, '') = COALESCE($5, '')
        ORDER BY id DESC
        LIMIT 1`,
      [projectId, record.taskId, record.attempt, record.agentId, record.role ?? null]
    );

    if (existing?.id != null) {
      await client.execute(
        `UPDATE agent_stats
            SET agent_id = $1,
                role = $2,
                model = $3,
                started_at = $4,
                completed_at = $5,
                outcome = $6,
                duration_ms = $7
          WHERE id = $8`,
        [
          record.agentId,
          record.role ?? null,
          record.model,
          record.startedAt,
          record.completedAt,
          record.outcome,
          record.durationMs,
          existing.id,
        ]
      );
      return false;
    }

    await client.execute(
      `INSERT INTO agent_stats (project_id, task_id, agent_id, role, model, attempt, started_at, completed_at, outcome, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        projectId,
        record.taskId,
        record.agentId,
        record.role ?? null,
        record.model,
        record.attempt,
        record.startedAt,
        record.completedAt,
        record.outcome,
        record.durationMs,
      ]
    );
    return true;
  }

  async recordAttemptStarted(repoPath: string, record: TaskAttemptStartRecord): Promise<void> {
    await this.recordAttempt(repoPath, {
      ...record,
      completedAt: record.startedAt,
      outcome: "no_result",
      durationMs: 0,
    });
  }

  async recordAttempt(repoPath: string, record: TaskAttemptRecord): Promise<void> {
    const projectId = await repoPathToProjectId(repoPath);
    await taskStore.runWrite(async (client) => {
      let recordCount = agentStatsCountCache.get(projectId);
      if (recordCount == null) {
        const countRow = await client.queryOne(
          "SELECT COUNT(*)::int AS c FROM agent_stats WHERE project_id = $1",
          [projectId]
        );
        recordCount = Number(countRow?.c ?? 0);
      }

      const insertedNewRow = await this.upsertAttempt(client, projectId, record);
      if (!insertedNewRow) return;

      const nextCount = recordCount + 1;
      if (nextCount > 500) {
        const overflow = nextCount - 500;
        await client.execute(
          `DELETE FROM agent_stats
           WHERE project_id = $1
             AND id IN (
               SELECT id FROM agent_stats
               WHERE project_id = $1
               ORDER BY id ASC
               LIMIT $2
             )`,
          [projectId, overflow]
        );
        agentStatsCountCache.set(projectId, 500);
      } else {
        agentStatsCountCache.set(projectId, nextCount);
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
      const escalated =
        baseConfig.type === "claude-cli"
          ? /haiku|sonnet/i.test(baseConfig.model)
            ? "opus"
            : null
          : this.escalateModel(baseConfig.model);
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
