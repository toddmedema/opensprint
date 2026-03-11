/**
 * OrchestratorStatusService — builds activeTasks from slots and persists/loads counters.
 * Extracted from OrchestratorService for clarity and testability.
 */

import type { OrchestratorStatus } from "@opensprint/shared";
import { REVIEW_ANGLE_OPTIONS } from "@opensprint/shared";
import { taskStore as taskStoreSingleton } from "./task-store.service.js";
import type { ProjectService } from "./project.service.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("orchestrator-status");

const REVIEW_AGENT_ID_DELIMITER = "--review--";

/** Angle label for display (used by status and getActiveAgents). */
export const REVIEW_ANGLE_ACTIVE_LABELS: Record<string, string> = {
  security: "Security",
  performance: "Performance",
  test_coverage: "Test Coverage",
  code_quality: "Code Quality",
  design_ux_accessibility: "Design/UX",
};

/** Build stable ID for a review sub-agent (used by status, killAgent, getActiveAgents). */
export function buildReviewAgentId(taskId: string, angle: string): string {
  return `${taskId}${REVIEW_AGENT_ID_DELIMITER}${angle}`;
}

/** Minimal slot shape needed to build activeTasks (avoids importing full AgentSlot/OrchestratorState). */
export interface SlotForStatus {
  taskId: string;
  taskTitle: string | null;
  phase: "coding" | "review";
  agent: {
    startedAt: string;
    lifecycleState: string;
    lastOutputAtIso?: string;
    suspendedAtIso?: string;
    suspendReason?: string;
  };
  reviewAgents?: Map<
    string,
    {
      angle: string;
      agent: {
        startedAt: string;
        lifecycleState: string;
        lastOutputAtIso?: string;
        suspendedAtIso?: string;
        suspendReason?: string;
      };
    }
  >;
}

export interface StateForStatus {
  slots: Map<string, SlotForStatus>;
  status: { queueDepth: number; totalDone: number; totalFailed: number };
}

export interface OrchestratorCounters {
  totalDone: number;
  totalFailed: number;
  queueDepth: number;
}

export class OrchestratorStatusService {
  constructor(
    private taskStore: typeof taskStoreSingleton,
    private projectService: ProjectService
  ) {}

  /** Build activeTasks array from current slots for status/broadcast. */
  buildActiveTasks(state: StateForStatus): OrchestratorStatus["activeTasks"] {
    const tasks: OrchestratorStatus["activeTasks"] = [];
    for (const slot of state.slots.values()) {
      if (slot.phase === "review" && slot.reviewAgents && slot.reviewAgents.size > 0) {
        for (const reviewAgent of slot.reviewAgents.values()) {
          const angleLabel =
            REVIEW_ANGLE_ACTIVE_LABELS[reviewAgent.angle] ??
            REVIEW_ANGLE_OPTIONS.find((o) => o.value === reviewAgent.angle)?.label ??
            reviewAgent.angle;
          tasks.push({
            taskId: slot.taskId,
            phase: slot.phase,
            startedAt: reviewAgent.agent.startedAt || new Date().toISOString(),
            state: reviewAgent.agent.lifecycleState,
            id: buildReviewAgentId(slot.taskId, reviewAgent.angle),
            name: `Reviewer (${angleLabel})`,
            ...(reviewAgent.agent.lastOutputAtIso
              ? { lastOutputAt: reviewAgent.agent.lastOutputAtIso }
              : {}),
            ...(reviewAgent.agent.suspendedAtIso
              ? { suspendedAt: reviewAgent.agent.suspendedAtIso }
              : {}),
            ...(reviewAgent.agent.suspendReason
              ? { suspendReason: reviewAgent.agent.suspendReason }
              : {}),
          });
        }
        continue;
      }
      tasks.push({
        taskId: slot.taskId,
        phase: slot.phase,
        startedAt: slot.agent.startedAt || new Date().toISOString(),
        state: slot.agent.lifecycleState,
        ...(slot.agent.lastOutputAtIso ? { lastOutputAt: slot.agent.lastOutputAtIso } : {}),
        ...(slot.agent.suspendedAtIso ? { suspendedAt: slot.agent.suspendedAtIso } : {}),
        ...(slot.agent.suspendReason ? { suspendReason: slot.agent.suspendReason } : {}),
      });
    }
    return tasks;
  }

  /** Persist orchestrator counters to DB. */
  async persistCounters(
    projectId: string,
    _repoPath: string,
    state: StateForStatus
  ): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.taskStore.runWrite(async (client) => {
        await client.execute(
          `INSERT INTO orchestrator_counters (project_id, total_done, total_failed, queue_depth, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT(project_id) DO UPDATE SET
             total_done = excluded.total_done,
             total_failed = excluded.total_failed,
             queue_depth = excluded.queue_depth,
             updated_at = excluded.updated_at`,
          [
            projectId,
            state.status.totalDone,
            state.status.totalFailed,
            state.status.queueDepth,
            now,
          ]
        );
      });
    } catch (err) {
      log.warn("Failed to persist counters", { err });
    }
  }

  /** Load counters from DB by repo path (resolves projectId internally). */
  async loadCounters(repoPath: string): Promise<OrchestratorCounters | null> {
    const project = await this.projectService.getProjectByRepoPath(repoPath);
    if (!project) return null;
    const client = await this.taskStore.getDb();
    const row = await client.queryOne(
      "SELECT total_done, total_failed, queue_depth FROM orchestrator_counters WHERE project_id = $1",
      [project.id]
    );
    if (!row) return null;
    return {
      totalDone: row.total_done as number,
      totalFailed: row.total_failed as number,
      queueDepth: row.queue_depth as number,
    };
  }
}
