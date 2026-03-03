import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { EventLogService, type OrchestratorEvent } from "../services/event-log.service.js";
import type { DbClient } from "../db/client.js";

const { testClientRef } = vi.hoisted(() => ({
  testClientRef: { current: null as DbClient | null },
}));
vi.mock("../services/task-store.service.js", async () => {
  const { createTestPostgresClient } = await import("./test-db-helper.js");
  const dbResult = await createTestPostgresClient();
  testClientRef.current = dbResult?.client ?? null;
  return {
    taskStore: {
      init: vi.fn().mockImplementation(async () => {}),
      getDb: vi.fn().mockImplementation(async () => testClientRef.current),
      runWrite: vi
        .fn()
        .mockImplementation(async (fn: (client: DbClient) => Promise<unknown>) =>
          fn(testClientRef.current!)
        ),
    },
    TaskStoreService: vi.fn(),
    SCHEMA_SQL: "",
    _postgresAvailable: !!dbResult,
  };
});

const eventLogTaskStoreMod = await import("../services/task-store.service.js");
const eventLogPostgresOk =
  (eventLogTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

describe.skipIf(!eventLogPostgresOk)("EventLogService", () => {
  let tmpDir: string;
  let service: EventLogService;

  beforeEach(async () => {
    if (!testClientRef.current) throw new Error("Postgres required");
    tmpDir = path.join(os.tmpdir(), `event-log-test-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    const { taskStore } = await import("../services/task-store.service.js");
    await taskStore.init();
    service = new EventLogService();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeEvent(overrides: Partial<OrchestratorEvent> = {}): OrchestratorEvent {
    return {
      timestamp: new Date().toISOString(),
      projectId: "proj-1",
      taskId: "task-1",
      event: "transition.start_task",
      ...overrides,
    };
  }

  it("should append events to DB", async () => {
    await service.append(tmpDir, makeEvent({ event: "transition.start_task" }));
    await service.append(tmpDir, makeEvent({ event: "transition.complete" }));

    const recent = await service.readRecent(tmpDir, 10);
    expect(recent).toHaveLength(2);
    expect(recent[0].event).toBe("transition.start_task");
    expect(recent[1].event).toBe("transition.complete");
  });

  it("should read events since a given timestamp", async () => {
    const t1 = "2025-01-01T00:00:00.000Z";
    const t2 = "2025-06-01T00:00:00.000Z";
    const t3 = "2025-12-01T00:00:00.000Z";

    await service.append(tmpDir, makeEvent({ timestamp: t1, event: "old" }));
    await service.append(tmpDir, makeEvent({ timestamp: t2, event: "mid" }));
    await service.append(tmpDir, makeEvent({ timestamp: t3, event: "new" }));

    const since = await service.readSince(tmpDir, "2025-05-01T00:00:00.000Z");
    expect(since).toHaveLength(2);
    expect(since[0].event).toBe("mid");
    expect(since[1].event).toBe("new");
  });

  it("should filter events by taskId", async () => {
    await service.append(tmpDir, makeEvent({ taskId: "task-A", event: "a1" }));
    await service.append(tmpDir, makeEvent({ taskId: "task-B", event: "b1" }));
    await service.append(tmpDir, makeEvent({ taskId: "task-A", event: "a2" }));

    const forA = await service.readForTask(tmpDir, "task-A");
    expect(forA).toHaveLength(2);
    expect(forA.map((e) => e.event)).toEqual(["a1", "a2"]);
  });

  it("should read recent N events", async () => {
    for (let i = 0; i < 10; i++) {
      await service.append(tmpDir, makeEvent({ event: `e${i}` }));
    }

    const recent = await service.readRecent(tmpDir, 3);
    expect(recent).toHaveLength(3);
    expect(recent.map((e) => e.event)).toEqual(["e7", "e8", "e9"]);
  });

  it("should return empty array when no events in DB", async () => {
    const events = await service.readSince(tmpDir, "2020-01-01T00:00:00.000Z");
    expect(events).toEqual([]);
  });

  it("should include optional data in events", async () => {
    await service.append(
      tmpDir,
      makeEvent({ event: "task.failed", data: { failureType: "timeout", attempt: 3 } })
    );

    const events = await service.readForTask(tmpDir, "task-1");
    expect(events[0].data).toEqual({ failureType: "timeout", attempt: 3 });
  });
});
