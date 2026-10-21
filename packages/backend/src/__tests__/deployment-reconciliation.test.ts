import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppDb } from "../db/app-db.js";
const state = vi.hoisted(() => ({ db: null as AppDb | null }));
vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    getDb: () => state.db!.getClient(),
    runRead: async (fn: Parameters<AppDb["runWrite"]>[0]) => fn(await state.db!.getClient()),
    runWrite: (fn: Parameters<AppDb["runWrite"]>[0]) => state.db!.runWrite(fn),
  },
}));
vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({})),
}));
import { initAppDb } from "../db/app-db.js";
import { operationService } from "../services/operation.service.js";
import { withOperationEffect } from "../services/operation-effect-context.js";
import {
  requestDeploymentStop,
  withDeploymentEffect,
  deploymentSignal,
  confirmDeploymentStop,
  deploymentStopConfirmed,
} from "../services/deployment-control.service.js";
import { DeployStorageService } from "../services/deploy-storage.service.js";
import { reconcileOperation } from "../services/operation-reconciliation.service.js";
import express from "express";
import supertest from "supertest";
import { createRuntimeRouter } from "../routes/runtime-state.js";
import { runWithRequestContext } from "../services/request-context.js";
import { errorHandler } from "../middleware/error-handler.js";
import type { ProjectPermission } from "@opensprint/shared";

