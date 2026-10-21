/**
 * WorktreeLeaseService — durable, DB-backed worktree ownership.
 *
 * Prevents recovery/cleanup from removing worktrees actively used by an agent.
 * Leases survive process restarts (unlike the old in-memory registry).
 *
 * Flow:
 *   dispatch acquires lease → agent runs → completion/failure releases lease
 *   recovery/cleanup checks lease before removing worktree
 */

import { createLogger } from "../utils/logger.js";
import { taskStore } from "./task-store.service.js";

const log = createLogger("worktree-lease");

const DEFAULT_LEASE_TTL_MS = 2 * 60 * 60_000; // 2 hours — must exceed the longest agent timeout

export interface WorktreeLease {
  worktreeKey: string;
  taskId: string;
  projectId: string;
  worktreePath: string;
  branchName: string | null;
  leaseOwner: string;
  generation: number;
  acquiredAt: string;
  expiresAt: string;
  releasedAt: string | null;
}

export class WorktreeLeaseService {
  async acquire(params: {
    worktreeKey: string;
    taskId: string;
    projectId: string;
    worktreePath: string;
    branchName?: string;
    leaseOwner: string;
    ttlMs?: number;
  }): Promise<WorktreeLease> {
    const now = new Date();
    const ttl = params.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    const expiresAt = new Date(now.getTime() + ttl);
    const lease: WorktreeLease = {
      worktreeKey: params.worktreeKey,
      taskId: params.taskId,
      projectId: params.projectId,
      worktreePath: params.worktreePath,
      branchName: params.branchName ?? null,
      leaseOwner: params.leaseOwner,
      generation: 1,
      acquiredAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      releasedAt: null,
    };

    await taskStore.runWrite(async (client) => {
      const existing = await client.query(
        "SELECT generation, lease_owner, released_at, expires_at FROM worktree_leases WHERE worktree_key = $1",
        [params.worktreeKey]
      );
      if (existing.length > 0) {
        const row = existing[0] as {
          generation: number;
          lease_owner: string;
          released_at: string | null;
          expires_at: string;
        };
        if (
          !row.released_at &&
          Date.parse(row.expires_at) > now.getTime() &&
          row.lease_owner !== params.leaseOwner
        ) {
          throw new Error("Worktree is already leased by another execution owner");
        }
        const prevGen = typeof row.generation === "number" ? row.generation : 0;
        lease.generation = prevGen + 1;
        const affected = await client.execute(
          `UPDATE worktree_leases
           SET task_id = $1, project_id = $2, worktree_path = $3, branch_name = $4,
               lease_owner = $5, generation = $6, acquired_at = $7, expires_at = $8, released_at = NULL
           WHERE worktree_key = $9 AND generation = $10 AND lease_owner = $11`,
          [
            lease.taskId,
            lease.projectId,
            lease.worktreePath,
            lease.branchName,
            lease.leaseOwner,
            lease.generation,
            lease.acquiredAt,
            lease.expiresAt,
            lease.worktreeKey,
            prevGen,
            row.lease_owner,
          ]
        );
        if (affected !== 1) throw new Error("Worktree lease changed during acquisition");
      } else {
        await client.execute(
          `INSERT INTO worktree_leases (worktree_key, task_id, project_id, worktree_path, branch_name,
             lease_owner, generation, acquired_at, expires_at, released_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)`,
          [
            lease.worktreeKey,
            lease.taskId,
            lease.projectId,
            lease.worktreePath,
            lease.branchName,
            lease.leaseOwner,
            lease.generation,
            lease.acquiredAt,
            lease.expiresAt,
          ]
        );
      }
    });

    log.info("Worktree lease acquired", {
      worktreeKey: lease.worktreeKey,
      taskId: lease.taskId,
      owner: lease.leaseOwner,
      generation: lease.generation,
    });
    return lease;
  }

