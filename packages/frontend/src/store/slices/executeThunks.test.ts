import { describe, it, expect } from "vitest";
import type { TaskEventPayload } from "@opensprint/shared";
import { taskEventPayloadToTask } from "./executeThunks";

function basePayload(overrides: Partial<TaskEventPayload> = {}): TaskEventPayload {
  return {
    id: "os-t.1",
    title: "Test Task",
    issue_type: "task",
    status: "open",
    priority: 2,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("taskEventPayloadToTask", () => {
  it("uses server-provided kanbanColumn when valid", () => {
    const task = taskEventPayloadToTask(
      basePayload({ kanbanColumn: "waiting_to_merge" })
    );
    expect(task.kanbanColumn).toBe("waiting_to_merge");
  });

  it("falls back to mapStatusToKanban when kanbanColumn is absent", () => {
    const task = taskEventPayloadToTask(basePayload());
    expect(task.kanbanColumn).toBe("backlog");
  });

  it("falls back to mapStatusToKanban when kanbanColumn is invalid", () => {
    const task = taskEventPayloadToTask(
      basePayload({ kanbanColumn: "nonsense" as never })
    );
    expect(task.kanbanColumn).toBe("backlog");
  });

  it("passes through mergePausedUntil when present", () => {
    const until = "2025-06-15T12:00:00Z";
    const task = taskEventPayloadToTask(
      basePayload({ mergePausedUntil: until })
    );
    expect(task.mergePausedUntil).toBe(until);
  });

  it("passes through mergeWaitingOnMain when present", () => {
    const task = taskEventPayloadToTask(
      basePayload({ mergeWaitingOnMain: true })
    );
    expect(task.mergeWaitingOnMain).toBe(true);
  });

  it("passes through mergeGateState when present", () => {
    const task = taskEventPayloadToTask(
      basePayload({ mergeGateState: "blocked_on_baseline" })
    );
    expect(task.mergeGateState).toBe("blocked_on_baseline");
  });

  it("deletes mergeGateState when null", () => {
    const task = taskEventPayloadToTask(
      basePayload({ mergeGateState: null })
    );
    expect(task.mergeGateState).toBeUndefined();
  });

  it("sets epicId from parentId for non-epic tasks", () => {
    const task = taskEventPayloadToTask(
      basePayload({ parentId: "os-epic" })
    );
    expect(task.epicId).toBe("os-epic");
  });

  it("sets epicId to null for epic tasks", () => {
    const task = taskEventPayloadToTask(
      basePayload({ issue_type: "epic", parentId: "os-parent" })
    );
    expect(task.epicId).toBeNull();
  });

  it("sets completedAt from updated_at when status is closed", () => {
    const task = taskEventPayloadToTask(
      basePayload({ status: "closed", updated_at: "2025-02-01T00:00:00Z" })
    );
    expect(task.completedAt).toBe("2025-02-01T00:00:00Z");
  });

  it("sets completedAt to null when status is not closed", () => {
    const task = taskEventPayloadToTask(basePayload({ status: "open" }));
    expect(task.completedAt).toBeNull();
  });

  it("passes through source when present", () => {
    const task = taskEventPayloadToTask(
      basePayload({ source: "self-improvement" })
    );
    expect(task.source).toBe("self-improvement");
  });

  it("handles all kanban columns correctly", () => {
    const columns = [
      "planning",
      "backlog",
      "ready",
      "in_progress",
      "in_review",
      "done",
      "blocked",
      "waiting_to_merge",
    ] as const;
    for (const col of columns) {
      const task = taskEventPayloadToTask(basePayload({ kanbanColumn: col }));
      expect(task.kanbanColumn).toBe(col);
    }
  });

  it("includes merge fields together with waiting_to_merge kanbanColumn", () => {
    const task = taskEventPayloadToTask(
      basePayload({
        kanbanColumn: "waiting_to_merge",
        mergePausedUntil: "2025-06-15T12:00:00Z",
        mergeWaitingOnMain: true,
        mergeGateState: "blocked_on_baseline",
      })
    );
    expect(task.kanbanColumn).toBe("waiting_to_merge");
    expect(task.mergePausedUntil).toBe("2025-06-15T12:00:00Z");
    expect(task.mergeWaitingOnMain).toBe(true);
    expect(task.mergeGateState).toBe("blocked_on_baseline");
  });
});
