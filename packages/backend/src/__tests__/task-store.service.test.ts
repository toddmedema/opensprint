import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from "vitest";
import type { Pool } from "pg";
import { runSchema, toPgParams, type DbClient } from "../db/index.js";
import { TaskStoreService } from "../services/task-store.service.js";
import { createTestPostgresClient } from "./test-db-helper.js";

const TEST_PROJECT_ID = "test-project";

const withDb = await createTestPostgresClient();
const suite = withDb ? describe : describe.skip;

suite("TaskStoreService", () => {
  if (!withDb) return;
  let store: TaskStoreService;
  const { client, pool } = withDb;

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await runSchema(client);
    store = new TaskStoreService(client);
    await store.init();
    await store.deleteByProjectId(TEST_PROJECT_ID);
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

    it("should persist complexity in column when provided", async () => {
      const result = await store.create(TEST_PROJECT_ID, "Complex Task", {
        type: "task",
        complexity: 7,
      });
      expect((result as { complexity?: number }).complexity).toBe(7);
      const refetched = await store.show(TEST_PROJECT_ID, result.id);
      expect((refetched as { complexity?: number }).complexity).toBe(7);
    });

    it("should persist extra.sourceFeedbackIds when provided", async () => {
      const result = await store.create(TEST_PROJECT_ID, "Feedback Task", {
        type: "task",
        extra: { sourceFeedbackIds: ["fb-123"] },
      });
      expect((result as { sourceFeedbackIds?: string[] }).sourceFeedbackIds).toEqual(["fb-123"]);
      const refetched = await store.show(TEST_PROJECT_ID, result.id);
      expect((refetched as { sourceFeedbackIds?: string[] }).sourceFeedbackIds).toEqual([
        "fb-123",
      ]);
    });
  });

  describe("onTaskChange callback", () => {
    it("invokes callback on create with changeType create", async () => {
      const calls: Array<[string, "create" | "update" | "close", unknown]> = [];
      store.setOnTaskChange((projectId, changeType, task) => {
        calls.push([projectId, changeType, task]);
      });

      const result = await store.create(TEST_PROJECT_ID, "New Task", { type: "task" });

      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe(TEST_PROJECT_ID);
      expect(calls[0][1]).toBe("create");
      expect((calls[0][2] as { id: string; title: string }).id).toBe(result.id);
      expect((calls[0][2] as { id: string; title: string }).title).toBe("New Task");
    });

    it("invokes callback on update with changeType update", async () => {
      const task = await store.create(TEST_PROJECT_ID, "Task", { type: "task" });
      const calls: Array<[string, "create" | "update" | "close", unknown]> = [];
      store.setOnTaskChange((projectId, changeType, t) => {
        calls.push([projectId, changeType, t]);
      });

      await store.update(TEST_PROJECT_ID, task.id, { status: "in_progress", assignee: "agent-1" });

      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toBe("update");
      expect((calls[0][2] as { status: string }).status).toBe("in_progress");
    });

    it("invokes callback on close with changeType close", async () => {
      const task = await store.create(TEST_PROJECT_ID, "Task", { type: "task" });
      const calls: Array<[string, "create" | "update" | "close", unknown]> = [];
      store.setOnTaskChange((projectId, changeType, t) => {
        calls.push([projectId, changeType, t]);
      });

      await store.close(TEST_PROJECT_ID, task.id, "Done");

      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toBe("close");
      expect((calls[0][2] as { status: string }).status).toBe("closed");
    });

    it("does not invoke when callback is null", async () => {
      store.setOnTaskChange(null);
      await store.create(TEST_PROJECT_ID, "Task", { type: "task" });
      store.setOnTaskChange(() => {
        throw new Error("Should not be called");
      });
      store.setOnTaskChange(null);
      await store.create(TEST_PROJECT_ID, "Another Task", { type: "task" });
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
        { title: "Simple Task", type: "task", complexity: 3 },
        { title: "Complex Task", type: "task", complexity: 7 },
      ]);
      expect((results[0] as { complexity?: number }).complexity).toBe(3);
      expect((results[1] as { complexity?: number }).complexity).toBe(7);
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
        complexity: 7,
      });
      expect((result as { complexity?: number }).complexity).toBe(7);
      const refetched = await store.show(TEST_PROJECT_ID, created.id);
      expect((refetched as { complexity?: number }).complexity).toBe(7);
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
      const refetched = await store.show(TEST_PROJECT_ID, created.id);
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
      const refetched = await store.show(TEST_PROJECT_ID, created.id);
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
      expect([null, undefined]).toContain((result as { block_reason?: string | null }).block_reason);
    });

    it("should persist last_auto_retry_at when set", async () => {
      const created = await store.create(TEST_PROJECT_ID, "My Task");
      const ts = "2026-02-27T12:00:00.000Z";
      const result = await store.update(TEST_PROJECT_ID, created.id, {
        last_auto_retry_at: ts,
      });
      expect((result as { last_auto_retry_at?: string }).last_auto_retry_at).toBe(ts);
      const refetched = await store.show(TEST_PROJECT_ID, created.id);
      expect((refetched as { last_auto_retry_at?: string }).last_auto_retry_at).toBe(ts);
    });
  });

  describe("listBlockedByTechnicalErrorEligibleForRetry", () => {
    it("returns tasks blocked by Merge Failure or Coding Failure with no last_auto_retry_at", async () => {
      const t1 = await store.create(TEST_PROJECT_ID, "Task 1");
      const t2 = await store.create(TEST_PROJECT_ID, "Task 2");
      const t3 = await store.create(TEST_PROJECT_ID, "Task 3");
      await store.update(TEST_PROJECT_ID, t1.id, {
        status: "blocked",
        block_reason: "Merge Failure",
      });
      await store.update(TEST_PROJECT_ID, t2.id, {
        status: "blocked",
        block_reason: "Coding Failure",
      });
      await store.update(TEST_PROJECT_ID, t3.id, {
        status: "blocked",
        block_reason: "Open Question",
      });
      const eligible = await store.listBlockedByTechnicalErrorEligibleForRetry(TEST_PROJECT_ID);
      const ids = eligible.map((t) => t.id).sort();
      expect(ids).toEqual([t1.id, t2.id].sort());
    });

    it("excludes tasks blocked by human-feedback reasons", async () => {
      const t = await store.create(TEST_PROJECT_ID, "Human blocked");
      await store.update(TEST_PROJECT_ID, t.id, {
        status: "blocked",
        block_reason: "Open Question",
      });
      const eligible = await store.listBlockedByTechnicalErrorEligibleForRetry(TEST_PROJECT_ID);
      expect(eligible.map((e) => e.id)).not.toContain(t.id);
    });

    it("excludes technical-error tasks retried within 8 hours", async () => {
      const t = await store.create(TEST_PROJECT_ID, "Recently retried");
      const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago
      await store.update(TEST_PROJECT_ID, t.id, {
        status: "blocked",
        block_reason: "Merge Failure",
        last_auto_retry_at: recent,
      });
      const eligible = await store.listBlockedByTechnicalErrorEligibleForRetry(TEST_PROJECT_ID);
      expect(eligible.map((e) => e.id)).not.toContain(t.id);
    });

    it("includes technical-error tasks retried more than 8 hours ago", async () => {
      const t = await store.create(TEST_PROJECT_ID, "Old retry");
      const old = new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString(); // 9 hours ago
      await store.update(TEST_PROJECT_ID, t.id, {
        status: "blocked",
        block_reason: "Coding Failure",
        last_auto_retry_at: old,
      });
      const eligible = await store.listBlockedByTechnicalErrorEligibleForRetry(TEST_PROJECT_ID);
      expect(eligible.map((e) => e.id)).toContain(t.id);
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
      const result = await store.show(TEST_PROJECT_ID, created.id);
      expect(result.id).toBe(created.id);
      expect(result.title).toBe("Implement login");
      expect(result.description).toBe("Add JWT auth");
    });

    it("should throw when task not found", async () => {
      await expect(store.show(TEST_PROJECT_ID, "nonexistent")).rejects.toThrow(
        /Task nonexistent not found/
      );
    });

    it("should accept projectId as first argument for show", async () => {
      const created = await store.create(TEST_PROJECT_ID, "Task");
      const result = await store.show(TEST_PROJECT_ID, created.id);
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

    it("readyWithStatusMap excludes tasks in blocked epic and includes after unblock", async () => {
      const epic = await store.create(TEST_PROJECT_ID, "Epic RWS", { type: "epic" });
      const t1 = await store.create(TEST_PROJECT_ID, "Task RWS-1", {
        type: "task",
        parentId: epic.id,
      });
      const t2 = await store.create(TEST_PROJECT_ID, "Task RWS-2", {
        type: "task",
        parentId: epic.id,
      });
      await store.addDependency(TEST_PROJECT_ID, t2.id, t1.id, "blocks");
      await store.update(TEST_PROJECT_ID, epic.id, { status: "blocked" });

      const { tasks: blocked, statusMap: blockedMap } = await store.readyWithStatusMap(
        TEST_PROJECT_ID
      );
      expect(blocked.filter((t) => t.id === t1.id || t.id === t2.id)).toHaveLength(0);
      expect(blockedMap.get(epic.id)).toBe("blocked");

      await store.update(TEST_PROJECT_ID, epic.id, { status: "open" });
      const { tasks: unblocked } = await store.readyWithStatusMap(TEST_PROJECT_ID);
      expect(unblocked.map((t) => t.id)).toContain(t1.id);
      expect(unblocked.map((t) => t.id)).not.toContain(t2.id);
    });

    it("epic blocked→open→blocked (re-execute cycle) toggles task readiness", async () => {
      const epic = await store.create(TEST_PROJECT_ID, "Epic Cycle", { type: "epic" });
      await store.create(TEST_PROJECT_ID, "Task Cycle-1", {
        type: "task",
        parentId: epic.id,
      });
      await store.update(TEST_PROJECT_ID, epic.id, { status: "blocked" });

      expect(await store.ready(TEST_PROJECT_ID)).toHaveLength(0);

      await store.update(TEST_PROJECT_ID, epic.id, { status: "open" });
      expect(await store.ready(TEST_PROJECT_ID)).toHaveLength(1);

      await store.update(TEST_PROJECT_ID, epic.id, { status: "blocked" });
      expect(await store.ready(TEST_PROJECT_ID)).toHaveLength(0);

      await store.update(TEST_PROJECT_ID, epic.id, { status: "open" });
      expect(await store.ready(TEST_PROJECT_ID)).toHaveLength(1);
    });

    it("tasks in open epic are ready; tasks in blocked epic are not (mixed epics)", async () => {
      const epicOpen = await store.create(TEST_PROJECT_ID, "Epic Open", { type: "epic" });
      const epicBlocked = await store.create(TEST_PROJECT_ID, "Epic Blocked", { type: "epic" });
      await store.create(TEST_PROJECT_ID, "Task in open epic", {
        type: "task",
        parentId: epicOpen.id,
      });
      await store.create(TEST_PROJECT_ID, "Task in blocked epic", {
        type: "task",
        parentId: epicBlocked.id,
      });
      await store.update(TEST_PROJECT_ID, epicBlocked.id, { status: "blocked" });

      const ready = await store.ready(TEST_PROJECT_ID);
      expect(ready.map((t) => t.title)).toContain("Task in open epic");
      expect(ready.map((t) => t.title)).not.toContain("Task in blocked epic");
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
      await expect(store.show(TEST_PROJECT_ID, created.id)).rejects.toThrow(/not found/);
    });

    it("should remove associated dependencies", async () => {
      const parent = await store.create(TEST_PROJECT_ID, "Parent");
      const child = await store.create(TEST_PROJECT_ID, "Child");
      await store.addDependency(TEST_PROJECT_ID, child.id, parent.id, "blocks");
      await store.delete(TEST_PROJECT_ID, child.id);

      const parentTask = await store.show(TEST_PROJECT_ID, parent.id);
      expect(parentTask.dependent_count).toBe(0);
    });
  });

  describe("deleteMany", () => {
    it("should remove multiple tasks", async () => {
      const t1 = await store.create(TEST_PROJECT_ID, "Task 1");
      const t2 = await store.create(TEST_PROJECT_ID, "Task 2");
      const t3 = await store.create(TEST_PROJECT_ID, "Task 3");
      await store.deleteMany(TEST_PROJECT_ID, [t1.id, t3.id]);

      await expect(store.show(TEST_PROJECT_ID, t1.id)).rejects.toThrow(/not found/);
      await expect(store.show(TEST_PROJECT_ID, t3.id)).rejects.toThrow(/not found/);
      expect(await store.show(TEST_PROJECT_ID, t2.id)).toBeDefined();
    });

    it("should not throw when given empty array", async () => {
      await expect(store.deleteMany(TEST_PROJECT_ID, [])).resolves.not.toThrow();
    });

    it("should deduplicate ids", async () => {
      const t1 = await store.create(TEST_PROJECT_ID, "Task 1");
      await store.deleteMany(TEST_PROJECT_ID, [t1.id, t1.id]);
      await expect(store.show(TEST_PROJECT_ID, t1.id)).rejects.toThrow(/not found/);
    });
  });

  describe("addDependency", () => {
    it("should add a dependency to a task", async () => {
      const t1 = await store.create(TEST_PROJECT_ID, "Blocker");
      const t2 = await store.create(TEST_PROJECT_ID, "Blocked");
      await store.addDependency(TEST_PROJECT_ID, t2.id, t1.id, "blocks");

      const updated = await store.show(TEST_PROJECT_ID, t2.id);
      expect(
        updated.dependencies?.some((d) => d.depends_on_id === t1.id && d.type === "blocks")
      ).toBe(true);
    });

    it("should not duplicate dependencies", async () => {
      const t1 = await store.create(TEST_PROJECT_ID, "Blocker");
      const t2 = await store.create(TEST_PROJECT_ID, "Blocked");
      await store.addDependency(TEST_PROJECT_ID, t2.id, t1.id, "blocks");
      await store.addDependency(TEST_PROJECT_ID, t2.id, t1.id, "blocks");

      const updated = await store.show(TEST_PROJECT_ID, t2.id);
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

      const updated = await store.show(TEST_PROJECT_ID, t3.id);
      expect(updated.dependencies).toHaveLength(2);
    });
  });

  describe("labels", () => {
    it("should add a label to a task", async () => {
      const created = await store.create(TEST_PROJECT_ID, "Task");
      await store.addLabel(TEST_PROJECT_ID, created.id, "attempts:2");
      const updated = await store.show(TEST_PROJECT_ID, created.id);
      expect(updated.labels?.includes("attempts:2")).toBe(true);
    });

    it("should remove a label from a task", async () => {
      const created = await store.create(TEST_PROJECT_ID, "Task");
      await store.addLabel(TEST_PROJECT_ID, created.id, "attempts:2");
      await store.removeLabel(TEST_PROJECT_ID, created.id, "attempts:2");
      const updated = await store.show(TEST_PROJECT_ID, created.id);
      expect(updated.labels?.includes("attempts:2")).toBe(false);
    });

    it("should not duplicate labels", async () => {
      const created = await store.create(TEST_PROJECT_ID, "Task");
      await store.addLabel(TEST_PROJECT_ID, created.id, "foo");
      await store.addLabel(TEST_PROJECT_ID, created.id, "foo");
      const updated = await store.show(TEST_PROJECT_ID, created.id);
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
      const issue = await store.show(TEST_PROJECT_ID, created.id);
      expect(issue.labels?.includes("attempts:2")).toBe(true);
    });

    it("removes old attempts label before adding new one", async () => {
      const created = await store.create(TEST_PROJECT_ID, "Task");
      await store.setCumulativeAttempts(TEST_PROJECT_ID, created.id, 1);
      await store.setCumulativeAttempts(TEST_PROJECT_ID, created.id, 2);
      const issue = await store.show(TEST_PROJECT_ID, created.id);
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
      const updated = await store.show(TEST_PROJECT_ID, task.id);
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
      const updated = await store.show(TEST_PROJECT_ID, task.id);
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
      const updated = await store.show(TEST_PROJECT_ID, task.id);
      const label = updated.labels?.find((l) => l.startsWith("actual_files:"));
      expect(label).toBeTruthy();
      expect(JSON.parse(label!.slice("actual_files:".length))).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("should replace existing actual_files label", async () => {
      const task = await store.create(TEST_PROJECT_ID, "Task");
      await store.setActualFiles(TEST_PROJECT_ID, task.id, ["src/a.ts"]);
      await store.setActualFiles(TEST_PROJECT_ID, task.id, ["src/b.ts"]);
      const updated = await store.show(TEST_PROJECT_ID, task.id);
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

  describe("deleteByProjectId", () => {
    it("should remove tasks, dependencies, feedback, sessions, stats, events, counters, deployments, plans, and open_questions for a project", async () => {
      const pid = "proj-delete-test";
      const otherPid = "proj-keep";
      const now = new Date().toISOString();

      // Clear any leftover data from a previous run so inserts are idempotent
      await store.deleteByProjectId(pid);
      await store.deleteByProjectId(otherPid);

      const task = await store.create(pid, "Task A", { type: "task" });
      const task2 = await store.create(pid, "Task B", { type: "task" });
      await store.addDependency(pid, task2.id, task.id, "blocks");

      const keepTask = await store.create(otherPid, "Keep Me", { type: "task" });

      const db = await store.getDb();
      await db.execute(
        toPgParams(`INSERT INTO feedback (id, project_id, text, category, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
        ["fb-1", pid, "Fix bug", "bug", "open", now]
      );
      await db.execute(
        toPgParams(`INSERT INTO feedback (id, project_id, text, category, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`),
        ["fb-2", otherPid, "Other bug", "bug", "open", now]
      );
      await db.execute(
        toPgParams(`INSERT INTO feedback_inbox (project_id, feedback_id, enqueued_at) VALUES (?, ?, ?)`),
        [pid, "fb-1", now]
      );
      await db.execute(
        toPgParams(`INSERT INTO agent_sessions (project_id, task_id, attempt, agent_type, agent_model, started_at, status, git_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        [pid, task.id, 1, "coder", "claude", now, "completed", "opensprint/test"]
      );
      await db.execute(
        toPgParams(`INSERT INTO agent_stats (project_id, task_id, agent_id, model, attempt, started_at, completed_at, outcome, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
        [pid, task.id, "agent-1", "claude", 1, now, now, "success", 1000]
      );
      await db.execute(
        toPgParams(`INSERT INTO orchestrator_events (project_id, task_id, timestamp, event) VALUES (?, ?, ?, ?)`),
        [pid, task.id, now, "assigned"]
      );
      await db.execute(
        toPgParams(`INSERT INTO orchestrator_counters (project_id, total_done, total_failed, queue_depth, updated_at) VALUES (?, ?, ?, ?, ?)`),
        [pid, 5, 1, 3, now]
      );
      await db.execute(
        toPgParams(`INSERT INTO deployments (id, project_id, status, started_at) VALUES (?, ?, ?, ?)`),
        ["dep-1", pid, "completed", now]
      );
      await db.execute(
        toPgParams(`INSERT INTO open_questions (id, project_id, source, source_id, questions, status, created_at, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        ["oq-1", pid, "execute", "task-1", "[]", "open", now, "open_question"]
      );
      await db.execute(
        toPgParams(`INSERT INTO open_questions (id, project_id, source, source_id, questions, status, created_at, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        ["oq-other", otherPid, "execute", "task-2", "[]", "open", now, "open_question"]
      );
      await store.planInsert(pid, "plan-1", {
        epic_id: "ep-1",
        content: "# Plan",
        metadata: JSON.stringify({ planId: "plan-1" }),
      });

      await store.deleteByProjectId(pid);

      const tasks = await store.listAll(pid);
      expect(tasks).toHaveLength(0);

      const kept = await store.listAll(otherPid);
      expect(kept).toHaveLength(1);
      expect(kept[0].id).toBe(keepTask.id);

      const countRow = async (table: string, projId: string): Promise<number> => {
        const row = await db.queryOne(
          `SELECT COUNT(*)::int as cnt FROM ${table} WHERE project_id = $1`,
          [projId]
        );
        return (row?.cnt as number) ?? 0;
      };

      expect(await countRow("feedback", pid)).toBe(0);
      expect(await countRow("feedback", otherPid)).toBe(1);
      expect(await countRow("feedback_inbox", pid)).toBe(0);
      expect(await countRow("agent_sessions", pid)).toBe(0);
      expect(await countRow("agent_stats", pid)).toBe(0);
      expect(await countRow("orchestrator_events", pid)).toBe(0);
      expect(await countRow("orchestrator_counters", pid)).toBe(0);
      expect(await countRow("deployments", pid)).toBe(0);
      expect(await countRow("plans", pid)).toBe(0);
      expect(await countRow("open_questions", pid)).toBe(0);
      expect(await countRow("open_questions", otherPid)).toBe(1);

      const depRow = await db.queryOne(
        "SELECT COUNT(*)::int as cnt FROM task_dependencies WHERE task_id = $1 OR depends_on_id = $2",
        [task.id, task.id]
      );
      expect(depRow?.cnt).toBe(0);
    });

    it("should be idempotent — second call on same project does not error", async () => {
      const pid = "proj-idempotent";
      await store.create(pid, "Task", { type: "task" });
      await store.deleteByProjectId(pid);
      await store.deleteByProjectId(pid);
      const tasks = await store.listAll(pid);
      expect(tasks).toHaveLength(0);
    });
  });

  describe("deleteOpenQuestionsByProjectId", () => {
    it("should remove all open_questions for a project", async () => {
      const pid = "proj-oq-test";
      const otherPid = "proj-oq-keep";
      const now = new Date().toISOString();

      // Clear any leftover open_questions so inserts are idempotent
      await store.deleteOpenQuestionsByProjectId(pid);
      await store.deleteOpenQuestionsByProjectId(otherPid);

      const db = await store.getDb();
      await db.execute(
        toPgParams(`INSERT INTO open_questions (id, project_id, source, source_id, questions, status, created_at, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        ["oq-a", pid, "execute", "task-1", "[]", "open", now, "open_question"]
      );
      await db.execute(
        toPgParams(`INSERT INTO open_questions (id, project_id, source, source_id, questions, status, created_at, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        ["oq-b", pid, "plan", "plan-1", "[]", "open", now, "open_question"]
      );
      await db.execute(
        toPgParams(`INSERT INTO open_questions (id, project_id, source, source_id, questions, status, created_at, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
        ["oq-keep", otherPid, "execute", "task-2", "[]", "open", now, "open_question"]
      );

      await store.deleteOpenQuestionsByProjectId(pid);

      const countRow = async (table: string, projId: string): Promise<number> => {
        const row = await db.queryOne(
          `SELECT COUNT(*)::int as cnt FROM ${table} WHERE project_id = $1`,
          [projId]
        );
        return (row?.cnt as number) ?? 0;
      };
      expect(await countRow("open_questions", pid)).toBe(0);
      expect(await countRow("open_questions", otherPid)).toBe(1);
    });
  });

  describe("pruneAgentSessions", () => {
    beforeEach(async () => {
      await store.runWrite(async (db) => {
        await db.execute("DELETE FROM agent_sessions");
        await db.execute("ALTER SEQUENCE agent_sessions_id_seq RESTART WITH 1");
      });
    });

    it("returns 0 when <= 100 sessions", async () => {
      await store.runWrite(async (client) => {
        const now = new Date().toISOString();
        for (let i = 0; i < 50; i++) {
          await client.execute(
            toPgParams(`INSERT INTO agent_sessions (project_id, task_id, attempt, agent_type, agent_model, started_at, status, git_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
            ["proj", `task-${i}`, 1, "coder", "claude", now, "success", "branch"]
          );
        }
      });
      const pruned = await store.pruneAgentSessions();
      expect(pruned).toBe(0);

      const db = await store.getDb();
      const row = await db.queryOne("SELECT COUNT(*)::int as cnt FROM agent_sessions");
      expect(row?.cnt).toBe(50);
    });

    it("keeps 100 most recent and prunes older", async () => {
      await store.runWrite(async (client) => {
        const now = new Date().toISOString();
        for (let i = 0; i < 150; i++) {
          await client.execute(
            toPgParams(`INSERT INTO agent_sessions (project_id, task_id, attempt, agent_type, agent_model, started_at, status, git_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
            ["proj", `task-${i}`, 1, "coder", "claude", now, "success", "branch"]
          );
        }
      });

      const pruned = await store.pruneAgentSessions();
      expect(pruned).toBe(50);

      const db = await store.getDb();
      const row = await db.queryOne("SELECT COUNT(*)::int as cnt FROM agent_sessions");
      expect(row?.cnt).toBe(100);

      const idsRows = await db.query("SELECT id FROM agent_sessions ORDER BY id ASC");
      const ids = idsRows.map((r) => r.id as number);
      expect(ids).toHaveLength(100);
      expect(Math.min(...ids)).toBe(51);
      expect(Math.max(...ids)).toBe(150);
    });

    it("runs VACUUM after pruning without error", async () => {
      await store.runWrite(async (client) => {
        const now = new Date().toISOString();
        for (let i = 0; i < 120; i++) {
          await client.execute(
            toPgParams(`INSERT INTO agent_sessions (project_id, task_id, attempt, agent_type, agent_model, started_at, status, git_branch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
            ["proj", `task-${i}`, 1, "coder", "claude", now, "success", "branch"]
          );
        }
      });

      await expect(store.pruneAgentSessions()).resolves.toBe(20);
    });
  });
});
