import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TaskUpdatedEvent, TaskCreatedEvent, TaskClosedEvent } from "@opensprint/shared";
import {
  getAuthoritativeMergeWsFields,
  buildTaskUpdatedServerEvent,
  wireTaskStoreEvents,
  type BroadcastFn,
} from "../task-store-events.js";
import type { StoredTask } from "../services/task-store.types.js";
import { taskStore } from "../services/task-store.service.js";

function baseOpenTask(overrides: Partial<StoredTask> = {}): StoredTask {
  return {
    id: "os-a.1",
    title: "Task",
    issue_type: "task",
    status: "open",
    priority: 2,
    labels: ["merge_stage:quality_gate"],
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("getAuthoritativeMergeWsFields", () => {
  it("returns blocked_on_baseline and mergeWaitingOnMain when baseline pause is active", () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const task = baseOpenTask({
      merge_quality_gate_paused_until: until,
    });
    expect(getAuthoritativeMergeWsFields(task)).toEqual({
      mergePausedUntil: until,
      mergeWaitingOnMain: true,
      mergeGateState: "blocked_on_baseline",
    });
  });

  it("returns null mergeGateState and false mergeWaitingOnMain when baseline pause clears", () => {
    const task = baseOpenTask({
      merge_quality_gate_paused_until: "2020-01-01T00:00:00Z",
    });
    expect(getAuthoritativeMergeWsFields(task)).toEqual({
      mergePausedUntil: null,
      mergeWaitingOnMain: false,
      mergeGateState: "validating",
    });
  });

  it("returns null merge fields when task is not in a merge stage", () => {
    const task = baseOpenTask({ labels: [] });
    expect(getAuthoritativeMergeWsFields(task)).toEqual({
      mergePausedUntil: null,
      mergeWaitingOnMain: false,
      mergeGateState: null,
    });
  });

  it("returns merging state for merge_to_main stage", () => {
    const task = baseOpenTask({ labels: ["merge_stage:merge_to_main"] });
    const result = getAuthoritativeMergeWsFields(task);
    expect(result.mergeGateState).toBe("merging");
    expect(result.mergePausedUntil).toBeNull();
    expect(result.mergeWaitingOnMain).toBe(false);
  });

  it("returns merging state for rebase_before_merge stage", () => {
    const task = baseOpenTask({ labels: ["merge_stage:rebase_before_merge"] });
    const result = getAuthoritativeMergeWsFields(task);
    expect(result.mergeGateState).toBe("merging");
    expect(result.mergePausedUntil).toBeNull();
    expect(result.mergeWaitingOnMain).toBe(false);
  });
});

describe("buildTaskUpdatedServerEvent", () => {
  it("includes authoritative merge fields and kanban waiting_to_merge for quality_gate stage", () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const task = baseOpenTask({
      merge_quality_gate_paused_until: until,
      assignee: "coder-1",
    });
    const ev = buildTaskUpdatedServerEvent(task) as TaskUpdatedEvent;
    expect(ev.type).toBe("task.updated");
    expect(ev.taskId).toBe("os-a.1");
    expect(ev.kanbanColumn).toBe("waiting_to_merge");
    expect(ev.mergePausedUntil).toBe(until);
    expect(ev.mergeGateState).toBe("blocked_on_baseline");
    expect(ev.mergeWaitingOnMain).toBe(true);
  });

  it("sets kanbanColumn to waiting_to_merge for merge_to_main stage", () => {
    const task = baseOpenTask({ labels: ["merge_stage:merge_to_main"] });
    const ev = buildTaskUpdatedServerEvent(task) as TaskUpdatedEvent;
    expect(ev.kanbanColumn).toBe("waiting_to_merge");
    expect(ev.mergeGateState).toBe("merging");
  });

  it("sets kanbanColumn to waiting_to_merge for rebase_before_merge stage", () => {
    const task = baseOpenTask({ labels: ["merge_stage:rebase_before_merge"] });
    const ev = buildTaskUpdatedServerEvent(task) as TaskUpdatedEvent;
    expect(ev.kanbanColumn).toBe("waiting_to_merge");
    expect(ev.mergeGateState).toBe("merging");
  });

  it("uses mapStatusToKanban when no merge stage is set", () => {
    const task = baseOpenTask({ labels: [], status: "open" });
    const ev = buildTaskUpdatedServerEvent(task) as TaskUpdatedEvent;
    expect(ev.kanbanColumn).not.toBe("waiting_to_merge");
    expect(ev.mergePausedUntil).toBeNull();
    expect(ev.mergeWaitingOnMain).toBe(false);
    expect(ev.mergeGateState).toBeNull();
  });

  it("includes title, description, blockReason from stored task", () => {
    const task = baseOpenTask({
      labels: [],
      title: "My Title",
      description: "My Desc",
      block_reason: "Merge Failure",
    });
    const ev = buildTaskUpdatedServerEvent(task) as TaskUpdatedEvent;
    expect(ev.title).toBe("My Title");
    expect(ev.description).toBe("My Desc");
    expect(ev.blockReason).toBe("Merge Failure");
  });
});

