import { describe, it, expect } from "vitest";
import { getAuthoritativeMergeWsFields, buildTaskUpdatedServerEvent } from "../task-store-events.js";
import type { StoredTask } from "../services/task-store.types.js";

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
});

describe("buildTaskUpdatedServerEvent", () => {
  it("includes authoritative merge fields and kanban waiting_to_merge for quality_gate stage", () => {
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const task = baseOpenTask({
      merge_quality_gate_paused_until: until,
      assignee: "coder-1",
    });
    const ev = buildTaskUpdatedServerEvent(task);
    expect(ev.type).toBe("task.updated");
    expect(ev.taskId).toBe("os-a.1");
    expect(ev.kanbanColumn).toBe("waiting_to_merge");
    expect(ev.mergePausedUntil).toBe(until);
    expect(ev.mergeGateState).toBe("blocked_on_baseline");
    expect(ev.mergeWaitingOnMain).toBe(true);
  });
});