  async release(worktreeKey: string, owner: string): Promise<boolean> {
    const now = new Date().toISOString();
    let released = false;
    await taskStore.runWrite(async (client) => {
      const rows = await client.query(
        "SELECT lease_owner, released_at FROM worktree_leases WHERE worktree_key = $1",
        [worktreeKey]
      );
      if (rows.length === 0) return;
      const row = rows[0] as { lease_owner: string; released_at: string | null };
      if (row.released_at) {
        released = true;
        return;
      }
      if (row.lease_owner !== owner) {
        log.warn("Lease release rejected: owner mismatch", {
          worktreeKey,
          requestedOwner: owner,
          currentOwner: row.lease_owner,
        });
        return;
      }
      await client.execute("UPDATE worktree_leases SET released_at = $1 WHERE worktree_key = $2", [
        now,
        worktreeKey,
      ]);
      released = true;
    });
    if (released) {
      log.info("Worktree lease released", { worktreeKey, owner });
    }
    return released;
  }

  async renew(worktreeKey: string, ttlMs?: number): Promise<boolean> {
    const ttl = ttlMs ?? DEFAULT_LEASE_TTL_MS;
    const newExpiresAt = new Date(Date.now() + ttl).toISOString();
    let renewed = false;
    await taskStore.runWrite(async (client) => {
      const affected = await client.execute(
        "UPDATE worktree_leases SET expires_at = $1 WHERE worktree_key = $2 AND released_at IS NULL",
        [newExpiresAt, worktreeKey]
      );
      renewed = affected > 0;
    });
    return renewed;
  }

  async forceRelease(worktreeKey: string): Promise<void> {
    const now = new Date().toISOString();
    await taskStore.runWrite(async (client) => {
      await client.execute(
        "UPDATE worktree_leases SET released_at = $1 WHERE worktree_key = $2 AND released_at IS NULL",
        [now, worktreeKey]
      );
    });
  }

  /**
   * Check whether a worktree can be safely cleaned up.
   * Returns true if no active (non-expired, non-released) lease exists.
   */
  async canCleanup(worktreeKey: string): Promise<boolean> {
    const client = await taskStore.getDb();
    const rows = await client.query(
      "SELECT expires_at, released_at FROM worktree_leases WHERE worktree_key = $1",
      [worktreeKey]
    );
    if (rows.length === 0) return true;
    const row = rows[0] as { expires_at: string; released_at: string | null };
    if (row.released_at) return true;
    const expiresMs = Date.parse(row.expires_at);
    return Number.isFinite(expiresMs) && expiresMs <= Date.now();
  }

  async get(worktreeKey: string): Promise<WorktreeLease | null> {
    const client = await taskStore.getDb();
    const rows = await client.query("SELECT * FROM worktree_leases WHERE worktree_key = $1", [
      worktreeKey,
    ]);
    if (rows.length === 0) return null;
    return this.rowToLease(rows[0]);
  }

  async getActiveForProject(projectId: string): Promise<WorktreeLease[]> {
    const client = await taskStore.getDb();
    const now = new Date().toISOString();
    const rows = await client.query(
      "SELECT * FROM worktree_leases WHERE project_id = $1 AND released_at IS NULL AND expires_at > $2",
      [projectId, now]
    );
    return rows.map((r) => this.rowToLease(r));
  }

  private rowToLease(row: unknown): WorktreeLease {
    const r = row as Record<string, unknown>;
    return {
      worktreeKey: r.worktree_key as string,
      taskId: r.task_id as string,
      projectId: r.project_id as string,
      worktreePath: r.worktree_path as string,
      branchName: (r.branch_name as string) ?? null,
      leaseOwner: r.lease_owner as string,
      generation: r.generation as number,
      acquiredAt: r.acquired_at as string,
      expiresAt: r.expires_at as string,
      releasedAt: (r.released_at as string) ?? null,
    };
  }
}

export const worktreeLeaseService = new WorktreeLeaseService();
