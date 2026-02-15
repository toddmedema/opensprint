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
   */
  async archiveSession(
    repoPath: string,
    taskId: string,
    attempt: number,
    session: AgentSession,
  ): Promise<void> {
    const activeDir = this.getActiveDir(repoPath, taskId);
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
      const files = await fs.readdir(activeDir);
      for (const file of files) {
        const srcPath = path.join(activeDir, file);
        const destPath = path.join(sessionDir, file);
        const stat = await fs.stat(srcPath);
        if (stat.isFile()) {
          await fs.copyFile(srcPath, destPath);
        }
      }
    } catch {
      // Active directory might not exist
    }

    // Clean up active directory
    try {
      await fs.rm(activeDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
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
