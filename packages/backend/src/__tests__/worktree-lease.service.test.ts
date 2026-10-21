import { describe, it, expect, beforeEach, vi } from "vitest";
import type { WorktreeLease } from "../services/worktree-lease.service.js";

type LeaseRow = {
  worktree_key: string;
  task_id: string;
  project_id: string;
  worktree_path: string;
  branch_name: string | null;
  lease_owner: string;
  generation: number;
  acquired_at: string;
  expires_at: string;
  released_at: string | null;
};

/**
 * In-memory row store that intercepts the SQL calls the lease service
 * makes via taskStore.runWrite / taskStore.getDb.
 */
function createInMemoryLeaseStore() {
  const rows = new Map<string, LeaseRow>();

  function matchRow(sql: string, params: unknown[]): unknown[] | number {
    const norm = sql.toLowerCase();

    // SELECT ... FROM worktree_leases WHERE worktree_key = $1  (used by acquire, release, get, canCleanup)
    if (
      norm.includes("select") &&
      norm.includes("worktree_leases") &&
      norm.includes("worktree_key") &&
      !norm.includes("project_id")
    ) {
      const key = params[0] as string;
      const row = rows.get(key);
      return row ? [{ ...row }] : [];
    }

    // SELECT ... FROM worktree_leases WHERE project_id = $1 AND released_at IS NULL AND expires_at > $2
    if (
      norm.includes("select") &&
      norm.includes("worktree_leases") &&
      norm.includes("project_id") &&
      norm.includes("released_at is null")
    ) {
      const projectId = params[0] as string;
      const now = params[1] as string;
      return [...rows.values()]
        .filter((r) => r.project_id === projectId && r.released_at === null && r.expires_at > now)
        .map((r) => ({ ...r }));
    }

    // UPDATE worktree_leases SET task_id = ...  (re-acquire)
    if (norm.includes("update") && norm.includes("set task_id")) {
      const [taskId, projectId, wtPath, branchName, owner, gen, acquiredAt, expiresAt, key] =
        params as string[];
      const existing = rows.get(key);
      if (existing) {
        Object.assign(existing, {
          task_id: taskId,
          project_id: projectId,
          worktree_path: wtPath,
          branch_name: branchName,
          lease_owner: owner,
          generation: Number(gen),
          acquired_at: acquiredAt,
          expires_at: expiresAt,
          released_at: null,
        });
      }
      return 1;
    }

    // INSERT INTO worktree_leases (...)
    if (norm.includes("insert into worktree_leases")) {
      const [key, taskId, projectId, wtPath, branchName, owner, gen, acquiredAt, expiresAt] =
        params as string[];
      rows.set(key, {
        worktree_key: key,
        task_id: taskId,
        project_id: projectId,
        worktree_path: wtPath,
        branch_name: branchName ?? null,
        lease_owner: owner,
        generation: Number(gen),
        acquired_at: acquiredAt,
        expires_at: expiresAt,
        released_at: null,
      });
      return 1;
    }

    // UPDATE worktree_leases SET expires_at = ... WHERE worktree_key = ... AND released_at IS NULL  (renew)
    if (
      norm.includes("update") &&
      norm.includes("expires_at") &&
      norm.includes("released_at is null") &&
      !norm.includes("set released_at")
    ) {
      const expiresAt = params[0] as string;
      const key = params[1] as string;
      const row = rows.get(key);
      if (row && row.released_at === null) {
        row.expires_at = expiresAt;
        return 1;
      }
      return 0;
    }

    // UPDATE worktree_leases SET released_at = ... WHERE worktree_key = ...
    if (norm.includes("update") && norm.includes("released_at") && norm.includes("worktree_key")) {
      const releasedAt = params[0] as string;
      const key = params[1] as string;
      const row = rows.get(key);
      if (row && row.released_at === null) {
        row.released_at = releasedAt;
        return 1;
      }
      return 0;
    }

    return [];
  }

  const client = {
    query: vi.fn(async (sql: string, params: unknown[]) => matchRow(sql, params) as unknown[]),
    execute: vi.fn(async (sql: string, params: unknown[]) => matchRow(sql, params) as number),
  };

  return { rows, client };
}

let memStore: ReturnType<typeof createInMemoryLeaseStore>;

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    runWrite: vi.fn(async (fn: (client: unknown) => Promise<void>) => {
      await fn(memStore.client);
    }),
    getDb: vi.fn(async () => memStore.client),
  },
}));

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

const { WorktreeLeaseService } = await import("../services/worktree-lease.service.js");

