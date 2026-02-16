import fs from 'fs/promises';
import path from 'path';
import { OPENSPRINT_PATHS } from '@opensprint/shared';
import type { AgentSession, AgentSessionStatus, TestResults, AgentType } from '@opensprint/shared';

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
    const resultPath = path.join(this.getActiveDir(repoPath, taskId), 'result.json');
    try {
      const raw = await fs.readFile(resultPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
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
    },
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
    worktreePath?: string,
  ): Promise<void> {
    // Active files live in the worktree (if provided), archive goes to main repo
    const activeDirSource = this.getActiveDir(worktreePath ?? repoPath, taskId);
    const sessionDir = path.join(
      repoPath,
      OPENSPRINT_PATHS.sessions,
      `${taskId}-${attempt}`,
    );

    // Write session metadata
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionDir, 'session.json'),
      JSON.stringify(session, null, 2),
    );

    // Copy active directory contents to session archive
    try {
      const files = await fs.readdir(activeDirSource);
      for (const file of files) {
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
   * Read an archived session.
   */
  async readSession(
    repoPath: string,
    taskId: string,
    attempt: number,
  ): Promise<AgentSession | null> {
    const sessionPath = path.join(
      repoPath,
      OPENSPRINT_PATHS.sessions,
      `${taskId}-${attempt}`,
      'session.json',
    );
    try {
      const raw = await fs.readFile(sessionPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * List all sessions for a task.
   */
  async listSessions(repoPath: string, taskId: string): Promise<AgentSession[]> {
    const sessionsDir = path.join(repoPath, OPENSPRINT_PATHS.sessions);
    const sessions: AgentSession[] = [];

    try {
      const entries = await fs.readdir(sessionsDir);
      for (const entry of entries) {
        if (entry.startsWith(`${taskId}-`)) {
          const sessionPath = path.join(sessionsDir, entry, 'session.json');
          try {
            const raw = await fs.readFile(sessionPath, 'utf-8');
            sessions.push(JSON.parse(raw));
          } catch {
            // Skip broken sessions
          }
        }
      }
    } catch {
      // No sessions directory
    }

    return sessions.sort((a, b) => a.attempt - b.attempt);
  }
}
