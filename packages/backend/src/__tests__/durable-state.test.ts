import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { initAppDb, type AppDb } from "../db/app-db.js";
import { TaskStoreService } from "../services/task-store.service.js";
import { OperationService } from "../services/operation.service.js";
import { ConversationStore } from "../services/conversation-store.service.js";
import { CollaborationService } from "../services/collaboration.service.js";
import { appendProjectEvent, lockProject } from "../services/project-event.service.js";

describe("durable semantic state", () => {
  let directory: string;
  let db: AppDb;
  let tasks: TaskStoreService;
  let operations: OperationService;
  const open = async () => {
    db = await initAppDb(`sqlite://${path.join(directory, "test.sqlite").replace(/\\/g, "/")}`);
    tasks = new TaskStoreService();
    await tasks.init(undefined, db);
    operations = new OperationService(tasks);
  };
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "durable-state-"));
    await open();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("allows one simultaneous stale task edit, returns current state, and deduplicates its retry after restart", async () => {
    const task = await tasks.create("p", "Original");
    const command = { actorId: "alice", requestId: "edit-1", expectedRevision: 1 };
    const results = await Promise.allSettled([
      tasks.updateCollaboratively("p", task.id, { title: "Alice" }, command),
      tasks.updateCollaboratively(
        "p",
        task.id,
        { title: "Bob" },
        { ...command, actorId: "bob", requestId: "edit-2" }
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === "rejected"
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({
      statusCode: 409,
      details: { revision: 2, state: { title: "Alice" } },
    });
    await db.close();
    await open();
    expect(
      await tasks.updateCollaboratively("p", task.id, { title: "Alice" }, command)
    ).toMatchObject({ title: "Alice", revision: 2 });
    await expect(
      tasks.updateCollaboratively("p", task.id, { title: "Changed retry" }, command)
    ).rejects.toMatchObject({ statusCode: 409 });
    const replay = await new CollaborationService(tasks).replay("p");
    expect(replay.events.map((event) => event.type)).toEqual(["task_changed", "task_changed"]);
    expect(replay.events.map((event) => event.cursor)).toEqual([1, 2]);
  });

  it("rolls back the semantic event and version when the resource mutation rolls back", async () => {
    const task = await tasks.create("p", "Original");
    const changed = vi.fn();
    tasks.setOnTaskChange(changed);
    await expect(
      tasks.runWrite(async () => {
        await tasks.update("p", task.id, { title: "Rolled back" });
        throw new Error("interrupt");
      })
    ).rejects.toThrow("interrupt");
    expect(await tasks.show("p", task.id)).toMatchObject({ title: "Original", revision: 1 });
    expect(changed).not.toHaveBeenCalled();
    expect((await new CollaborationService(tasks).replay("p")).events).toHaveLength(1);
  });

  it.each(["runWrite", "runRead"] as const)(
    "does not reuse a completed %s transaction in a delayed callback",
    async (method) => {
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      let delayed!: Promise<void>;
      const changed = vi.fn();
      tasks.setOnTaskChange(changed);
      await tasks[method](async () => {
        delayed = ready.then(async () => {
          await expect(
            tasks.runWrite(async () => {
              await tasks.create("p", "Must roll back");
              throw new Error("late failure");
            })
          ).rejects.toThrow("late failure");
          await tasks.create("p", "Committed after callback");
        });
      });
      release();
      await delayed;
      expect((await tasks.listAll("p")).map((task) => task.title)).toEqual([
        "Committed after callback",
      ]);
      expect(changed).toHaveBeenCalledOnce();
      expect((await new CollaborationService(tasks).replay("p")).events).toHaveLength(1);
    }
  );

  it("orders task, dependency, plan and operation events in one project stream", async () => {
    const a = await tasks.create("p", "A");
    const b = await tasks.create("p", "B");
    await tasks.addDependency("p", a.id, b.id);
    await tasks.planInsert("p", "plan", { epic_id: a.id, content: "# Plan" });
    await tasks.planUpdateContent("p", "plan", "# Edited");
    const operation = await operations.accept({
      projectId: "p",
      actorId: "alice",
      requestId: "run",
      kind: "plan",
      target: "plan",
      payload: {},
    });
    expect((await tasks.planGet("p", "plan"))?.revision).toBe(2);
    expect(operation.status).toBe("queued");
    const replay = await new CollaborationService(tasks).replay("p");
    expect(replay.events.map((event) => event.type)).toEqual([
      "task_changed",
      "task_changed",
      "task_changed",
      "plan_changed",
      "plan_changed",
      "operation_changed",
    ]);
    expect(replay.events.map((event) => event.cursor)).toEqual([1, 2, 3, 4, 5, 6]);
    await expect(tasks.addDependency("foreign", a.id, b.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("deduplicates immutable operations and permits exactly one worker claim", async () => {
    const input = {
      projectId: "p",
      actorId: "alice",
      requestId: "request",
      kind: "deploy",
      target: "main",
      expectedRevision: 4,
      payload: { b: 2, a: 1 },
    };
    const accepted = await Promise.all([
      operations.accept(input),
      operations.accept({ ...input, payload: { a: 1, b: 2 } }),
    ]);
    expect(accepted[0].id).toBe(accepted[1].id);
    await expect(operations.accept({ ...input, actorId: "bob" })).rejects.toMatchObject({
      statusCode: 409,
    });
    const claims = await Promise.all([
      operations.claim("p", accepted[0].id, "worker-a"),
      operations.claim("p", accepted[0].id, "worker-b"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    await expect(
      operations.complete("p", claim.id, "worker-b", claim.generation, {})
    ).rejects.toMatchObject({ code: "OPERATION_FENCE_LOST" });
    await operations.complete("p", claim.id, "worker-a", claim.generation, { deploymentId: "d" });
    await db.close();
    await open();
    expect(await operations.get("p", claim.id)).toMatchObject({
      status: "completed",
      result: { deploymentId: "d" },
    });
  });

  it("recovers expired owners as uncertain and prevents a delayed completion", async () => {
    const op = await operations.accept({
      projectId: "p",
      actorId: "alice",
      requestId: "request",
      kind: "deploy",
      target: "main",
      payload: {},
    });
    const claim = (await operations.claim("p", op.id, "old-worker"))!;
    await tasks.runWrite((tx) =>
      tx.execute("UPDATE operation_owners SET expires_at = $1 WHERE owner_id = $2", [
        "2000-01-01T00:00:00.000Z",
        "old-worker",
      ])
    );
    expect(await operations.recoverExpired()).toBe(1);
    expect(await operations.get("p", op.id)).toMatchObject({
      status: "uncertain",
      generation: claim.generation + 1,
    });
    await expect(
      operations.complete("p", op.id, "old-worker", claim.generation, {})
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(operations.heartbeatOwner("old-worker")).rejects.toMatchObject({
      code: "OPERATION_OWNER_EXPIRED",
    });
    expect(await operations.claim("p", op.id, "new-worker")).toBeNull();
  });

  it("imports legacy messages once and preserves concurrent individually identified appends", async () => {
    await tasks.runWrite((tx) =>
      tx.execute(
        "INSERT INTO project_conversations (project_id, context, conversation_id, messages, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)",
        [
          "p",
          "sketch",
          "conversation",
          JSON.stringify([{ role: "user", content: "Legacy", timestamp: "2025-01-01T00:00:00Z" }]),
          "2025-01-01T00:00:00Z",
        ]
      )
    );
    const conversations = new ConversationStore(tasks);
    const snapshot = (await conversations.read("p", "sketch"))!;
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        conversations.append("p", snapshot, [
          {
            id: `message-${i}`,
            role: "user",
            content: `Append ${i}`,
            timestamp: new Date().toISOString(),
          },
        ])
      )
    );
    const history = (await conversations.read("p", "sketch"))!;
    expect(history.messages).toHaveLength(9);
    expect(new Set(history.messages.map((message) => message.id)).size).toBe(9);
    expect((await conversations.read("p", "sketch"))!.messages).toEqual(history.messages);
    await expect(
      conversations.append("p", snapshot, [
        { ...history.messages[1], content: "Changed immutable message" },
      ])
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("deletes normalized messages with their conversation and starts a fresh history", async () => {
    const conversations = new ConversationStore(tasks);
    const conversation = { id: "conversation-1", context: "sketch" as const, messages: [] };
    await conversations.append("p", conversation, [
      { id: "old-message", role: "user", content: "Old", timestamp: "2025-01-01T00:00:00Z" },
    ]);
    await tasks.runWrite((tx) =>
      tx.execute("DELETE FROM project_conversations WHERE project_id = $1 AND context = $2", [
        "p",
        "sketch",
      ])
    );
    expect(
      await tasks.runRead((tx) =>
        tx.query("SELECT id FROM conversation_messages WHERE project_id = $1", ["p"])
      )
    ).toEqual([]);
    expect(await conversations.read("p", "sketch")).toBeNull();
    await conversations.append("p", { ...conversation, id: "conversation-2" }, [
      { id: "new-message", role: "user", content: "New", timestamp: "2025-01-02T00:00:00Z" },
    ]);
    expect(
      (await conversations.read("p", "sketch"))!.messages.map((message) => message.content)
    ).toEqual(["New"]);
  });

  it("requires a new snapshot when a replay cursor predates retention", async () => {
    await tasks.runWrite(async (tx) => {
      await lockProject(tx, "p");
      for (let i = 0; i < 5; i++)
        await appendProjectEvent(tx, { projectId: "p", type: "example", payload: i }, 2);
    });
    const replay = new CollaborationService(tasks);
    await expect(replay.replay("p", 1)).rejects.toMatchObject({
      statusCode: 409,
      details: { resetRequired: true, cursor: 5 },
    });
    expect((await replay.replay("p", 3)).events.map((event) => event.cursor)).toEqual([4, 5]);
  });
});
