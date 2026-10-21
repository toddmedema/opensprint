import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { initAppDb, type AppDb } from "../db/app-db.js";
import { TaskStoreService } from "../services/task-store.service.js";
const state = vi.hoisted(() => ({ store: null as TaskStoreService | null }));
vi.mock("../services/task-store.service.js", async (original) => {
  const actual = await original<typeof import("../services/task-store.service.js")>();
  return {
    ...actual,
    taskStore: {
      getDb: () => state.store!.getDb(),
      runRead: <T>(fn: Parameters<TaskStoreService["runRead"]>[0]) =>
        state.store!.runRead(fn) as Promise<T>,
      runWrite: <T>(fn: Parameters<TaskStoreService["runWrite"]>[0]) =>
        state.store!.runWrite(fn) as Promise<T>,
      show: (...args: Parameters<TaskStoreService["show"]>) => state.store!.show(...args),
    },
  };
});
import { runDurableTaskControl } from "../services/durable-task-control.service.js";
import { operationService } from "../services/operation.service.js";
import { runWithRequestContext } from "../services/request-context.js";
import { localIdentity } from "../services/identity.service.js";
import { withOperationEffect } from "../services/operation-effect-context.js";
import { operationWorker } from "../services/operation-worker.service.js";
import { TaskService } from "../services/task.service.js";
import { createTasksRouter } from "../routes/tasks.js";
import { errorHandler } from "../middleware/error-handler.js";
import express from "express";
import supertest from "supertest";
import {
  ExecutionOwnershipService,
  executionOwnershipService,
} from "../services/execution-ownership.service.js";
import { OrchestratorService } from "../services/orchestrator.service.js";

vi.mock("../utils/git-repo-state.js", async (original) => ({
  ...(await original<typeof import("../utils/git-repo-state.js")>()),
  resolveBaseBranch: vi.fn().mockResolvedValue("main"),
}));

