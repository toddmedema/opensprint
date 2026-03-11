import { describe, it, expect } from "vitest";
import {
  hydrateTask,
  validateAssigneeChange,
  mergeExtraForUpdate,
  buildTaskUpdateSets,
  buildUpdateManySets,
  isDuplicateKeyError,
  getCumulativeAttemptsFromIssue,
  hasLabel,
  getFileScopeLabels,
  getConflictFilesFromIssue,
  getMergeStageFromIssue,
  resolveEpicId,
  getBlockersFromIssue,
  getParentId,
} from "../services/task-store-helpers.js";
import type { StoredTask } from "../services/task-store.types.js";
import { AppError } from "../middleware/error-handler.js";

function stored(overrides: Partial<StoredTask> = {}): StoredTask {
  const now = new Date().toISOString();
  return {
    id: "os-1a2b",
    title: "Task",
    issue_type: "task",
    status: "open",
    priority: 2,
    created_at: now,
    updated_at: now,
    ...overrides,
  } as StoredTask;
}

describe("task-store-helpers", () => {
  describe("hydrateTask", () => {
    it("builds StoredTask from row with optional dep maps", () => {
      const now = new Date().toISOString();
      const row = {
        id: "os-1a",
        project_id: "proj",
        title: "T",
        description: "D",
        issue_type: "task",
        status: "open",
        priority: 1,
        assignee: null,
        owner: null,
        labels: "[]",
        created_at: now,
        updated_at: now,
        created_by: null,
        close_reason: null,
        started_at: null,
        completed_at: null,
        complexity: null,
        extra: "{}",
      };
      const depsByTaskId = new Map([["os-1a", [{ depends_on_id: "os-2b", type: "blocks" }]]]);
      const dependentCountByTaskId = new Map([["os-1a", 1]]);
      const task = hydrateTask(row, depsByTaskId, dependentCountByTaskId);
      expect(task.id).toBe("os-1a");
      expect(task.dependencies).toEqual([{ depends_on_id: "os-2b", type: "blocks" }]);
      expect(task.dependent_count).toBe(1);
    });

    it("uses empty deps when maps not provided", () => {
      const now = new Date().toISOString();
      const row = {
        id: "os-1a",
        project_id: "proj",
        title: "T",
        description: null,
        issue_type: "task",
        status: "open",
        priority: 1,
        assignee: null,
        owner: null,
        labels: "[]",
        created_at: now,
        updated_at: now,
        created_by: null,
        close_reason: null,
        started_at: null,
        completed_at: null,
        complexity: null,
        extra: "{}",
      };
      const task = hydrateTask(row);
      expect(task.dependencies).toEqual([]);
      expect(task.dependent_count).toBe(0);
    });
  });

  describe("validateAssigneeChange", () => {
    it("does not throw when claim or reopening", () => {
      expect(() =>
        validateAssigneeChange("in_progress", { status: "open", assignee: null }, "os-1")
      ).not.toThrow();
      expect(() =>
        validateAssigneeChange("open", { claim: true, assignee: "agent" }, "os-1")
      ).not.toThrow();
    });

    it("does not throw when releasing an in-progress task assignment", () => {
      expect(() =>
        validateAssigneeChange("in_progress", { status: "blocked", assignee: "" }, "os-1")
      ).not.toThrow();
      expect(() =>
        validateAssigneeChange("in_progress", { status: "closed", assignee: null }, "os-1")
      ).not.toThrow();
    });

    it("throws when changing assignee while in progress", () => {
      expect(() =>
        validateAssigneeChange("in_progress", { assignee: "other" }, "os-1")
      ).toThrow(AppError);
      expect(() =>
        validateAssigneeChange("in_progress", { status: "blocked", assignee: "other" }, "os-1")
      ).toThrow(AppError);
    });
  });

  describe("mergeExtraForUpdate", () => {
    it("merges extra and block_reason", () => {
      const out = mergeExtraForUpdate(
        { foo: 1 },
        { extra: { bar: 2 }, block_reason: "Merge Failure" }
      );
      expect(out).toEqual({ foo: 1, bar: 2, block_reason: "Merge Failure" });
    });

    it("clears block_reason when set to null", () => {
      const out = mergeExtraForUpdate(
        { block_reason: "Coding Failure" },
        { block_reason: null }
      );
      expect(out).not.toHaveProperty("block_reason");
    });
  });

  describe("buildTaskUpdateSets", () => {
    it("returns sets and vals with nextIdx", () => {
      const now = new Date().toISOString();
      const { sets, vals, nextIdx } = buildTaskUpdateSets(
        { title: "New", status: "open" },
        now,
        null,
        undefined
      );
      expect(sets).toContain("updated_at = $1");
      expect(sets).toContain("title = $2");
      expect(sets).toContain("status = $3");
      expect(vals).toEqual([now, "New", "open"]);
      expect(nextIdx).toBe(4);
    });
  });

  describe("buildUpdateManySets", () => {
    it("returns sets for status and assignee", () => {
      const now = new Date().toISOString();
      const { sets, vals, nextIdx } = buildUpdateManySets(
        { status: "in_progress", assignee: "agent" },
        now,
        null
      );
      expect(sets.length).toBeGreaterThan(1);
      expect(vals[0]).toBe(now);
      expect(nextIdx).toBeGreaterThan(2);
    });
  });

  describe("isDuplicateKeyError", () => {
    it("returns true for duplicate key messages", () => {
      expect(isDuplicateKeyError(new Error("unique constraint violated"))).toBe(true);
      expect(isDuplicateKeyError(new Error("already exists"))).toBe(true);
    });

    it("returns false for other errors", () => {
      expect(isDuplicateKeyError(new Error("not found"))).toBe(false);
    });
  });

  describe("getCumulativeAttemptsFromIssue", () => {
    it("returns max attempts from labels", () => {
      expect(getCumulativeAttemptsFromIssue(stored({ labels: ["attempts:3", "attempts:1"] }))).toBe(
        3
      );
    });

    it("returns 0 when no attempts label", () => {
      expect(getCumulativeAttemptsFromIssue(stored({ labels: [] }))).toBe(0);
    });
  });

  describe("hasLabel", () => {
    it("returns true when label present", () => {
      expect(hasLabel(stored({ labels: ["blocked"] }), "blocked")).toBe(true);
    });

    it("returns false when label absent", () => {
      expect(hasLabel(stored({ labels: [] }), "blocked")).toBe(false);
    });
  });

  describe("getFileScopeLabels", () => {
    it("parses files: label", () => {
      const scope = { modify: ["a.ts"] };
      expect(
        getFileScopeLabels(stored({ labels: [`files:${JSON.stringify(scope)}`] }))
      ).toEqual(scope);
    });

    it("returns null when no files label", () => {
      expect(getFileScopeLabels(stored({ labels: [] }))).toBeNull();
    });
  });

  describe("getConflictFilesFromIssue", () => {
    it("returns parsed conflict_files array", () => {
      expect(
        getConflictFilesFromIssue(stored({ labels: ['conflict_files:["a.ts","b.ts"]'] }))
      ).toEqual(["a.ts", "b.ts"]);
    });

    it("returns empty array when no label", () => {
      expect(getConflictFilesFromIssue(stored({ labels: [] }))).toEqual([]);
    });
  });

  describe("getMergeStageFromIssue", () => {
    it("returns merge_stage value", () => {
      expect(getMergeStageFromIssue(stored({ labels: ["merge_stage:rebase"] }))).toBe("rebase");
    });

    it("returns null when no label", () => {
      expect(getMergeStageFromIssue(stored({ labels: [] }))).toBeNull();
    });
  });

  describe("resolveEpicId", () => {
    it("returns epic id from parent chain", () => {
      const all = [stored({ id: "os-a", issue_type: "epic" }), stored({ id: "os-a.1", issue_type: "task" })];
      expect(resolveEpicId("os-a.1", all)).toBe("os-a");
    });
  });

  describe("getBlockersFromIssue", () => {
    it("returns depends_on_id for blocks type", () => {
      const issue = stored({
        dependencies: [
          { depends_on_id: "os-x", type: "blocks" },
          { depends_on_id: "os-y", type: "parent-child" },
        ],
      });
      expect(getBlockersFromIssue(issue)).toEqual(["os-x"]);
    });
  });

  describe("getParentId", () => {
    it("returns parent from hierarchical id", () => {
      expect(getParentId("os-a.1.2")).toBe("os-a.1");
    });

    it("returns null for top-level", () => {
      expect(getParentId("os-a")).toBeNull();
    });
  });
});