describe("WorktreeLeaseService", () => {
  let service: InstanceType<typeof WorktreeLeaseService>;

  beforeEach(() => {
    memStore = createInMemoryLeaseStore();
    service = new WorktreeLeaseService();
  });

  const BASE_PARAMS = {
    worktreeKey: "task-1",
    taskId: "task-1",
    projectId: "proj-1",
    worktreePath: "/tmp/wt/task-1",
    branchName: "opensprint/task-1",
    leaseOwner: "orchestrator-abc",
  };

  describe("acquire", () => {
    it("inserts a new lease row with generation 1", async () => {
      const lease = await service.acquire(BASE_PARAMS);
      expect(lease.worktreeKey).toBe("task-1");
      expect(lease.generation).toBe(1);
      expect(lease.releasedAt).toBeNull();
      expect(lease.leaseOwner).toBe("orchestrator-abc");
      expect(Date.parse(lease.acquiredAt)).not.toBeNaN();
      expect(Date.parse(lease.expiresAt)).not.toBeNaN();
      expect(new Date(lease.expiresAt).getTime()).toBeGreaterThan(
        new Date(lease.acquiredAt).getTime()
      );
    });

    it("bumps generation when re-acquiring an existing key", async () => {
      await service.acquire(BASE_PARAMS);
      await service.release(BASE_PARAMS.worktreeKey, BASE_PARAMS.leaseOwner);
      const lease2 = await service.acquire({
        ...BASE_PARAMS,
        leaseOwner: "orchestrator-xyz",
        taskId: "task-1-retry",
      });
      expect(lease2.generation).toBe(2);
      expect(lease2.leaseOwner).toBe("orchestrator-xyz");
      expect(lease2.taskId).toBe("task-1-retry");
      expect(lease2.releasedAt).toBeNull();
    });
    it("refuses an unexpired worktree owned by another execution", async () => {
      await service.acquire(BASE_PARAMS);
      await expect(
        service.acquire({ ...BASE_PARAMS, leaseOwner: "other-backend" })
      ).rejects.toThrow("already leased");
      expect((await service.get(BASE_PARAMS.worktreeKey))?.leaseOwner).toBe(BASE_PARAMS.leaseOwner);
    });

    it("respects custom TTL", async () => {
      const lease = await service.acquire({ ...BASE_PARAMS, ttlMs: 5000 });
      const acquiredMs = new Date(lease.acquiredAt).getTime();
      const expiresMs = new Date(lease.expiresAt).getTime();
      expect(expiresMs - acquiredMs).toBe(5000);
    });

    it("defaults branchName to null when not provided", async () => {
      const { branchName: _, ...noBranch } = BASE_PARAMS;
      const lease = await service.acquire(noBranch);
      expect(lease.branchName).toBeNull();
    });
  });

  describe("release", () => {
    it("releases the lease when owner matches", async () => {
      await service.acquire(BASE_PARAMS);
      const released = await service.release("task-1", "orchestrator-abc");
      expect(released).toBe(true);
      const row = memStore.rows.get("task-1");
      expect(row?.released_at).toBeTruthy();
    });

    it("rejects release when owner does not match", async () => {
      await service.acquire(BASE_PARAMS);
      const released = await service.release("task-1", "wrong-owner");
      expect(released).toBe(false);
      const row = memStore.rows.get("task-1");
      expect(row?.released_at).toBeNull();
    });

    it("returns true for already-released lease (idempotent)", async () => {
      await service.acquire(BASE_PARAMS);
      await service.release("task-1", "orchestrator-abc");
      const secondRelease = await service.release("task-1", "orchestrator-abc");
      expect(secondRelease).toBe(true);
    });

    it("returns false for non-existent key", async () => {
      const released = await service.release("no-such-key", "any");
      expect(released).toBe(false);
    });
  });

  describe("forceRelease", () => {
    it("releases regardless of owner", async () => {
      await service.acquire(BASE_PARAMS);
      await service.forceRelease("task-1");
      const row = memStore.rows.get("task-1");
      expect(row?.released_at).toBeTruthy();
    });

    it("is a no-op for already-released leases", async () => {
      await service.acquire(BASE_PARAMS);
      await service.release("task-1", "orchestrator-abc");
      const releasedAt = memStore.rows.get("task-1")!.released_at;
      await service.forceRelease("task-1");
      expect(memStore.rows.get("task-1")!.released_at).toBe(releasedAt);
    });
  });

  describe("canCleanup", () => {
    it("returns true when no lease exists", async () => {
      expect(await service.canCleanup("nonexistent")).toBe(true);
    });

    it("returns true when lease is released", async () => {
      await service.acquire(BASE_PARAMS);
      await service.release("task-1", "orchestrator-abc");
      expect(await service.canCleanup("task-1")).toBe(true);
    });

    it("returns false when active (non-expired, non-released) lease exists", async () => {
      await service.acquire({ ...BASE_PARAMS, ttlMs: 60_000 });
      expect(await service.canCleanup("task-1")).toBe(false);
    });

    it("returns true when lease is expired (TTL passed)", async () => {
      await service.acquire({ ...BASE_PARAMS, ttlMs: 1 });
      await new Promise((r) => setTimeout(r, 10));
      expect(await service.canCleanup("task-1")).toBe(true);
    });
  });

  describe("get", () => {
    it("returns null for non-existent key", async () => {
      expect(await service.get("missing")).toBeNull();
    });

    it("returns the lease for an existing key", async () => {
      await service.acquire(BASE_PARAMS);
      const lease = (await service.get("task-1")) as WorktreeLease;
      expect(lease).not.toBeNull();
      expect(lease.worktreeKey).toBe("task-1");
      expect(lease.taskId).toBe("task-1");
      expect(lease.projectId).toBe("proj-1");
    });
  });

  describe("getActiveForProject", () => {
    it("returns only active (non-released, non-expired) leases for the project", async () => {
      await service.acquire({ ...BASE_PARAMS, ttlMs: 60_000 });
      await service.acquire({
        ...BASE_PARAMS,
        worktreeKey: "task-2",
        taskId: "task-2",
        worktreePath: "/tmp/wt/task-2",
        leaseOwner: "orch-2",
        ttlMs: 60_000,
      });
      await service.release("task-1", "orchestrator-abc");

      const active = await service.getActiveForProject("proj-1");
      expect(active).toHaveLength(1);
      expect(active[0].worktreeKey).toBe("task-2");
    });

    it("excludes expired leases", async () => {
      await service.acquire({ ...BASE_PARAMS, ttlMs: 1 });
      await new Promise((r) => setTimeout(r, 10));
      const active = await service.getActiveForProject("proj-1");
      expect(active).toHaveLength(0);
    });

    it("excludes leases from other projects", async () => {
      await service.acquire({ ...BASE_PARAMS, projectId: "other-project", ttlMs: 60_000 });
      const active = await service.getActiveForProject("proj-1");
      expect(active).toHaveLength(0);
    });
  });

  describe("renew", () => {
    it("extends the expiry of an active lease", async () => {
      await service.acquire({ ...BASE_PARAMS, ttlMs: 5000 });
      const before = memStore.rows.get("task-1")!.expires_at;
      const renewed = await service.renew("task-1", 120_000);
      expect(renewed).toBe(true);
      const after = memStore.rows.get("task-1")!.expires_at;
      expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    });

    it("returns false for a released lease", async () => {
      await service.acquire(BASE_PARAMS);
      await service.release("task-1", "orchestrator-abc");
      const renewed = await service.renew("task-1");
      expect(renewed).toBe(false);
    });

    it("returns false for a non-existent key", async () => {
      const renewed = await service.renew("no-such-key");
      expect(renewed).toBe(false);
    });

    it("prevents canCleanup from returning true after renewal", async () => {
      await service.acquire({ ...BASE_PARAMS, ttlMs: 1 });
      await new Promise((r) => setTimeout(r, 10));
      expect(await service.canCleanup("task-1")).toBe(true);
      await service.renew("task-1", 60_000);
      expect(await service.canCleanup("task-1")).toBe(false);
    });

    it("returns false when concurrent release wins the race", async () => {
      await service.acquire(BASE_PARAMS);
      // Simulate a concurrent release between the (now removed) SELECT and the UPDATE
      memStore.rows.get("task-1")!.released_at = new Date().toISOString();
      const renewed = await service.renew("task-1", 120_000);
      expect(renewed).toBe(false);
    });
  });

  describe("generation tracking", () => {
    it("increments generation on successive acquires of the same key", async () => {
      const l1 = await service.acquire(BASE_PARAMS);
      expect(l1.generation).toBe(1);

      await service.release("task-1", "orchestrator-abc");
      const l2 = await service.acquire({ ...BASE_PARAMS, leaseOwner: "orch-2" });
      expect(l2.generation).toBe(2);

      await service.release("task-1", "orch-2");
      const l3 = await service.acquire({ ...BASE_PARAMS, leaseOwner: "orch-3" });
      expect(l3.generation).toBe(3);
    });
  });
});
