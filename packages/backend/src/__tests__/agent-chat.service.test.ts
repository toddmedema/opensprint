import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { initAppDb, type AppDb } from "../db/app-db.js";
import type { DbClient } from "../db/client.js";
import { AgentChatService } from "../services/agent-chat.service.js";
import { ActiveAgentsService } from "../services/active-agents.service.js";
import { PendingMessageQueue, runAgenticLoop } from "../services/agentic-loop.js";
import { TaskStoreService } from "../services/task-store.service.js";

describe("durable correlated Execute guidance", () => {
  let directory: string;
  let db: AppDb;
  let registry: ActiveAgentsService;
  let service: AgentChatService;
  let queue: PendingMessageQueue;
  const store = () => ({
    runWrite: <T>(fn: (tx: DbClient) => Promise<T>) => db.runWrite(fn),
    runRead: <T>(fn: (tx: DbClient) => Promise<T>) => db.runRead!(fn),
  });
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "guidance-sql-"));
    db = await initAppDb(`sqlite://${path.join(directory, "test.sqlite").replace(/\\/g, "/")}`);
    registry = new ActiveAgentsService();
    service = new AgentChatService(registry, directory, store());
    queue = new PendingMessageQueue(2);
    registry.registerChannel("task", queue, "openai", {
      projectId: "project",
      attempt: 3,
      attemptId: "run-3",
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await service.flush();
    await db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const options = { clientMessageId: "client-1", actorId: "alice" };

  it("persists a queued receipt before making guidance available and then records inclusion", async () => {
    const sent = await service.sendMessage("project", "task", "Fix tests", undefined, options);
    expect(sent).toMatchObject({
      status: "queued",
      clientMessageId: "client-1",
      attemptId: "run-3",
    });
    expect((await service.getHistory("project", "task"))[0]).toMatchObject({
      status: "queued",
      sequence: 1,
      attempt: 3,
      actorId: "alice",
    });
    expect(queue.drain()[0]).toMatchObject({ messageId: sent.messageId, message: "Fix tests" });
    expect((await service.getHistory("project", "task"))[0]).toMatchObject({
      status: "included",
      sequence: 1,
    });
  });
  it("persists server acceptance order when timestamps tie and UUID order differs across restart", async () => {
    for (const [id, content] of [
      ["z-first", "First"],
      ["a-second", "Second"],
      ["m-third", "Third"],
    ])
      await service.appendMessage("task", {
        id,
        content,
        role: "assistant",
        timestamp: "2026-10-20T00:00:00.000Z",
        attempt: 3,
        projectId: "project",
        taskId: "task",
        attemptId: "run-3",
        sequence: 999,
      });
    const restarted = new AgentChatService(registry, directory, store());
    const history = await restarted.getHistory("project", "task");
    expect(history.map((message) => message.content)).toEqual(["First", "Second", "Third"]);
    expect(history.map((message) => message.sequence)).toEqual([1, 2, 3]);
  });

  it("scopes active channels and durable history by project", async () => {
    await service.sendMessage("project", "task", "A", undefined, options);
    expect(await service.getHistory("other", "task")).toEqual([]);
    expect((await service.sendMessage("other", "task", "B")).delivered).toBe(false);
    expect(service.getActiveRun("other", "task")).toBeNull();
    expect(queue.size).toBe(1);
  });
  it("deduplicates simultaneous retries and rejects immutable request ID reuse", async () => {
    const sent = await Promise.all([
      service.sendMessage("project", "task", "A", undefined, options),
      service.sendMessage("project", "task", "A", undefined, options),
    ]);
    expect(sent[0].messageId).toBe(sent[1].messageId);
    expect(queue.size).toBe(1);
    await service.sendMessage("project", "task", "A", undefined, { ...options, actorId: "bob" });
    expect(queue.size).toBe(2);
    await expect(
      service.sendMessage("project", "task", "changed", undefined, options)
    ).rejects.toMatchObject({ statusCode: 409 });
  });
  it("records capacity failure without claiming inclusion", async () => {
    queue.push("one");
    queue.push("two");
    expect(
      await service.sendMessage("project", "task", "overflow", undefined, options)
    ).toMatchObject({ delivered: false, status: "failed" });
    expect((await service.getHistory("project", "task"))[0].status).toBe("failed");
  });
  it("never enqueues when SQL acceptance fails", async () => {
    vi.spyOn(service, "appendMessage").mockRejectedValue(new Error("database full"));
    await expect(service.sendMessage("project", "task", "A", undefined, options)).rejects.toThrow(
      "database full"
    );
    expect(queue.size).toBe(0);
  });

  it("does not expose guidance to the model before an outer control transaction commits", async () => {
    const tasks = new TaskStoreService();
    await tasks.init(undefined, db);
    const controlled = new AgentChatService(registry, directory, tasks);
    await expect(
      tasks.runWrite(async () => {
        await controlled.sendMessage("project", "task", "Rolled back", undefined, options);
        expect(queue.size).toBe(0);
        throw new Error("control transaction failed");
      })
    ).rejects.toThrow("control transaction failed");
    expect(queue.size).toBe(0);
    expect(await controlled.getHistory("project", "task")).toEqual([]);
    await tasks.runWrite(async () => {
      await controlled.sendMessage("project", "task", "Committed", undefined, options);
      expect(queue.size).toBe(0);
    });
    expect(queue.size).toBe(1);
  });
  it("retains stopped-run receipts across database restart without replaying guidance", async () => {
    await service.sendMessage("project", "task", "A", undefined, options);
    await db.close();
    db = await initAppDb(`sqlite://${path.join(directory, "test.sqlite").replace(/\\/g, "/")}`);
    const restarted = new AgentChatService(new ActiveAgentsService(), directory, store());
    expect((await restarted.getHistory("project", "task"))[0]).toMatchObject({
      status: "queued",
      attemptId: "run-3",
    });
    expect((await restarted.getHistory("project", "task"))[0].error).toMatch(
      /ownership is uncertain/
    );
    registry.unregister("task");
    await service.flush();
    expect(queue.push("late")).toBe(false);
  });

  it("does not end guidance when another replica reads a live owned attempt", async () => {
    await service.sendMessage("project", "task", "A", undefined, options);
    await db.runWrite((tx) =>
      tx.execute(
        "INSERT INTO execution_leases (project_id, run_key, task_id, attempt_id, owner_id, generation, expires_ms, state, updated_at) VALUES ($1,$2,$3,$4,$5,1,$6,'running',$7)",
        [
          "project",
          "task",
          "task",
          "run-3",
          "other-worker",
          Date.now() + 60_000,
          new Date().toISOString(),
        ]
      )
    );
    const observer = new AgentChatService(new ActiveAgentsService(), directory, store());
    expect((await observer.getHistory("project", "task"))[0]).toMatchObject({ status: "queued" });
    expect((await service.getHistory("project", "task"))[0].status).toBe("queued");
    expect(queue.size).toBe(1);
    await db.runWrite((tx) =>
      tx.execute("UPDATE execution_leases SET state = 'stopped' WHERE project_id = 'project'")
    );
    expect((await observer.getHistory("project", "task"))[0].status).toBe("run-ended");
  });
  it("never drains guidance after the last allowed model turn", async () => {
    await service.sendMessage("project", "task", "A", undefined, options);
    const adapter = {
      send: vi
        .fn()
        .mockResolvedValue({ text: "", toolCalls: [{ id: "noop", name: "unknown", args: {} }] }),
    };
    await runAgenticLoop(adapter, "task", { cwd: directory, maxTurns: 1, pendingMessages: queue });
    expect(adapter.send).toHaveBeenCalledOnce();
    expect((await service.getHistory("project", "task"))[0].status).toBe("run-ended");
  });
  it("marks only messages submitted in a subsequent model request included", async () => {
    await service.sendMessage("project", "task", "A", undefined, options);
    const adapter = {
      send: vi
        .fn()
        .mockResolvedValueOnce({ text: "", toolCalls: [{ id: "noop", name: "unknown", args: {} }] })
        .mockImplementationOnce(async (content: string) => {
          expect(content).toBe("A");
          expect((await service.getHistory("project", "task"))[0].status).toBe("included");
          await service.sendMessage("project", "task", "late", undefined, {
            clientMessageId: "late",
          });
          return { text: "done", toolCalls: [] };
        }),
    };
    await runAgenticLoop(adapter, "task", { cwd: directory, maxTurns: 2, pendingMessages: queue });
    expect((await service.getHistory("project", "task")).map((m) => m.status)).toEqual([
      "included",
      "run-ended",
    ]);
  });
  it("closes queued guidance when the provider throws", async () => {
    await service.sendMessage("project", "task", "A", undefined, options);
    await expect(
      runAgenticLoop({ send: vi.fn().mockRejectedValue(new Error("offline")) }, "task", {
        cwd: directory,
        pendingMessages: queue,
      })
    ).rejects.toThrow("offline");
    expect((await service.getHistory("project", "task"))[0].status).toBe("run-ended");
  });
  it.each(["claude-cli", "cursor", "custom"])("rejects CLI backend %s", async (backend) => {
    registry.registerChannel("task", new PendingMessageQueue(), backend, { projectId: "project" });
    expect((await service.sendMessage("project", "task", "A")).error).toMatch(/CLI-based/);
  });
});
