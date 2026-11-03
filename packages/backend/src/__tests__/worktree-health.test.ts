import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import {
  validateWorktreeCheckout,
  isWorktreeCheckoutUsable,
  preflightWorktreeForDiff,
  IncompleteWorktreeError,
  worktreePathsResolveEqually,
  WorktreeCheckoutUsabilityCache,
  guppWorktreeUsabilityAttemptId,
  evaluateWorktreeCleanupProtection,
} from "../utils/worktree-health.js";

describe("worktree-health", () => {
  let repoDir: string;
  let worktreeDir: string;

  beforeEach(async () => {
    repoDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wt-health-repo-")));
    worktreeDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wt-health-wt-")));
    await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
    await fs.mkdir(path.join(repoDir, "packages"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "package.json"), "{}");
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(worktreeDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("validateWorktreeCheckout", () => {
    it("passes for a fully populated worktree", async () => {
      await fs.mkdir(path.join(worktreeDir, ".git"), { recursive: true });
      await fs.writeFile(path.join(worktreeDir, "package.json"), "{}");
      await fs.mkdir(path.join(worktreeDir, "packages"), { recursive: true });

      await expect(validateWorktreeCheckout(repoDir, worktreeDir)).resolves.toBeUndefined();
    });

    it("throws when the worktree directory does not exist", async () => {
      const ghost = path.join(os.tmpdir(), `ghost-wt-${Date.now()}`);
      await expect(validateWorktreeCheckout(repoDir, ghost)).rejects.toThrow(
        IncompleteWorktreeError
      );
      await expect(validateWorktreeCheckout(repoDir, ghost)).rejects.toThrow(
        "directory does not exist"
      );
    });

    it("throws when .git is missing from the worktree", async () => {
      await fs.writeFile(path.join(worktreeDir, "package.json"), "{}");

      await expect(validateWorktreeCheckout(repoDir, worktreeDir)).rejects.toThrow(
        ".git entry is missing"
      );
    });

    it("throws when package.json is missing but present in repo", async () => {
      await fs.mkdir(path.join(worktreeDir, ".git"), { recursive: true });

      await expect(validateWorktreeCheckout(repoDir, worktreeDir)).rejects.toThrow(
        "package.json is present in the main repo but missing in the worktree"
      );
    });

    it("passes when repo has no package.json and worktree has none", async () => {
      await fs.rm(path.join(repoDir, "package.json"));
      await fs.mkdir(path.join(worktreeDir, ".git"), { recursive: true });
      await fs.mkdir(path.join(worktreeDir, "packages"), { recursive: true });

      await expect(validateWorktreeCheckout(repoDir, worktreeDir)).resolves.toBeUndefined();
    });

    it("throws when no source directories from repo root are present in worktree", async () => {
      await fs.mkdir(path.join(worktreeDir, ".git"), { recursive: true });
      await fs.writeFile(path.join(worktreeDir, "package.json"), "{}");
      // Worktree has .git and package.json but no 'packages/' directory

      await expect(validateWorktreeCheckout(repoDir, worktreeDir)).rejects.toThrow(
        "none of the expected source directories are present"
      );
    });

    it("passes when at least one source directory matches", async () => {
      await fs.mkdir(path.join(repoDir, "src"), { recursive: true });
      await fs.mkdir(path.join(worktreeDir, ".git"), { recursive: true });
      await fs.writeFile(path.join(worktreeDir, "package.json"), "{}");
      await fs.mkdir(path.join(worktreeDir, "src"), { recursive: true });
      // 'packages' missing but 'src' is present → should pass

      await expect(validateWorktreeCheckout(repoDir, worktreeDir)).resolves.toBeUndefined();
    });

    it("ignores excluded dirs like node_modules and dist when checking markers", async () => {
      // Repo only has excluded directories as subdirs → marker list is empty → should pass
      const sparseRepo = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "wt-health-sparse-"))
      );
      await fs.mkdir(path.join(sparseRepo, ".git"), { recursive: true });
      await fs.mkdir(path.join(sparseRepo, "node_modules"), { recursive: true });
      await fs.mkdir(path.join(sparseRepo, "dist"), { recursive: true });

      await fs.mkdir(path.join(worktreeDir, ".git"), { recursive: true });

      await expect(validateWorktreeCheckout(sparseRepo, worktreeDir)).resolves.toBeUndefined();
      await fs.rm(sparseRepo, { recursive: true, force: true }).catch(() => {});
    });
  });

  describe("isWorktreeCheckoutUsable", () => {
    it("returns true for a fully populated worktree", async () => {
      await fs.mkdir(path.join(worktreeDir, ".git"), { recursive: true });
      await fs.writeFile(path.join(worktreeDir, "package.json"), "{}");
      await fs.mkdir(path.join(worktreeDir, "packages"), { recursive: true });

      expect(await isWorktreeCheckoutUsable(repoDir, worktreeDir)).toBe(true);
    });

    it("returns false when .git is missing", async () => {
      expect(await isWorktreeCheckoutUsable(repoDir, worktreeDir)).toBe(false);
    });

    it("returns false when package.json missing in worktree but present in repo", async () => {
      await fs.mkdir(path.join(worktreeDir, ".git"), { recursive: true });

      expect(await isWorktreeCheckoutUsable(repoDir, worktreeDir)).toBe(false);
    });
  });

  describe("preflightWorktreeForDiff", () => {
    it("returns usable:true for a valid worktree", async () => {
      await fs.mkdir(path.join(worktreeDir, ".git"), { recursive: true });
      await fs.writeFile(path.join(worktreeDir, "package.json"), "{}");
      await fs.mkdir(path.join(worktreeDir, "packages"), { recursive: true });

      const result = await preflightWorktreeForDiff(repoDir, worktreeDir);
      expect(result).toEqual({ usable: true });
    });

    it("returns directory_missing when worktree does not exist", async () => {
      const ghost = path.join(os.tmpdir(), `ghost-wt-${Date.now()}`);
      const result = await preflightWorktreeForDiff(repoDir, ghost);
      expect(result.usable).toBe(false);
      expect(result.failureReason).toBe("directory_missing");
    });

    it("returns git_entry_missing when .git is absent", async () => {
      const result = await preflightWorktreeForDiff(repoDir, worktreeDir);
      expect(result.usable).toBe(false);
      expect(result.failureReason).toBe("git_entry_missing");
    });

    it("returns package_json_missing when repo has it but worktree does not", async () => {
      await fs.mkdir(path.join(worktreeDir, ".git"), { recursive: true });

      const result = await preflightWorktreeForDiff(repoDir, worktreeDir);
      expect(result.usable).toBe(false);
      expect(result.failureReason).toBe("package_json_missing");
    });

    it("returns source_directories_missing when none of the repo dirs exist in worktree", async () => {
      await fs.mkdir(path.join(worktreeDir, ".git"), { recursive: true });
      await fs.writeFile(path.join(worktreeDir, "package.json"), "{}");

      const result = await preflightWorktreeForDiff(repoDir, worktreeDir);
      expect(result.usable).toBe(false);
      expect(result.failureReason).toBe("source_directories_missing");
    });
  });

  describe("guppWorktreeUsabilityAttemptId", () => {
    it("joins task id and attempt ordinal", () => {
      expect(guppWorktreeUsabilityAttemptId({ taskId: "os-abcd", attempt: 3 })).toBe("os-abcd:3");
    });
  });

  describe("WorktreeCheckoutUsabilityCache", () => {
    it("calls evaluate once per cache key within TTL", async () => {
      vi.useFakeTimers({ now: 0 });
      const cache = new WorktreeCheckoutUsabilityCache(60_000);
      let calls = 0;
      const evaluate = async () => {
        calls += 1;
        return true;
      };
      await expect(cache.getOrEvaluate("/repo", "/worktree", "task:1", evaluate)).resolves.toBe(
        true
      );
      await expect(cache.getOrEvaluate("/repo", "/worktree", "task:1", evaluate)).resolves.toBe(
        true
      );
      expect(calls).toBe(1);
      vi.useRealTimers();
    });

    it("uses a distinct entry per attemptId", async () => {
      vi.useFakeTimers({ now: 0 });
      const cache = new WorktreeCheckoutUsabilityCache(60_000);
      let calls = 0;
      const evaluate = async () => {
        calls += 1;
        return true;
      };
      await cache.getOrEvaluate("/repo", "/worktree", "t:1", evaluate);
      await cache.getOrEvaluate("/repo", "/worktree", "t:2", evaluate);
      expect(calls).toBe(2);
      vi.useRealTimers();
    });

    it("re-evaluates after TTL", async () => {
      vi.useFakeTimers({ now: 0 });
      const cache = new WorktreeCheckoutUsabilityCache(1000);
      let calls = 0;
      const evaluate = async () => {
        calls += 1;
        return calls === 1;
      };
      await expect(cache.getOrEvaluate("/r", "/w", "a:1", evaluate)).resolves.toBe(true);
      vi.advanceTimersByTime(1001);
      await expect(cache.getOrEvaluate("/r", "/w", "a:1", evaluate)).resolves.toBe(false);
      expect(calls).toBe(2);
      vi.useRealTimers();
    });

    it("deduplicates concurrent in-flight evaluations for the same key", async () => {
      vi.useFakeTimers({ now: 0 });
      const cache = new WorktreeCheckoutUsabilityCache(60_000);
      let calls = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const evaluate = async () => {
        calls += 1;
        await gate;
        return true;
      };
      const p1 = cache.getOrEvaluate("/r", "/w", "x:1", evaluate);
      const p2 = cache.getOrEvaluate("/r", "/w", "x:1", evaluate);
      expect(calls).toBe(1);
      release!();
      await expect(Promise.all([p1, p2])).resolves.toEqual([true, true]);
      expect(calls).toBe(1);
      vi.useRealTimers();
    });

    it("does not cache rejected evaluations", async () => {
      vi.useFakeTimers({ now: 0 });
      const cache = new WorktreeCheckoutUsabilityCache(60_000);
      let calls = 0;
      const evaluate = async () => {
        calls += 1;
        if (calls === 1) throw new Error("boom");
        return true;
      };
      await expect(cache.getOrEvaluate("/r", "/w", "z:1", evaluate)).rejects.toThrow("boom");
      await expect(cache.getOrEvaluate("/r", "/w", "z:1", evaluate)).resolves.toBe(true);
      expect(calls).toBe(2);
      vi.useRealTimers();
    });

    it("normalizes paths so equivalent spellings share one entry", async () => {
      vi.useFakeTimers({ now: 0 });
      const cache = new WorktreeCheckoutUsabilityCache(60_000);
      let calls = 0;
      const evaluate = async () => {
        calls += 1;
        return true;
      };
      await cache.getOrEvaluate("/repo/../repo", "/wt", "k:1", evaluate);
      await cache.getOrEvaluate("/repo", "/wt", "k:1", evaluate);
      expect(calls).toBe(1);
      vi.useRealTimers();
    });
  });

  describe("evaluateWorktreeCleanupProtection", () => {
    it("forbids cleanup when assignment is within grace window", async () => {
      const tid = "os-test.1";
      await fs.mkdir(path.join(worktreeDir, OPENSPRINT_PATHS.active, tid), { recursive: true });
      await fs.writeFile(
        path.join(worktreeDir, OPENSPRINT_PATHS.active, tid, OPENSPRINT_PATHS.assignment),
        JSON.stringify({ taskId: tid, createdAt: new Date().toISOString() })
      );
      const show = async () => ({ status: "closed" as const });
      const r = await evaluateWorktreeCleanupProtection("proj", worktreeDir, show, 60_000);
      expect(r.forbid).toBe(true);
      expect(r.reason).toBe("fresh_assignment_on_disk");
    });

    it("allows fresh assignment when task id is in ignoreFreshAssignmentForTaskIds", async () => {
      const tid = "os-test.1";
      await fs.mkdir(path.join(worktreeDir, OPENSPRINT_PATHS.active, tid), { recursive: true });
      await fs.writeFile(
        path.join(worktreeDir, OPENSPRINT_PATHS.active, tid, OPENSPRINT_PATHS.assignment),
        JSON.stringify({ taskId: tid, createdAt: new Date().toISOString() })
      );
      const show = async () => ({ status: "closed" as const });
      const r = await evaluateWorktreeCleanupProtection("proj", worktreeDir, show, 60_000, {
        ignoreFreshAssignmentForTaskIds: new Set([tid]),
      });
      expect(r.forbid).toBe(false);
    });

    it("still forbids when another task has a fresh assignment", async () => {
      const ours = "os-a.1";
      const other = "os-b.1";
      for (const id of [ours, other]) {
        await fs.mkdir(path.join(worktreeDir, OPENSPRINT_PATHS.active, id), { recursive: true });
        await fs.writeFile(
          path.join(worktreeDir, OPENSPRINT_PATHS.active, id, OPENSPRINT_PATHS.assignment),
          JSON.stringify({ taskId: id, createdAt: new Date().toISOString() })
        );
      }
      const show = async () => ({ status: "closed" as const });
      const r = await evaluateWorktreeCleanupProtection("proj", worktreeDir, show, 60_000, {
        ignoreFreshAssignmentForTaskIds: new Set([ours]),
      });
      expect(r.forbid).toBe(true);
      expect(r.reason).toBe("fresh_assignment_on_disk");
    });

    it("forbids when task is in_progress unless ignored for live status", async () => {
      const tid = "os-test.1";
      await fs.mkdir(path.join(worktreeDir, OPENSPRINT_PATHS.active, tid), { recursive: true });
      await fs.writeFile(
        path.join(worktreeDir, OPENSPRINT_PATHS.active, tid, OPENSPRINT_PATHS.assignment),
        JSON.stringify({
          taskId: tid,
          createdAt: new Date(Date.now() - 86400000).toISOString(),
        })
      );
      const show = async () => ({ status: "in_progress" as const });
      const blocked = await evaluateWorktreeCleanupProtection("proj", worktreeDir, show, 60_000);
      expect(blocked.forbid).toBe(true);
      expect(blocked.reason?.startsWith("active_task_")).toBe(true);

      const allowed = await evaluateWorktreeCleanupProtection("proj", worktreeDir, show, 60_000, {
        ignoreLiveTaskStatusForTaskIds: new Set([tid]),
      });
      expect(allowed.forbid).toBe(false);
    });
  });

  describe("worktreePathsResolveEqually", () => {
    it("returns true for the same path via different spellings when realpath aligns", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wt-same-"));
      const resolved = await fs.realpath(dir);
      await expect(worktreePathsResolveEqually(dir, resolved)).resolves.toBe(true);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    });

    it("returns false for two distinct directories", async () => {
      const a = await fs.mkdtemp(path.join(os.tmpdir(), "wt-a-"));
      const b = await fs.mkdtemp(path.join(os.tmpdir(), "wt-b-"));
      await expect(worktreePathsResolveEqually(a, b)).resolves.toBe(false);
      await fs.rm(a, { recursive: true, force: true }).catch(() => {});
      await fs.rm(b, { recursive: true, force: true }).catch(() => {});
    });
  });
});

vi.mock("../services/governance.service.js", async () => ({
  governanceService: (await import("./mocks/disabled-governance.js")).disabledGovernanceService,
}));