describe("wireTaskStoreEvents", () => {
  let broadcast: ReturnType<typeof vi.fn>;
  let capturedCallback: ((projectId: string, changeType: string, task: StoredTask) => void) | null;

  beforeEach(() => {
    broadcast = vi.fn();
    capturedCallback = null;
    vi.spyOn(taskStore, "setOnTaskChange").mockImplementation((cb) => {
      capturedCallback = cb as typeof capturedCallback;
    });
    wireTaskStoreEvents(broadcast as BroadcastFn);
  });

  it("emits task.created with kanbanColumn and merge fields", () => {
    const task = baseOpenTask({
      labels: ["merge_stage:quality_gate"],
      dependencies: [{ depends_on_id: "os-parent", type: "parent-child" }],
    });
    capturedCallback!("proj-1", "create", task);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const [projectId, event] = broadcast.mock.calls[0];
    expect(projectId).toBe("proj-1");
    const created = event as TaskCreatedEvent;
    expect(created.type).toBe("task.created");
    expect(created.taskId).toBe("os-a.1");
    expect(created.task.kanbanColumn).toBe("waiting_to_merge");
    expect(created.task.mergePausedUntil).toBeNull();
    expect(created.task.mergeWaitingOnMain).toBe(false);
    expect(created.task.parentId).toBe("os-parent");
  });

  it("emits task.created without waiting_to_merge when no merge stage", () => {
    const task = baseOpenTask({ labels: [] });
    capturedCallback!("proj-1", "create", task);
    const created = broadcast.mock.calls[0][1] as TaskCreatedEvent;
    expect(created.task.kanbanColumn).not.toBe("waiting_to_merge");
  });

  it("emits task.updated with kanbanColumn and merge fields via buildTaskUpdatedServerEvent", () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const task = baseOpenTask({ merge_quality_gate_paused_until: until });
    capturedCallback!("proj-1", "update", task);
    expect(broadcast).toHaveBeenCalledTimes(1);
    const updated = broadcast.mock.calls[0][1] as TaskUpdatedEvent;
    expect(updated.type).toBe("task.updated");
    expect(updated.kanbanColumn).toBe("waiting_to_merge");
    expect(updated.mergePausedUntil).toBe(until);
    expect(updated.mergeWaitingOnMain).toBe(true);
    expect(updated.mergeGateState).toBe("blocked_on_baseline");
  });

  it("emits task.closed with kanbanColumn and merge fields", () => {
    const task = baseOpenTask({
      status: "closed",
      close_reason: "completed",
      labels: [],
    });
    capturedCallback!("proj-1", "close", task);
    const closed = broadcast.mock.calls[0][1] as TaskClosedEvent;
    expect(closed.type).toBe("task.closed");
    expect(closed.taskId).toBe("os-a.1");
    expect(closed.task.kanbanColumn).toBeDefined();
    expect(closed.task.close_reason).toBe("completed");
    expect(closed.task.mergePausedUntil).toBeNull();
    expect(closed.task.mergeWaitingOnMain).toBe(false);
  });

  it("emits task.created with source from extra when present", () => {
    const task = baseOpenTask({ labels: [], source: "self-improvement" } as Partial<StoredTask>);
    capturedCallback!("proj-1", "create", task);
    const created = broadcast.mock.calls[0][1] as TaskCreatedEvent;
    expect(created.task.source).toBe("self-improvement");
  });
});
