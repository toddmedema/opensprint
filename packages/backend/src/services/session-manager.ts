import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import { heartbeatService } from "./heartbeat.service.js";
import type { AgentSession, AgentSessionStatus, TestResults, AgentType } from "@opensprint/shared";
import { ensureRuntimeDir, getRuntimePath } from "../utils/runtime-dir.js";
import { taskStore } from "./task-store.service.js";
import { ProjectService } from "./project.service.js";
import {
  computeLogDiff95thPercentile,
  truncateToThreshold,
} from "../utils/log-diff-truncation.js";

const projectService = new ProjectService();

async function repoPathToProjectId(repoPath: string): Promise<string> {
  const project = await projectService.getProjectByRepoPath(repoPath);
  if (project) return project.id;
  return "repo:" + crypto.createHash("sha256").update(repoPath).digest("hex").slice(0, 12);
}

/**
 * Manages active task directories and session archival.
 */
export class SessionManager {
  /**
   * Get the active task directory path.
   */
  getActiveDir(repoPath: string, taskId: string): string {
    return path.join(repoPath, OPENSPRINT_PATHS.active, taskId);
  }

  /**
   * Read the result.json from a completed agent run.
   */
  async readResult(repoPath: string, taskId: string): Promise<unknown | null> {
    const resultPath = path.join(this.getActiveDir(repoPath, taskId), "result.json");
    try {
      const raw = await fs.readFile(resultPath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Remove stale result.json from a previous run so the orchestrator
   * doesn't mistakenly read it after a new agent invocation.
   */
  async clearResult(repoPath: string, taskId: string): Promise<void> {
    const resultPath = path.join(this.getActiveDir(repoPath, taskId), "result.json");
    try {
      await fs.unlink(resultPath);
    } catch {
      // File may not exist
    }
  }

  /**
   * Create and save an agent session record.
   */
  async createSession(
    repoPath: string,
    params: {
      taskId: string;
      attempt: number;
      agentType: AgentType;
      agentModel: string;
      gitBranch: string;
      status: AgentSessionStatus;
      outputLog: string;
      gitDiff?: string;
      summary?: string;
      testResults?: TestResults;
      failureReason?: string;
      startedAt: string;
    }
  ): Promise<AgentSession> {
    const session: AgentSession = {
      taskId: params.taskId,
      attempt: params.attempt,
      agentType: params.agentType,
      agentModel: params.agentModel,
      startedAt: params.startedAt,
      completedAt: new Date().toISOString(),
      status: params.status,
      outputLog: params.outputLog,
      gitBranch: params.gitBranch,
      gitDiff: params.gitDiff ?? null,
      testResults: params.testResults ?? null,
      failureReason: params.failureReason ?? null,
      summary: params.summary,
    };

    return session;
  }

  /**
   * Archive the active task directory to sessions.
   *
   * @param repoPath - Main repository path (session archive is always written here)
   * @param taskId - Task identifier
   * @param attempt - Attempt number
   * @param session - Session data
   * @param worktreePath - Optional worktree path where the agent wrote active files.
   *                       If provided, active files are read from the worktree instead of repoPath.
   */
  async archiveSession(
    repoPath: string,
    taskId: string,
    attempt: number,
    session: AgentSession,
    worktreePath?: string
  ): Promise<void> {
    const projectId = await repoPathToProjectId(repoPath);
    await taskStore.runWrite(async (client) => {
      const threshold = await computeLogDiff95thPercentile(client);
      const truncatedOutputLog = truncateToThreshold(session.outputLog, threshold);
      const truncatedGitDiff = truncateToThreshold(session.gitDiff, threshold);

      await client.execute(
        `INSERT INTO agent_sessions (project_id, task_id, attempt, agent_type, agent_model, started_at, completed_at, status, output_log, git_branch, git_diff, test_results, failure_reason, summary)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          projectId,
          taskId,
          attempt,
          session.agentType,
          session.agentModel,
          session.startedAt,
          session.completedAt ?? null,
          session.status,
          truncatedOutputLog ?? null,
          session.gitBranch,
          truncatedGitDiff ?? null,
          session.testResults ? JSON.stringify(session.testResults) : null,
          session.failureReason ?? null,
          session.summary ?? null,
        ]
      );
    });

    // Active files live in the worktree (if provided), archive goes to runtime dir (outside repo)
    const activeDirSource = this.getActiveDir(worktreePath ?? repoPath, taskId);
    await ensureRuntimeDir(repoPath);
    const sessionDir = path.join(
      getRuntimePath(repoPath, OPENSPRINT_PATHS.sessions),
      `${taskId}-${attempt}`
    );

    // Copy active directory contents to session archive (log file etc.)
    await fs.mkdir(sessionDir, { recursive: true });

    // Clean up heartbeat and assignment files before archiving (runtime state, not useful in archive)
    await heartbeatService.deleteHeartbeat(worktreePath ?? repoPath, taskId);
    try {
      await fs.unlink(path.join(activeDirSource, OPENSPRINT_PATHS.assignment));
    } catch {
      // May not exist
    }

    // Copy active directory contents to session archive (agent-output.log, prompt.md, etc.)
    try {
      const files = await fs.readdir(activeDirSource);
      for (const file of files) {
        if (file === OPENSPRINT_PATHS.heartbeat) continue;
        const srcPath = path.join(activeDirSource, file);
        const destPath = path.join(sessionDir, file);
        const stat = await fs.stat(srcPath);
        if (stat.isFile()) {
          await fs.copyFile(srcPath, destPath);
        }
      }
    } catch {
      // Active directory might not exist
    }

    // Clean up active directory in the worktree (if it was there)
    try {
      await fs.rm(activeDirSource, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    // Also clean up in main repo if different from worktree
    if (worktreePath) {
      try {
        const mainActiveDir = this.getActiveDir(repoPath, taskId);
        await fs.rm(mainActiveDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Read an archived session from DB.
   */
  async readSession(
    repoPath: string,
    taskId: string,
    attempt: number
  ): Promise<AgentSession | null> {
    const projectId = await repoPathToProjectId(repoPath);
    const client = await taskStore.getDb();
    const row = await client.queryOne(
      "SELECT task_id, attempt, agent_type, agent_model, started_at, completed_at, status, output_log, git_branch, git_diff, test_results, failure_reason, summary FROM agent_sessions WHERE project_id = $1 AND task_id = $2 AND attempt = $3",
      [projectId, taskId, attempt]
    );
    if (!row) return null;
    return rowToSession(row as Record<string, unknown>);
  }

  /**
   * List all sessions for a task from DB.
   */
  async listSessions(repoPath: string, taskId: string): Promise<AgentSession[]> {
    const projectId = await repoPathToProjectId(repoPath);
    const client = await taskStore.getDb();
    const rows = await client.query(
      "SELECT task_id, attempt, agent_type, agent_model, started_at, completed_at, status, output_log, git_branch, git_diff, test_results, failure_reason, summary FROM agent_sessions WHERE project_id = $1 AND task_id = $2 ORDER BY attempt ASC",
      [projectId, taskId]
    );
    return rows.map((r) => rowToSession(r as Record<string, unknown>));
  }

  /**
   * Load all sessions for the project from DB, grouped by task ID.
   */
  async loadSessionsGroupedByTaskId(repoPath: string): Promise<Map<string, AgentSession[]>> {
    const projectId = await repoPathToProjectId(repoPath);
    const client = await taskStore.getDb();
    const rows = await client.query(
      "SELECT task_id, attempt, agent_type, agent_model, started_at, completed_at, status, output_log, git_branch, git_diff, test_results, failure_reason, summary FROM agent_sessions WHERE project_id = $1 ORDER BY task_id, attempt ASC",
      [projectId]
    );
    const result = new Map<string, AgentSession[]>();
    for (const row of rows) {
      const session = rowToSession(row as Record<string, unknown>);
      const taskId = session.taskId;
      let arr = result.get(taskId);
      if (!arr) {
        arr = [];
        result.set(taskId, arr);
      }
      arr.push(session);
    }
    return result;
  }

  /**
   * Load only latest attempt's test_results per task for list enrichment.
   * One row per task (no output_log/git_diff). Keeps Map shape for enrichTasksWithTestResultsFromMap.
   */
  async loadSessionsTestResultsOnlyGroupedByTaskId(
    repoPath: string
  ): Promise<Map<string, Array<{ testResults: TestResults | null }>>> {
    const projectId = await repoPathToProjectId(repoPath);
    const client = await taskStore.getDb();
    const rows = await client.query(
      `SELECT a.task_id, a.attempt, a.test_results
       FROM agent_sessions a
       INNER JOIN (
         SELECT project_id, task_id, MAX(attempt) AS max_attempt
         FROM agent_sessions
         WHERE project_id = $1
         GROUP BY project_id, task_id
       ) b ON a.project_id = b.project_id AND a.task_id = b.task_id AND a.attempt = b.max_attempt
       WHERE a.project_id = $2`,
      [projectId, projectId]
    );
    const result = new Map<string, Array<{ testResults: TestResults | null }>>();
    for (const row of rows) {
      const taskId = row.task_id as string;
      const testResults = row.test_results
        ? (JSON.parse(row.test_results as string) as TestResults)
        : null;
      result.set(taskId, [{ testResults }]);
    }
    return result;
  }
}

function rowToSession(row: Record<string, unknown>): AgentSession {
  return {
    taskId: row.task_id as string,
    attempt: row.attempt as number,
    agentType: row.agent_type as AgentSession["agentType"],
    agentModel: row.agent_model as string,
    startedAt: row.started_at as string,
    completedAt: (row.completed_at as string) ?? null,
    status: row.status as AgentSession["status"],
    outputLog: (row.output_log as string) ?? "",
    gitBranch: row.git_branch as string,
    gitDiff: (row.git_diff as string) ?? null,
    testResults: row.test_results
      ? (JSON.parse(row.test_results as string) as AgentSession["testResults"])
      : null,
    failureReason: (row.failure_reason as string) ?? null,
    summary: row.summary as string | undefined,
  };
}