describe("deployment crash reconciliation", () => {
  const storage = new DeployStorageService();
  beforeEach(async () => {
    state.db = await initAppDb("sqlite://:memory:");
  });
  afterEach(async () => {
    await state.db?.close();
  });
  async function interrupted() {
    const operation = await operationService.accept({
      projectId: "project",
      actorId: "deployer",
      requestId: "deploy-once",
      kind: "deployment.run",
      target: "staging",
      payload: { action: "deploy", target: "staging", baseSha: "immutable" },
    });
    await operationService.heartbeatOwner("dead-owner");
    const claimed = (await operationService.claim("project", operation.id, "dead-owner"))!;
    await storage.createRecord("project", null, {
      id: operation.id,
      exclusive: true,
      target: "staging",
      mode: "custom",
      commitHash: "immutable",
    });
    await storage.updateRecord("project", operation.id, { status: "running" });
    await state.db!.runWrite((tx) =>
      tx.execute(
        "UPDATE operation_owners SET expires_at = '2000-01-01T00:00:00.000Z' WHERE owner_id = 'dead-owner'"
      )
    );
    await operationService.recoverExpired();
    return { operation: (await operationService.get("project", operation.id))!, claimed };
  }
  it("retains a possibly performed deployment as uncertain after owner death and blocks another deployment", async () => {
    const { operation } = await interrupted();
    expect(operation.status).toBe("uncertain");
    expect((await storage.getRecord("project", operation.id))?.status).toBe("uncertain");
    await expect(storage.createRecord("project", null, { exclusive: true })).rejects.toMatchObject({
      code: "DEPLOY_ALREADY_RUNNING",
    });
  });
  it("delivers a persisted stop to a healthy owner on another backend without guessing process ownership", async () => {
    const operation = await operationService.accept({
      projectId: "project",
      actorId: "deployer",
      requestId: "remote-stop",
      kind: "deployment.run",
      target: "staging",
      payload: {},
    });
    await operationService.heartbeatOwner("owner-A");
    await operationService.claim("project", operation.id, "owner-A");
    await storage.createRecord("project", null, { id: operation.id, exclusive: true });
    await storage.updateRecord("project", operation.id, { status: "running" });
    expect(await requestDeploymentStop("project", operation.id)).toEqual({
      stopRequested: true,
      uncertain: false,
    });
    expect((await storage.getRecord("project", operation.id))?.status).toBe("stop_requested");
    await withDeploymentEffect("project", operation.id, async () => {
      expect(deploymentSignal()?.aborted).toBe(true);
      expect(deploymentStopConfirmed()).toBe(false);
      confirmDeploymentStop();
      expect(deploymentStopConfirmed()).toBe(true);
    });
  });
  it("fences stale deployment logs and result projections after an inspected outcome", async () => {
    const { operation, claimed } = await interrupted();
    await reconcileOperation(
      "project",
      operation.id,
      {
        expectedGeneration: operation.generation,
        outcome: "completed",
        reason: "Provider confirmed release",
      },
      "deployer",
      "inspect-before-stale"
    );
    await expect(
      withOperationEffect(claimed, () => storage.appendLog("project", operation.id, "stale output"))
    ).rejects.toMatchObject({ code: "DEPLOYMENT_OWNER_LOST" });
    await expect(
      withOperationEffect(claimed, () =>
        storage.updateRecord("project", operation.id, { status: "failed" })
      )
    ).rejects.toMatchObject({ code: "DEPLOYMENT_OWNER_LOST" });
    const saved = await storage.getRecord("project", operation.id);
    expect(saved?.status).toBe("success");
    expect(saved?.log.join("")).not.toContain("stale output");
  });
  it("records the inspected outcome, actor and reason atomically without replaying deployment", async () => {
    const { operation, claimed } = await interrupted();
    const input = {
      expectedGeneration: operation.generation,
      outcome: "completed" as const,
      reason: "Verified commit immutable is live at the provider",
    };
    const resolved = await reconcileOperation(
      "project",
      operation.id,
      input,
      "controller",
      "resolution-1"
    );
    expect(resolved.status).toBe("completed");
    expect(resolved.result).toMatchObject({
      manualResolution: { actorId: "controller", reason: input.reason },
    });
    expect((await storage.getRecord("project", operation.id))?.status).toBe("success");
    expect(
      await reconcileOperation("project", operation.id, input, "controller", "resolution-1")
    ).toEqual(resolved);
    await expect(
      operationService.complete("project", operation.id, "dead-owner", claimed.generation, {
        success: true,
      })
    ).rejects.toMatchObject({ code: "OPERATION_FENCE_LOST" });
  });
  it("allows exactly one concurrent manual outcome and rejects conflicting request reuse", async () => {
    const { operation } = await interrupted();
    const outcomes = await Promise.allSettled([
      reconcileOperation(
        "project",
        operation.id,
        { expectedGeneration: operation.generation, outcome: "completed", reason: "Verified live" },
        "controller-a",
        "decision-a"
      ),
      reconcileOperation(
        "project",
        operation.id,
        { expectedGeneration: operation.generation, outcome: "failed", reason: "Verified absent" },
        "controller-b",
        "decision-b"
      ),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === "rejected")).toHaveLength(1);
    const current = (await operationService.get("project", operation.id))!;
    const manual = (current.result as { manualResolution: { requestId: string; actorId: string } })
      .manualResolution;
    await expect(
      reconcileOperation(
        "project",
        operation.id,
        { expectedGeneration: operation.generation, outcome: "failed", reason: "Different" },
        manual.actorId,
        manual.requestId
      )
    ).rejects.toMatchObject({ code: "REQUEST_ID_REUSED" });
  });
  it("exposes inspected deployment resolution through the API with deployment permission", async () => {
    const { operation } = await interrupted();
    const app = express();
    let permissions: ProjectPermission[] = ["control"];
    app.use(express.json());
    app.use(
      "/projects/:projectId/runtime",
      (_req, _res, next) =>
        runWithRequestContext(
          {
            projectId: "project",
            requestId: "api-resolution",
            principal: {
              actorId: "reviewer",
              displayName: "Reviewer",
              role: "controller",
              permissions,
              local: false,
            },
          },
          next
        ),
      createRuntimeRouter()
    );
    app.use(errorHandler);
    const endpoint = `/projects/project/runtime/operations/${operation.id}/reconcile`;
    const input = {
      expectedGeneration: operation.generation,
      outcome: "failed",
      reason: "Provider inspection confirmed no deployment",
    };
    expect((await supertest(app).post(endpoint).send(input)).status).toBe(403);
    permissions = ["deploy"];
    const response = await supertest(app).post(endpoint).send(input);
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "failed",
      result: { manualResolution: { actorId: "reviewer" } },
    });
    expect((await storage.getRecord("project", operation.id))?.status).toBe("failed");
  });
});
