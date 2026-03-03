import fs from "fs/promises";
import path from "path";
import { OPENSPRINT_PATHS, HEARTBEAT_STALE_MS } from "@opensprint/shared";
import { writeJsonAtomic } from "../utils/file-utils.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("heartbeat");

/** Heartbeat file contents written during agent execution */
export interface HeartbeatData {
  processGroupLeaderPid: number;
  lastOutputTimestamp: number;
  heartbeatTimestamp: number;
}

/**
 * Manages heartbeat files for agent process liveness detection.
 * Heartbeat files are written to .opensprint/active/<task-id>/heartbeat.json
 * every 10 seconds during agent execution.
 */
export class HeartbeatService {
  /**
   * Get the path to the heartbeat file for a task.
   */
  getHeartbeatPath(repoPath: string, taskId: string): string {
    return path.join(repoPath, OPENSPRINT_PATHS.active, taskId, OPENSPRINT_PATHS.heartbeat);
  }

  /**
   * Write a heartbeat file. Uses atomic write (tmp + rename) to prevent corruption.
   */
  async writeHeartbeat(repoPath: string, taskId: string, data: HeartbeatData): Promise<void> {
    const heartbeatPath = this.getHeartbeatPath(repoPath, taskId);
    const dir = path.dirname(heartbeatPath);

    try {
      await fs.mkdir(dir, { recursive: true });
      await writeJsonAtomic(heartbeatPath, data);
    } catch (err) {
      log.warn("Failed to write heartbeat", { err });
    }
  }

  /**
   * Read heartbeat data. Returns null if file doesn't exist or is invalid.
   */
  async readHeartbeat(repoPath: string, taskId: string): Promise<HeartbeatData | null> {
    const heartbeatPath = this.getHeartbeatPath(repoPath, taskId);
    try {
      const raw = await fs.readFile(heartbeatPath, "utf-8");
      const data = JSON.parse(raw) as HeartbeatData;
      if (
        typeof data.processGroupLeaderPid === "number" &&
        typeof data.lastOutputTimestamp === "number" &&
        typeof data.heartbeatTimestamp === "number"
      ) {
        return data;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check if a heartbeat is stale (older than maxAgeMs).
   * Default: 2 minutes (HEARTBEAT_STALE_MS).
   */
  isStale(heartbeat: HeartbeatData, maxAgeMs: number = HEARTBEAT_STALE_MS): boolean {
    return Date.now() - heartbeat.heartbeatTimestamp > maxAgeMs;
  }

  /**
   * Delete the heartbeat file. Safe to call if file doesn't exist.
   */
  async deleteHeartbeat(repoPath: string, taskId: string): Promise<void> {
    const heartbeatPath = this.getHeartbeatPath(repoPath, taskId);
    try {
      await fs.unlink(heartbeatPath);
    } catch {
      // File may not exist
    }
  }

  /**
   * Find all worktrees with stale heartbeat files.
   * Scans the worktree base directory for task directories and checks heartbeat age.
   *
   * @param worktreeBasePath - Base path for worktrees (e.g. os.tmpdir()/opensprint-worktrees)
   * @returns Array of { taskId, heartbeat } for stale heartbeats
   */
  async findStaleHeartbeats(
    worktreeBasePath: string
  ): Promise<Array<{ taskId: string; heartbeat: HeartbeatData }>> {
    const stale: Array<{ taskId: string; heartbeat: HeartbeatData }> = [];

    try {
      const entries = await fs.readdir(worktreeBasePath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const taskId = entry.name;
        const wtPath = path.join(worktreeBasePath, taskId);
        const heartbeat = await this.readHeartbeat(wtPath, taskId);
        if (heartbeat && this.isStale(heartbeat)) {
          stale.push({ taskId, heartbeat });
        }
      }
    } catch {
      // Directory may not exist
    }

    return stale;
  }
}

export const heartbeatService = new HeartbeatService();
