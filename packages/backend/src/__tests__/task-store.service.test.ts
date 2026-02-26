import { describe, it, expect, beforeEach, afterEach } from "vitest";
import initSqlJs from "sql.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { TaskStoreService } from "../services/task-store.service.js";

const TEST_PROJECT_ID = "test-project";

describe("TaskStoreService", () => {
  let store: TaskStoreService;

  beforeEach(async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    store = new TaskStoreService(db);
    await store.init();
  });

  describe("create", () => {
    it("should create a top-level task", async () => {
      const result = await store.create(TEST_PROJECT_ID, "My Task", {
        type: "task",
        priority: 1,
        description: "Test description",
      });
      expect(result.id).toMatch(/^os-[0-9a-f]{4}$/);
      expect(result.title).toBe("My Task");
      expect(result.status).toBe("open");
      expect(result.priority).toBe(1);
      expect(result.description).toBe("Test description");
      expect(result.issue_type).toBe("task");
    });

    it("should create a child task under a parent", async () => {
      const epic = await store.create(TEST_PROJECT_ID, "Epic", { type: "epic" });
      const task = await store.create(TEST_PROJECT_ID, "Child Task", {
        type: "task",
        parentId: epic.id,
      });
      expect(task.id).toBe(`${epic.id}.1`);
      expect(task.dependencies?.length).toBeGreaterThan(0);
      expect(task.dependencies?.[0]?.type).toBe("parent-child");
    });

    it("should increment child IDs sequentially", async () => {
      const epic = await store.create(TEST_PROJECT_ID, "Epic", { type: "epic" });
      const t1 = await store.create(TEST_PROJECT_ID, "Task 1", { parentId: epic.id });
      const t2 = await store.create(TEST_PROJECT_ID, "Task 2", { parentId: epic.id });
      const t3 = await store.create(TEST_PROJECT_ID, "Task 3", { parentId: epic.id });
      expect(t1.id).toBe(`${epic.id}.1`);
      expect(t2.id).toBe(`${epic.id}.2`);
      expect(t3.id).toBe(`${epic.id}.3`);
    });

    it("should use default type and priority when not specified", async () => {
      const result = await store.create(TEST_PROJECT_ID, "Default Task");
      expect(result.issue_type).toBe("task");
      expect(result.priority).toBe(2);
    });

    it("should persist complexity in extra when provided", async () => {
      const result = await store.create(TEST_PROJECT_ID, "Complex Task", {
        type: "task",
        complexity: "complex",
      });
      expect((result as { complexity?: string }).complexity).toBe("complex");
      const refetched = store.show(TEST_PROJECT_ID, result.id);
      expect((refetched as { complexity?: string }).complexity).toBe("complex");
    });

    it("should persist extra.sourceFeedbackIds when provided", async () => {
      const result = await store.create(TEST_PROJECT_ID, "Feedback Task", {
        type: "task",
        extra: { sourceFeedbackIds: ["fb-123"] },
      });
      expect((result as { sourceFeedbackIds?: string[] }).sourceFeedbackIds).toEqual(["fb-123"]);
      const refetched = store.show(TEST_PROJECT_ID, result.id);
      expect((refetched as { sourceFeedbackIds?: string[] }).sourceFeedbackIds).toEqual([
        "fb-123",
      ]);
    });
  });

  describe("createWithRetry", () => {
    it("should return task on first-try success", async () => {
      const result = await store.createWithRetry(TEST_PROJECT_ID, "Task", {
        type: "task",
        priority: 1,
      });
      expect(result).not.toBeNull();
      expect(result!.title).toBe("Task");
    });

    it("should accept fallbackToStandalone option for API compatibility", async () => {
      const epic = await store.create(TEST_PROJECT_ID, "Epic", { type: "epic" });
      const result = await store.createWithRetry(
        TEST_PROJECT_ID,
        "Task",
        { type: "task", parentId: epic.id },
        { fallbackToStandalone: true }
      );
      expect(result).not.toBeNull();
      expect(result!.id).toBeTruthy();
    });
  });

  describe("createMany", () => {
    it("should create multiple tasks in a single transaction", async () => {
      const results = await store.createMany(TEST_PROJECT_ID, [
        { title: "Task 1", type: "task", priority: 1 },
        { title: "Task 2", type: "task", priority: 2 },
        { title: "Task 3", type: "bug", priority: 0 },
      ]);
      expect(results).toHaveLength(3);
      expect(results[0].title).toBe("Task 1");
      expect(results[1].title).toBe("Task 2");
      expect(results[2].title).toBe("Task 3");
      expect(results[2].issue_type).toBe("bug");
    });

    it("should create children under a parent", async () => {
      const epic = await store.create(TEST_PROJECT_ID, "Epic", { type: "epic" });
      const results = await store.createMany(TEST_PROJECT_ID, [
        { title: "Child 1", parentId: epic.id },
        { title: "Child 2", parentId: epic.id },
      ]);
      expect(results[0].id).toBe(`${epic.id}.1`);
      expect(results[1].id).toBe(`${epic.id}.2`);
    });

    it("should persist complexity when provided in inputs", async () => {
      const results = await store.createMany(TEST_PROJECT_ID, [
        { title: "Simple Task", type: "task", complexity: "simple" },
        { title: "Complex Task", type: "task", complexity: "complex" },
      ]);
      expect((results[0] as { complexity?: string }).complexity).toBe("simple");
      expect((results[1] as { complexity?: string }).complexity).toBe("complex");
    });
  });

  describe("update", () => {
    it("should update task status and return result", async () => {
      const created = await store.create(TEST_PROJECT_ID, "My Task");
      const result = await store.update(TEST_PROJECT_ID, created.id, { status: "in_progress" });
      expect(result.id).toBe(created.id);
      expect(result.status).toBe("in_progress");
    });

    it("should support claim option (assignee + in_progress)", async () => {
      const created = await store.create(TEST_PROJECT_ID, "My Task");
      const result = await store.update(TEST_PROJECT_ID, created.id, {
        claim: true,
        assignee: "Frodo",
      });
      expect(result.assignee).toBe("Frodo");
      expect(result.status).toBe("in_progress");
    });

    it("should support assignee, description, and priority options", async () => {
      const created = await store.create(TEST_PROJECT_ID, "My Task");
      const result = await store.update(TEST_PROJECT_ID, created.id, {
        assignee: "Frodo",
        description: "Updated desc",
        priority: 0,
      });
      expect(result.assignee).toBe("Frodo");
      expect(result.description).toBe("Updated desc");
      expect(result.priority).toBe(0);
    });

    it("should update updated_at timestamp", async () => {
      const created = await store.create(TEST_PROJECT_ID, "My Task");
      const before = created.updated_at;
      await new Promise((r) => setTimeout(r, 10));
      const result = await store.update(TEST_PROJECT_ID, created.id, { status: "in_progress" });
      expect(result.updated_at).not.toBe(before);
    });

    it("should update complexity via options", async () => {
      const created = await store.create(TEST_PROJECT_ID, "My Task");
      const result = await store.update(TEST_PROJECT_ID, created.id, {
        complexity: "complex",
      });
      expect((result as { complexity?: string }).complexity).toBe("complex");
      const refetched = store.show(TEST_PROJECT_ID, created.id);
      expect((refetched as { complexity?: string }).complexity).toBe("complex");
    });

    it("should merge extra (e.g. sourceFeedbackIds) into task", async () => {
      const created = await store.create(TEST_PROJECT_ID, "My Task");
      const result = await store.update(TEST_PROJECT_ID, created.id, {
        extra: { sourceFeedbackIds: ["fb-1", "fb-2"] },
      });
      expect((result as { sourceFeedbackIds?: string[] }).sourceFeedbackIds).toEqual([
        "fb-1",
        "fb-2",
      ]);
      const refetched = store.show(TEST_PROJECT_ID, created.id);
      expect((refetched as { sourceFeedbackIds?: string[] }).sourceFeedbackIds).toEqual([
        "fb-1",
        "fb-2",
      ]);
    });

    it("should persist block_reason when status becomes blocked", async () => {
      const created = await store.create(TEST_PROJECT_ID, "My Task");
      const result = await store.update(TEST_PROJECT_ID, created.id, {
        status: "blocked",
        assignee: "",
        block_reason: "Merge Failure",
      });
      expect(result.status).toBe("blocked");
      expect((result as { block_reason?: string }).block_reason).toBe("Merge Failure");
      const refetched = store.show(TEST_PROJECT_ID, created.id);
      expect((refetched as { block_reason?: string }).block_reason).toBe("Merge Failure");
    });

    it("should clear block_reason when task is unblocked", async () => {
      const created = await store.create(TEST_PROJECT_ID, "My Task");
      await store.update(TEST_PROJECT_ID, created.id, {
        status: "blocked",
        block_reason: "Coding Failure",
      });
      const result = await store.update(TEST_PROJECT_ID, created.id, {
        status: "open",
        block_reason: null,
      });
      expect(result.status).toBe("open");
      expect((result as { block_reason?: string }).block_reason).toBeUndefined();
    });
  });

  describe("close", () => {
    it("should close task with reason and return result", async () => {
      const created = await store.create(TEST_PROJECT_ID, "My Task");
      const result = await store.close(TEST_PROJECT_ID, created.id, "Implemented and tested");
      expect(result.id).toBe(created.id);
      expect(result.status).toBe("closed");
      expect(result.close_reason).toBe("Implemented and tested");
    });

    it("should set completed_at when task is closed", async () => {
      const created = await store.create(TEST_PROJECT_ID, "My Task");
      const beforeClose = new Date().toISOString();
      const result = await store.close(TEST_PROJECT_ID, created.id, "Done");
      const afterClose = new Date().toISOString();
      expect(result.completed_at).toBeTruthy();
      expect(result.completed_at! >= beforeClose && result.completed_at! <= afterClose).toBe(true);
    });
  });

  describe("task duration metadata (started_at, completed_at)", () => {
    it("should set started_at when assignee is first set via update", async () => {
      const created = await store.create(TEST_PROJECT_ID, "My Task");
      expect(created.started_at).toBeNull();

      const beforeAssign = new Date().toISOString();
      const result = await store.update(TEST_PROJECT_ID, created.id, {
        status: "in_progress",
        assignee: "Frodo",
      });
      const afterAssign = new Date().toISOString();

      expect(result.started_at).toBeTruthy();
      expect(
        result.started_at! >= beforeAssign && result.started_at! <= afterAssign
      ).toBe(true);
    });

    it("should set started_at when assignee is first set via claim", async () => {
      const created = await store.create(TEST_PROJECT_ID, "My Task");
      const result = await store.update(TEST_PROJECT_ID, created.id, {
        claim: true,
        assignee: "Samwise",
      });
      expect(result.started_at).toBeTruthy();
    });

    it("should not overwrite started_at when assignee changes again", async () => {
      const created = await store.create(TEST_PROJECT_ID, "My Task");
      const first = await store.update(TEST_PROJECT_ID, created.id, {
        status: "in_progress",
        assignee: "Frodo",
      });
      const firstStartedAt = first.started_at;
      expect(firstStartedAt).toBeTruthy();

      await new Promise((r) => setTimeout(r, 10));
      const second = await store.update(TEST_PROJECT_ID, created.id, {
        assignee: "Samwise",
      });
      expect(second.started_at).toBe(firstStartedAt);
    });

    it("should have started_at and completed_at for closed tasks; duration derivable", async () => {
      const created = await store.create(TEST_PROJECT_ID, "Duration Task");
      await store.update(TEST_PROJECT_ID, created.id, {
        status: "in_progress",
        assignee: "Frodo",
      });
      const closed = await store.close(TEST_PROJECT_ID, created.id, "Done");

      expect(closed.started_at).toBeTruthy();
      expect(closed.completed_at).toBeTruthy();
      const started = new Date(closed.started_at!).getTime();
      const completed = new Date(closed.completed_at!).getTime();
      expect(completed).toBeGreaterThanOrEqual(started);
      const durationMs = completed - started;
      expect(durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should set started_at in updateMany when assignee first set", async () => {
      const t1 = await store.create(TEST_PROJECT_ID, "Task 1");
      const t2 = await store.create(TEST_PROJECT_ID, "Task 2");

      const results = await store.updateMany(TEST_PROJECT_ID, [
        { id: t1.id, assignee: "Frodo", status: "in_progress" },
        { id: t2.id, assignee: "Samwise", status: "in_progress" },
      ]);

      expect(results[0].started_at).toBeTruthy();
      expect(results[1].started_at).toBeTruthy();
    });

    it("should set completed_at in closeMany", async () => {
      const t1 = await store.create(TEST_PROJECT_ID, "Task 1");
      const t2 = await store.create(TEST_PROJECT_ID, "Task 2");

      const results = await store.closeMany(TEST_PROJECT_ID, [
        { id: t1.id, reason: "Done 1" },
        { id: t2.id, reason: "Done 2" },
      ]);

      expect(results[0].completed_at).toBeTruthy();
      expect(results[1].completed_at).toBeTruthy();
    });
  });

  describe("closeMany", () => {
    it("should close multiple tasks in a single transaction", async () => {
      const t1 = await store.create(TEST_PROJECT_ID, "Task 1");
      const t2 = await store.create(TEST_PROJECT_ID, "Task 2");
      const results = await store.closeMany(TEST_PROJECT_ID, [
        { id: t1.id, reason: "Done 1" },
        { id: t2.id, reason: "Done 2" },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe("closed");
      expect(results[1].status).toBe("closed");
      expect(results[0].close_reason).toBe("Done 1");
      expect(results[1].close_reason).toBe("Done 2");
    });
  });

  describe("list", () => {
    it("should return open and in_progress tasks", async () => {
      const t1 = await store.create(TEST_PROJECT_ID, "Task A");
      await store.create(TEST_PROJECT_ID, "Task B");
      await store.update(TEST_PROJECT_ID, t1.id, { status: "in_progress" });
      const t3 = await store.create(TEST_PROJECT_ID, "Task C");
      await store.close(TEST_PROJECT_ID, t3.id, "Done");

      const result = await store.list(TEST_PROJECT_ID);
      expect(result).toHaveLength(2);
      expect(result.every((r) => r.status !== "closed")).toBe(true);
    });

    it("should return empty array for empty list", async () => {
      const result = await store.list(TEST_PROJECT_ID);
      expect(result).toEqual([]);
    });
  });

  describe("show", () => {
    it("should return full task details", async () => {
      const created = await store.create(TEST_PROJECT_ID, "Implement login", {
        description: "Add JWT auth",
        priority: 1,
      });
      const result = store.show(TEST_PROJECT_ID, created.id);
      expect(result.id).toBe(created.id);
      expect(result.title).toBe("Implement login");
      expect(result.description).toBe("Add JWT auth");
    });

    it("should throw when task not found", () => {
      expect(() => store.show(TEST_PROJECT_ID, "nonexistent")).toThrow(
        /Task nonexistent not found/
      );
    });

    it("should accept projectId as first argument for show", async () => {
      const created = await store.create(TEST_PROJECT_ID, "Task");
      const result = store.show(TEST_PROJECT_ID, created.id);
      expect(result.id).toBe(created.id);
    });
  });

  describe("listAll", () => {
    it("should return all tasks including closed", async () => {
      await store.create(TEST_PROJECT_ID, "Task A");
      const t2 = await store.create(TEST_PROJECT_ID, "Task B");
      await store.close(TEST_PROJECT_ID, t2.id, "Done");

      const result = await store.listAll(TEST_PROJECT_ID);
      expect(result).toHaveLength(2);
      expect(result.some((r) => r.status === "closed")).toBe(true);
    });
  });

  describe("ready", () => {
    it("should return ready tasks priority-sorted", async () => {
      await store.create(TEST_PROJECT_ID, "Low priority", { priority: 2 });
      await store.create(TEST_PROJECT_ID, "High priority", { priority: 0 });

      const result = await store.ready(TEST_PROJECT_ID);
      expect(result).toHaveLength(2);
      expect(result[0].priority).toBe(0);
      expect(result[1].priority).toBe(2);
    });

    it("should return empty array when no tasks", async () => {
      const result = await store.ready(TEST_PROJECT_ID);
      expect(result).toEqual([]);
    });

    it("should filter out tasks whose blockers are not closed", async () => {
      const blocker = await store.create(TEST_PROJECT_ID, "Blocker");
      const blocked = await store.create(TEST_PROJECT_ID, "Blocked");
      await store.addDependency(TEST_PROJECT_ID, blocked.id, blocker.id, "blocks");

      const result = await store.ready(TEST_PROJECT_ID);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(blocker.id);
    });

    it("should include blocked tasks when blocker is closed", async () => {
      const blocker = await store.create(TEST_PROJECT_ID, "Blocker");
      const blocked = await store.create(TEST_PROJECT_ID, "Blocked");
      await store.addDependency(TEST_PROJECT_ID, blocked.id, blocker.id, "blocks");
      await store.close(TEST_PROJECT_ID, blocker.id, "Done");

      const result = await store.ready(TEST_PROJECT_ID);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(blocked.id);
    });

    it("should exclude epics", async () => {
      await store.create(TEST_PROJECT_ID, "Epic", { type: "epic" });
      await store.create(TEST_PROJECT_ID, "Task", { type: "task" });

      const result = await store.ready(TEST_PROJECT_ID);
      expect(result).toHaveLength(1);
      expect(result[0].issue_type).toBe("task");
    });

    it("should exclude tasks in blocked epic (epic-blocked model)", async () => {
      const epic = await store.create(TEST_PROJECT_ID, "Plan Epic", { type: "epic" });
      await store.create(TEST_PROJECT_ID, "Task under epic", {
        type: "task",
        parentId: epic.id,
      });
      await store.update(TEST_PROJECT_ID, epic.id, { status: "blocked" });

      const result = await store.ready(TEST_PROJECT_ID);
      expect(result).toHaveLength(0);

      await store.update(TEST_PROJECT_ID, epic.id, { status: "open" });
      const resultAfterUnblock = await store.ready(TEST_PROJECT_ID);
      expect(resultAfterUnblock).toHaveLength(1);
      expect(resultAfterUnblock[0].title).toBe("Task under epic");
    });
  });

  describe("areAllBlockersClosed", () => {
    it("should return true when task has no blockers", async () => {
      const task = await store.create(TEST_PROJECT_ID, "Task");
      expect(await store.areAllBlockersClosed(TEST_PROJECT_ID, task.id)).toBe(true);
    });

    it("should return true when all blockers are closed", async () => {
      const blocker = await store.create(TEST_PROJECT_ID, "Blocker");
      const task = await store.create(TEST_PROJECT_ID, "Task");
      await store.addDependency(TEST_PROJECT_ID, task.id, blocker.id, "blocks");
      await store.close(TEST_PROJECT_ID, blocker.id, "Done");
      expect(await store.areAllBlockersClosed(TEST_PROJECT_ID, task.id)).toBe(true);
    });

    it("should return false when a blocker is in_progress", async () => {
      const blocker = await store.create(TEST_PROJECT_ID, "Blocker");
      const task = await store.create(TEST_PROJECT_ID, "Task");
      await store.addDependency(TEST_PROJECT_ID, task.id, blocker.id, "blocks");
      await store.update(TEST_PROJECT_ID, blocker.id, { status: "in_progress" });
      expect(await store.areAllBlockersClosed(TEST_PROJECT_ID, task.id)).toBe(false);
    });
  });

  describe("delete", () => {
    it("should remove the task", async () => {
      const created = await store.create(TEST_PROJECT_ID, "To Delete");
      await store.delete(TEST_PROJECT_ID, created.id);
      expect(() => store.show(TEST_PROJECT_ID, created.id)).toThrow(/not found/);
    });

    it("should remove associated dependencies", async () => {
      const parent = await store.create(TEST_PROJECT_ID, "Parent");
      const child = await store.create(TEST_PROJECT_ID, "Child");
      await store.addDependency(TEST_PROJECT_ID, child.id, parent.id, "blocks");
      await store.delete(TEST_PROJECT_ID, child.id);

      const parentTask = store.show(TEST_PROJECT_ID, parent.id);
      expect(parentTask.dependent_count).toBe(0);
    });
  });

  describe("deleteMany", () => {
    it("should remove multiple tasks", async () => {
      const t1 = await store.create(TEST_PROJECT_ID, "Task 1");
      const t2 = await store.create(TEST_PROJECT_ID, "Task 2");
      const t3 = await store.create(TEST_PROJECT_ID, "Task 3");
      await store.deleteMany(TEST_PROJECT_ID, [t1.id, t3.id]);

      expect(() => store.show(TEST_PROJECT_ID, t1.id)).toThrow(/not found/);
      expect(() => store.show(TEST_PROJECT_ID, t3.id)).toThrow(/not found/);
      expect(store.show(TEST_PROJECT_ID, t2.id)).toBeDefined();
    });

    it("should not throw when given empty array", async () => {
      await expect(store.deleteMany(TEST_PROJECT_ID, [])).resolves.not.toThrow();
    });

    it("should deduplicate ids", async () => {
      const t1 = await store.create(TEST_PROJECT_ID, "Task 1");
      await store.deleteMany(TEST_PROJECT_ID, [t1.id, t1.id]);
      expect(() => store.show(TEST_PROJECT_ID, t1.id)).toThrow(/not found/);
    });
  });

  describe("addDependency", () => {
    it("should add a dependency to a task", async () => {
      const t1 = await store.create(TEST_PROJECT_ID, "Blocker");
      const t2 = await store.create(TEST_PROJECT_ID, "Blocked");
      await store.addDependency(TEST_PROJECT_ID, t2.id, t1.id, "blocks");

      const updated = store.show(TEST_PROJECT_ID, t2.id);
      expect(
        updated.dependencies?.some((d) => d.depends_on_id === t1.id && d.type === "blocks")
      ).toBe(true);
    });

    it("should not duplicate dependencies", async () => {
      const t1 = await store.create(TEST_PROJECT_ID, "Blocker");
      const t2 = await store.create(TEST_PROJECT_ID, "Blocked");
      await store.addDependency(TEST_PROJECT_ID, t2.id, t1.id, "blocks");
      await store.addDependency(TEST_PROJECT_ID, t2.id, t1.id, "blocks");

      const updated = store.show(TEST_PROJECT_ID, t2.id);
      expect(updated.dependencies).toHaveLength(1);
    });
  });

  describe("addDependencies", () => {
    it("should add multiple dependencies in a single transaction", async () => {
      const t1 = await store.create(TEST_PROJECT_ID, "Task 1");
      const t2 = await store.create(TEST_PROJECT_ID, "Task 2");
      const t3 = await store.create(TEST_PROJECT_ID, "Task 3");
      await store.addDependencies(TEST_PROJECT_ID, [
        { childId: t3.id, parentId: t1.id, type: "blocks" },
        { childId: t3.id, parentId: t2.id, type: "blocks" },
      ]);

      const updated = store.show(TEST_PROJECT_ID, t3.id);
      expect(updated.dependencies).toHaveLength(2);
    });
  });

  describe("labels", () => {
    it("should add a label to a task", async () => {
      const created = await store.create(TEST_PROJECT_ID, "Task");
      await store.addLabel(TEST_PROJECT_ID, created.id, "attempts:2");
      const updated = store.show(TEST_PROJECT_ID, created.id);
      expect(updated.labels?.includes("attempts:2")).toBe(true);
    });

    it("should remove a label from a task", async () => {
      const created = await store.create(TEST_PROJECT_ID, "Task");
      await store.addLabel(TEST_PROJECT_ID, created.id, "attempts:2");
      await store.removeLabel(TEST_PROJECT_ID, created.id, "attempts:2");
      const updated = store.show(TEST_PROJECT_ID, created.id);
      expect(updated.labels?.includes("attempts:2")).toBe(false);
    });

    it("should not duplicate labels", async () => {
      const created = await store.create(TEST_PROJECT_ID, "Task");
      await store.addLabel(TEST_PROJECT_ID, created.id, "foo");
      await store.addLabel(TEST_PROJECT_ID, created.id, "foo");
      const updated = store.show(TEST_PROJECT_ID, created.id);
      expect(updated.labels?.filter((l) => l === "foo")).toHaveLength(1);
    });
  });

  describe("getCumulativeAttempts", () => {
    it("returns 0 when no attempts label", async () => {
      const created = await store.create(TEST_PROJECT_ID, "Task");
      expect(await store.getCumulativeAttempts(TEST_PROJECT_ID, created.id)).toBe(0);
    });

    it("returns count from attempts:N label", async () => {
      const created = await store.create(TEST_PROJECT_ID, "Task");
      await store.addLabel(TEST_PROJECT_ID, created.id, "attempts:3");
      expect(await store.getCumulativeAttempts(TEST_PROJECT_ID, created.id)).toBe(3);
    });
  });

  describe("setCumulativeAttempts", () => {
    it("adds attempts:N label when none exists", async () => {
      const created = await store.create(TEST_PROJECT_ID, "Task");
      await store.setCumulativeAttempts(TEST_PROJECT_ID, created.id, 2);
      const issue = store.show(TEST_PROJECT_ID, created.id);
      expect(issue.labels?.includes("attempts:2")).toBe(true);
    });

    it("removes old attempts label before adding new one", async () => {
      const created = await store.create(TEST_PROJECT_ID, "Task");
      await store.setCumulativeAttempts(TEST_PROJECT_ID, created.id, 1);
      await store.setCumulativeAttempts(TEST_PROJECT_ID, created.id, 2);
      const issue = store.show(TEST_PROJECT_ID, created.id);
      const attemptsLabels = (issue.labels ?? []).filter((l: string) => l.startsWith("attempts:"));
      expect(attemptsLabels).toEqual(["attempts:2"]);
    });
  });

  describe("listInProgressWithAgentAssignee", () => {
    it("should return only in_progress tasks with known agent name assignee", async () => {
      const t1 = await store.create(TEST_PROJECT_ID, "T1");
      await store.update(TEST_PROJECT_ID, t1.id, { status: "in_progress", assignee: "Frodo" });

      const t2 = await store.create(TEST_PROJECT_ID, "T2");
      await store.update(TEST_PROJECT_ID, t2.id, { assignee: "Frodo" });

      const t3 = await store.create(TEST_PROJECT_ID, "T3");
      await store.update(TEST_PROJECT_ID, t3.id, {
        status: "in_progress",
        assignee: "Todd Medema",
      });

      const t4 = await store.create(TEST_PROJECT_ID, "T4");
      await store.update(TEST_PROJECT_ID, t4.id, { status: "in_progress", assignee: "Samwise" });

      const result = await store.listInProgressWithAgentAssignee(TEST_PROJECT_ID);
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.id).sort()).toEqual([t1.id, t4.id].sort());
    });
  });

  describe("getParentId", () => {
    it("should derive parent ID from task ID", () => {
      expect(store.getParentId("os-a3f8.1")).toBe("os-a3f8");
      expect(store.getParentId("os-a3f8.1.1")).toBe("os-a3f8.1");
    });

    it("should return null for top-level IDs", () => {
      expect(store.getParentId("os-a3f8")).toBeNull();
    });
  });

  describe("hasLabel", () => {
    it("should return true if label exists", async () => {
      const task = await store.create(TEST_PROJECT_ID, "Task");
      await store.addLabel(TEST_PROJECT_ID, task.id, "blocked");
      const updated = store.show(TEST_PROJECT_ID, task.id);
      expect(store.hasLabel(updated, "blocked")).toBe(true);
    });

    it("should return false if label does not exist", async () => {
      const task = await store.create(TEST_PROJECT_ID, "Task");
      expect(store.hasLabel(task, "nonexistent")).toBe(false);
    });
  });

  describe("getFileScopeLabels", () => {
    it("should parse files: label", async () => {
      const task = await store.create(TEST_PROJECT_ID, "Task");
      const scope = { modify: ["src/a.ts"], create: ["src/b.ts"] };
      await store.addLabel(TEST_PROJECT_ID, task.id, `files:${JSON.stringify(scope)}`);
      const updated = store.show(TEST_PROJECT_ID, task.id);
      expect(store.getFileScopeLabels(updated)).toEqual(scope);
    });

    it("should return null when no files label", async () => {
      const task = await store.create(TEST_PROJECT_ID, "Task");
      expect(store.getFileScopeLabels(task)).toBeNull();
    });
  });

  describe("setActualFiles", () => {
    it("should store actual files as label", async () => {
      const task = await store.create(TEST_PROJECT_ID, "Task");
      await store.setActualFiles(TEST_PROJECT_ID, task.id, ["src/a.ts", "src/b.ts"]);
      const updated = store.show(TEST_PROJECT_ID, task.id);
      const label = updated.labels?.find((l) => l.startsWith("actual_files:"));
      expect(label).toBeTruthy();
      expect(JSON.parse(label!.slice("actual_files:".length))).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("should replace existing actual_files label", async () => {
      const task = await store.create(TEST_PROJECT_ID, "Task");
      await store.setActualFiles(TEST_PROJECT_ID, task.id, ["src/a.ts"]);
      await store.setActualFiles(TEST_PROJECT_ID, task.id, ["src/b.ts"]);
      const updated = store.show(TEST_PROJECT_ID, task.id);
      const labels = updated.labels?.filter((l) => l.startsWith("actual_files:")) ?? [];
      expect(labels).toHaveLength(1);
      expect(JSON.parse(labels[0].slice("actual_files:".length))).toEqual(["src/b.ts"]);
    });
  });

  describe("syncForPush", () => {
    it("should be a no-op that resolves", async () => {
      await expect(store.syncForPush(TEST_PROJECT_ID)).resolves.toBeUndefined();
    });
  });

  describe("getStatusMap", () => {
    it("should build id→status map from all tasks", async () => {
      const t1 = await store.create(TEST_PROJECT_ID, "Task 1");
      const t2 = await store.create(TEST_PROJECT_ID, "Task 2");
      await store.close(TEST_PROJECT_ID, t2.id, "Done");

      const map = await store.getStatusMap(TEST_PROJECT_ID);
      expect(map.get(t1.id)).toBe("open");
      expect(map.get(t2.id)).toBe("closed");
    });
  });

  describe("readyWithStatusMap", () => {
    it("should return both tasks and statusMap", async () => {
      await store.create(TEST_PROJECT_ID, "Task 1");
      const t2 = await store.create(TEST_PROJECT_ID, "Task 2");
      await store.close(TEST_PROJECT_ID, t2.id, "Done");

      const { tasks, statusMap } = await store.readyWithStatusMap(TEST_PROJECT_ID);
      expect(tasks).toHaveLength(1);
      expect(statusMap.size).toBe(2);
    });
  });

  describe("ID generation", () => {
    it("should generate unique top-level IDs", async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const task = await store.create(TEST_PROJECT_ID, `Task ${i}`);
        expect(ids.has(task.id)).toBe(false);
        ids.add(task.id);
      }
    });

    it("should use os- prefix for top-level IDs", async () => {
      const task = await store.create(TEST_PROJECT_ID, "Task");
      expect(task.id).toMatch(/^os-[0-9a-f]{4}$/);
    });
  });

  describe("plans", () => {
    const planMetadata = {
      planId: "auth",
      epicId: "os-aaaa",
      shippedAt: null as string | null,
      complexity: "medium" as const,
    };

    it("planInsert and planGet round-trip", async () => {
      await store.planInsert(TEST_PROJECT_ID, "auth", {
        epic_id: "os-aaaa",
        content: "# Auth\n\nLogin flow.",
        metadata: JSON.stringify(planMetadata),
      });
      const row = await store.planGet(TEST_PROJECT_ID, "auth");
      expect(row).not.toBeNull();
      expect(row!.content).toBe("# Auth\n\nLogin flow.");
      expect(row!.metadata.planId).toBe("auth");
      expect(row!.metadata.complexity).toBe("medium");
      expect(row!.shipped_content).toBeNull();
      expect(row!.updated_at).toBeTruthy();
    });

    it("planGet returns null for missing plan", async () => {
      const row = await store.planGet(TEST_PROJECT_ID, "nonexistent");
      expect(row).toBeNull();
    });

    it("planGetByEpicId finds plan by epic_id", async () => {
      await store.planInsert(TEST_PROJECT_ID, "dashboard", {
        epic_id: "os-bbbb",
        content: "# Dashboard",
        metadata: JSON.stringify({ ...planMetadata, planId: "dashboard", epicId: "os-bbbb" }),
      });
      const row = await store.planGetByEpicId(TEST_PROJECT_ID, "os-bbbb");
      expect(row).not.toBeNull();
      expect(row!.plan_id).toBe("dashboard");
      expect(row!.content).toBe("# Dashboard");
    });

    it("planGetByEpicId returns null for unknown epic", async () => {
      const row = await store.planGetByEpicId(TEST_PROJECT_ID, "os-zzzz");
      expect(row).toBeNull();
    });

    it("planListIds returns plan ids for project", async () => {
      await store.planInsert(TEST_PROJECT_ID, "p1", {
        epic_id: "ep1",
        content: "C1",
        metadata: JSON.stringify(planMetadata),
      });
      await store.planInsert(TEST_PROJECT_ID, "p2", {
        epic_id: "ep2",
        content: "C2",
        metadata: JSON.stringify(planMetadata),
      });
      const ids = await store.planListIds(TEST_PROJECT_ID);
      expect(ids).toContain("p1");
      expect(ids).toContain("p2");
      expect(ids.length).toBe(2);
    });

    it("planUpdateContent updates content and updated_at", async () => {
      await store.planInsert(TEST_PROJECT_ID, "edit-me", {
        epic_id: "ep",
        content: "Original",
        metadata: JSON.stringify(planMetadata),
      });
      await store.planUpdateContent(TEST_PROJECT_ID, "edit-me", "Updated content");
      const row = await store.planGet(TEST_PROJECT_ID, "edit-me");
      expect(row!.content).toBe("Updated content");
    });

    it("planUpdateMetadata replaces metadata JSON", async () => {
      await store.planInsert(TEST_PROJECT_ID, "meta-plan", {
        epic_id: "ep",
        content: "# Plan",
        metadata: JSON.stringify({ ...planMetadata, complexity: "low" }),
      });
      await store.planUpdateMetadata(TEST_PROJECT_ID, "meta-plan", {
        ...planMetadata,
        complexity: "high",
        shippedAt: "2025-01-01T00:00:00.000Z",
      });
      const row = await store.planGet(TEST_PROJECT_ID, "meta-plan");
      expect(row!.metadata.complexity).toBe("high");
      expect(row!.metadata.shippedAt).toBe("2025-01-01T00:00:00.000Z");
    });

    it("planSetShippedContent and planGetShippedContent", async () => {
      await store.planInsert(TEST_PROJECT_ID, "ship-plan", {
        epic_id: "ep",
        content: "# Current",
        metadata: JSON.stringify(planMetadata),
      });
      expect(await store.planGetShippedContent(TEST_PROJECT_ID, "ship-plan")).toBeNull();
      await store.planSetShippedContent(TEST_PROJECT_ID, "ship-plan", "# Shipped snapshot");
      expect(await store.planGetShippedContent(TEST_PROJECT_ID, "ship-plan")).toBe(
        "# Shipped snapshot"
      );
    });

    it("planUpdateContent throws when plan not found", async () => {
      await expect(store.planUpdateContent(TEST_PROJECT_ID, "no-such-plan", "x")).rejects.toThrow(
        /Plan no-such-plan not found/
      );
    });
  });

  describe("migration: plans with gate tasks to epic-blocked", () => {
    let tempDir: string;
    let originalHome: string | undefined;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-migration-test-"));
      originalHome = process.env.HOME;
      process.env.HOME = tempDir;
    });

    afterEach(async () => {
      process.env.HOME = originalHome;
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    it("migrates plan with closed gate: epic set open, gate task and deps removed", async () => {
      const store1 = new TaskStoreService();
      await store1.init();

      const now = new Date().toISOString();
      const projectId = "proj-mig";
      const epicId = "os-auth";
      const gateId = "os-auth.0";

      await store1.runWrite(async (db) => {
        db.run(
          `INSERT INTO tasks (id, project_id, title, description, issue_type, status, priority, assignee, labels, created_at, updated_at, extra)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '[]', ?, ?, '{}')`,
          [epicId, projectId, "Auth Epic", null, "epic", "blocked", 2, now, now]
        );
        db.run(
          `INSERT INTO tasks (id, project_id, title, description, issue_type, status, priority, assignee, labels, created_at, updated_at, extra)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '[]', ?, ?, '{}')`,
          [gateId, projectId, "Plan approval gate", null, "task", "closed", 2, now, now]
        );
        db.run(
          `INSERT INTO plans (project_id, plan_id, epic_id, gate_task_id, re_execute_gate_task_id, content, metadata, shipped_content, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?)`,
          [
            projectId,
            "auth-plan",
            epicId,
            gateId,
            "# Auth\n\nContent.",
            JSON.stringify({ planId: "auth-plan", epicId, shippedAt: null, complexity: "medium" }),
            now,
          ]
        );
      });

      const store2 = new TaskStoreService();
      await store2.init();

      const epic = store2.show(projectId, epicId);
      expect((epic as { status?: string }).status).toBe("open");

      await expect(store2.show(projectId, gateId)).rejects.toThrow();

      const row = await store2.planGet(projectId, "auth-plan");
      expect(row).not.toBeNull();
      expect((row!.metadata as { gateTaskId?: string }).gateTaskId).toBeUndefined();
    });

    it("migrates plan with open gate: epic set blocked", async () => {
      const store1 = new TaskStoreService();
      await store1.init();

      const now = new Date().toISOString();
      const projectId = "proj-mig2";
      const epicId = "os-dash";
      const gateId = "os-dash.0";

      await store1.runWrite(async (db) => {
        db.run(
          `INSERT INTO tasks (id, project_id, title, description, issue_type, status, priority, assignee, labels, created_at, updated_at, extra)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '[]', ?, ?, '{}')`,
          [epicId, projectId, "Dashboard Epic", null, "epic", "blocked", 2, now, now]
        );
        db.run(
          `INSERT INTO tasks (id, project_id, title, description, issue_type, status, priority, assignee, labels, created_at, updated_at, extra)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '[]', ?, ?, '{}')`,
          [gateId, projectId, "Plan approval gate", null, "task", "open", 2, now, now]
        );
        db.run(
          `INSERT INTO plans (project_id, plan_id, epic_id, gate_task_id, re_execute_gate_task_id, content, metadata, shipped_content, updated_at)
           VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?)`,
          [
            projectId,
            "dash-plan",
            epicId,
            gateId,
            "# Dashboard\n\nContent.",
            JSON.stringify({ planId: "dash-plan", epicId, shippedAt: null, complexity: "low" }),
            now,
          ]
        );
      });

      const store2 = new TaskStoreService();
      await store2.init();

      const epic = store2.show(projectId, epicId);
      expect((epic as { status?: string }).status).toBe("blocked");

      await expect(store2.show(projectId, gateId)).rejects.toThrow();
    });
  });
});
