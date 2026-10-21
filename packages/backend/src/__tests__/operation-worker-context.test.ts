import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDb } from "../db/app-db.js";
const state = vi.hoisted(() => ({ db: null as AppDb | null, revoked: false }));
vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    getDb: () => state.db!.getClient(),
    runRead: async (fn: Parameters<AppDb["runWrite"]>[0]) => fn(await state.db!.getClient()),
    runWrite: (fn: Parameters<AppDb["runWrite"]>[0]) => state.db!.runWrite(fn),
  },
}));
vi.mock("../services/identity.service.js", () => ({
  localIdentity: () => ({
    actorId: "local-user",
    displayName: "Host",
    role: "controller",
    local: true,
    permissions: ["read", "edit", "deploy", "control"],
  }),
  identityService: {
    member: async (actorId: string) => {
      if (state.revoked || actorId !== "user-editor") throw new Error("Membership revoked");
      return {
        actorId,
        displayName: "Editor",
        role: "participant",
        local: false,
        permissions: ["read", "edit"],
      };
    },
    require: (principal: { permissions: string[] }, permission: string) => {
      if (!principal.permissions.includes(permission)) throw new Error("Permission denied");
    },
  },
}));
import { initAppDb } from "../db/app-db.js";
import { operationService } from "../services/operation.service.js";
import { OperationWorker } from "../services/operation-worker.service.js";
import { getRequestContext } from "../services/request-context.js";

describe("durable worker authority after restart", () => {
  beforeEach(async () => {
    state.revoked = false;
    state.db = await initAppDb("sqlite://:memory:");
  });
  afterEach(async () => {
    await state.db?.close();
  });
  const accept = (kind = "plan.generate", actorId = "user-editor") =>
    operationService.accept({
      projectId: "project",
      actorId,
      requestId: "request",
      kind,
      target: "plan",
      expectedRevision: 7,
      payload: { description: "Feature" },
    });
  it("restores named actor, stable request and revision without inheriting host auto-publication", async () => {
    const operation = await accept();
    const recoveredWorker = new OperationWorker();
    recoveredWorker.register("plan.generate", async () => getRequestContext());
    const result = await recoveredWorker.execute(operation);
    expect(result.status).toBe("completed");
    expect(result.result).toMatchObject({
      principal: { actorId: "user-editor", local: false },
      requestId: "request",
      expectedRevision: 7,
      projectId: "project",
    });
  });
  it("records revoked queued work as failed before invoking its handler", async () => {
    const operation = await accept();
    state.revoked = true;
    const worker = new OperationWorker(),
      handler = vi.fn();
    worker.register("plan.generate", handler);
    const result = await worker.execute(operation);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("authorization failed");
    expect(handler).not.toHaveBeenCalled();
  });
  it("rechecks action permission when recovering an edit-only actor's execution request", async () => {
    const operation = await accept("plan.execute");
    const worker = new OperationWorker(),
      handler = vi.fn();
    worker.register("plan.execute", handler);
    expect((await worker.execute(operation)).status).toBe("failed");
    expect(handler).not.toHaveBeenCalled();
  });
});