describe("durable task control admission", () => {
  let db: AppDb, observer: AppDb, directory: string, taskId: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "durable-task-control-"));
    const url = `sqlite://${path.join(directory, "control.sqlite").replace(/\\/g, "/")}`;
    db = await initAppDb(url);
    observer = await initAppDb(url);
    state.store = new TaskStoreService(await db.getClient());
    await state.store.init();
    const ownership = new ExecutionOwnershipService(state.store);
    vi.spyOn(executionOwnershipService, "observe").mockImplementation(
      ownership.observe.bind(ownership)
    );
    vi.spyOn(executionOwnershipService, "requestStop").mockImplementation(
      ownership.requestStop.bind(ownership)
    );
    taskId = (await state.store.create("project", "Original")).id;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await observer?.close();
    await db?.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const request = <T>(requestId: string, work: () => Promise<T>) =>
    runWithRequestContext(
      { projectId: "project", principal: localIdentity(), requestId, expectedRevision: 1 },
      work
    );
  it("commits its actor/revision-bound receipt before effects and replays a completed request once", async () => {
    const effect = vi.fn(async () => {
      const receipt = await (
        await observer.getClient()
      ).queryOne("SELECT * FROM durable_operations WHERE project_id=$1", ["project"]);
      expect(receipt).toMatchObject({
        status: "running",
        actor_id: "local-user",
        expected_revision: 1,
      });
      await state.store!.close("project", taskId, "Manually done");
      return { taskClosed: true };
    });
    const perform = () => runDurableTaskControl("project", taskId, "done", {}, effect);
    expect(await request("done-once", perform)).toEqual({ taskClosed: true });
    expect(await request("done-once", perform)).toEqual({ taskClosed: true });
    expect(effect).toHaveBeenCalledTimes(1);
  });
  it("rejects stale admission without stopping a process or leaving a queued control", async () => {
    await state.store!.update("project", taskId, { title: "Newer" });
    const effect = vi.fn();
    await expect(
      request("stale-done", () => runDurableTaskControl("project", taskId, "done", {}, effect))
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(effect).not.toHaveBeenCalled();
    expect(await operationService.getByRequestId("project", "stale-done")).toBeNull();
  });
  it("never repeats an interrupted control effect on retry", async () => {
    const effect = vi.fn(async () => {
      throw new Error("Stop could not be confirmed");
    });
    const perform = () => runDurableTaskControl("project", taskId, "retry", {}, effect);
    await expect(request("uncertain-retry", perform)).rejects.toThrow(
      "Stop could not be confirmed"
    );
    expect((await operationService.getByRequestId("project", "uncertain-retry"))?.status).toBe(
      "uncertain"
    );
    await expect(request("uncertain-retry", perform)).rejects.toMatchObject({
      code: "OPERATION_ACCEPTED",
    });
    expect(effect).toHaveBeenCalledTimes(1);
  });
  it("fences a final task mutation after the control owner has been recovered", async () => {
    const operation = await operationService.accept({
      projectId: "project",
      actorId: "local-user",
      requestId: "old-control",
      kind: "task.control.done",
      target: taskId,
      payload: {},
      expectedRevision: 1,
    });
    const claimed = (await operationService.claim("project", operation.id, "ended-owner"))!;
    await operationService.recoverOwner("project", "ended-owner");
    await expect(
      withOperationEffect(claimed, () =>
        state.store!.closeCollaboratively("project", taskId, "Stale done", {
          actorId: "local-user",
          requestId: "old-control",
          expectedRevision: 1,
        })
      )
    ).rejects.toMatchObject({ code: "TASK_CONTROL_OWNER_LOST" });
    expect((await state.store!.show("project", taskId)).status).toBe("open");
  });

  function taskControlApp() {
    const orchestrator = new OrchestratorService();
    const tasks = new TaskService(
      {
        getProject: async () => ({ id: "project", repoPath: directory }),
        getSettings: async () => ({ gitWorkingMode: "branches" }),
      } as never,
      state.store!,
      { checkAutoResolveOnTaskDone: async () => {} } as never,
      { getActiveDir: () => path.join(directory, "active") } as never,
      { revertAndReturnToMain: async () => {} } as never,
      {
        stopTaskAndFreeSlot: (project, task) => orchestrator.stopTaskAndFreeSlot(project, task),
        nudge: () => {},
      }
    );
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) =>
      runWithRequestContext(
        { projectId: "project", principal: localIdentity(), requestId: randomUUID() },
        next
      )
    );
    app.use("/projects/:projectId/tasks", createTasksRouter(tasks));
    app.use(errorHandler);
    return app;
  }

  it("composes HTTP control admission, observed stop, final task CAS and operation completion", async () => {
    // An injected test store must remain authoritative even when the app's
    // configured production database is deliberately refused by test guards.
    vi.stubEnv("DATABASE_URL", "postgresql://opensprint:opensprint@localhost:5432/opensprint");
    const app = taskControlApp();
    await state.store!.update("project", taskId, { status: "blocked" });
    const response = await supertest(app)
      .post(`/projects/project/tasks/${taskId}/unblock`)
      .send({});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect((await state.store!.show("project", taskId)).status).toBe("open");
    const deleted = await supertest(app).delete(`/projects/project/tasks/${taskId}`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    await expect(state.store!.show("project", taskId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("allows a fresh HTTP control after an idle worker's previous owner lease expired", async () => {
    const app = taskControlApp();
    await state.store!.update("project", taskId, { status: "blocked" });
    const initial = await supertest(app).post(`/projects/project/tasks/${taskId}/unblock`).send({});
    expect(initial.status, JSON.stringify(initial.body)).toBe(200);
    const oldOwnerId = operationWorker.ownerId;
    await (
      await db.getClient()
    ).execute("UPDATE operation_owners SET expires_at=$1 WHERE owner_id=$2", [
      "2000-01-01T00:00:00.000Z",
      oldOwnerId,
    ]);
    await expect(operationService.heartbeatOwner(oldOwnerId)).rejects.toMatchObject({
      code: "OPERATION_OWNER_EXPIRED",
    });
    const another = await state.store!.create("project", "After idle");
    const response = await supertest(app).delete(`/projects/project/tasks/${another.id}`);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(operationWorker.ownerId).not.toBe(oldOwnerId);
    expect(
      await (
        await db.getClient()
      ).queryOne("SELECT expires_at FROM operation_owners WHERE owner_id=$1", [oldOwnerId])
    ).toEqual({ expires_at: "2000-01-01T00:00:00.000Z" });
  });

  it("keeps an active old handler fenced after rotating to a fresh worker identity", async () => {
    const app = taskControlApp();
    const oldOperation = await operationService.accept({
      projectId: "project",
      actorId: "local-user",
      requestId: "old-live-control",
      kind: "task.control.done",
      target: taskId,
      expectedRevision: 1,
      payload: {},
    });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const oldExecution = operationWorker.execute(oldOperation, async () => {
      entered();
      await gate;
      await state.store!.closeCollaboratively("project", taskId, "Late old result", {
        actorId: "local-user",
        requestId: "old-live-control",
        expectedRevision: 1,
      });
      return { taskClosed: true };
    });
    void oldExecution.catch(() => {});
    await started;
    const oldOwnerId = operationWorker.ownerId;
    await (
      await db.getClient()
    ).execute("UPDATE operation_owners SET expires_at=$1 WHERE owner_id=$2", [
      "2000-01-01T00:00:00.000Z",
      oldOwnerId,
    ]);
    try {
      const another = await state.store!.create("project", "Fresh control");
      const response = await supertest(app).delete(`/projects/project/tasks/${another.id}`);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(operationWorker.ownerId).not.toBe(oldOwnerId);
      const rejected = expect(oldExecution).rejects.toMatchObject({ code: "OPERATION_FENCE_LOST" });
      release();
      await rejected;
      expect((await state.store!.show("project", taskId)).status).toBe("open");
      expect(await operationService.get("project", oldOperation.id)).toMatchObject({
        status: "uncertain",
        ownerId: oldOwnerId,
        result: null,
      });
    } finally {
      release();
      await oldExecution.catch(() => {});
    }
  });
});
