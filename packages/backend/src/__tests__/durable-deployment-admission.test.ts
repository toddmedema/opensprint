import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSettings } from "@opensprint/shared";
import type { DurableOperation } from "../services/operation.service.js";
const state = vi.hoisted(() => ({
  settings: { deployment: { mode: "custom", target: "staging" } } as ProjectSettings,
  accept: vi.fn(),
  auth: vi.fn(),
  create: vi.fn(),
  handlers: new Map<string, (op: DurableOperation) => Promise<unknown>>(),
}));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return {
    execFile: Object.assign(vi.fn(), {
      [promisify.custom]: async () => ({ stdout: "a".repeat(40), stderr: "" }),
    }),
  };
});
vi.mock("../services/project.service.js", () => ({
  ProjectService: class {
    getProject = async () => ({ repoPath: "/project", name: "Project" });
    getSettings = async () => state.settings;
  },
}));
vi.mock("../services/operation.service.js", () => ({
  operationService: {
    getByRequestId: vi.fn().mockResolvedValue(null),
    accept: state.accept,
  },
}));
vi.mock("../services/operation-worker.service.js", () => ({
  operationWorker: {
    register: (kind: string, fn: (op: DurableOperation) => Promise<unknown>) =>
      state.handlers.set(kind, fn),
    execute: vi.fn().mockResolvedValue({}),
  },
}));
vi.mock("../services/deployment-control.service.js", () => ({
  withDeploymentEffect: (_project: string, _id: string, fn: () => Promise<unknown>) => fn(),
  requestDeploymentStop: vi.fn(),
}));
vi.mock("../services/deployment-expo-isolation.service.js", () => ({
  checkDeploymentExpoAuth: state.auth,
}));
vi.mock("../services/deploy-storage.service.js", () => ({
  deployStorageService: {
    getLatestDeploy: vi.fn().mockResolvedValue(null),
    getRecord: vi.fn().mockResolvedValue({ status: "success" }),
    createRecord: state.create,
    updateRecord: vi.fn(),
  },
}));
vi.mock("../routes/deliver.js", () => ({
  runDeployAsync: vi.fn(),
  runExplicitExpoDeployment: vi.fn(),
  runExplicitRollback: vi.fn(),
}));
import { acceptDeployment } from "../services/durable-deployment.service.js";
import { stableFingerprint } from "../services/project-event.service.js";

describe("durable deployment admission", () => {
  beforeEach(() => {
    state.settings = { deployment: { mode: "custom", target: "staging" } } as ProjectSettings;
    state.accept.mockReset().mockResolvedValue({ id: "operation", status: "queued" });
    state.auth.mockReset().mockResolvedValue({ ok: true, expoToken: "project-token" });
    state.create.mockReset().mockResolvedValue({ id: "operation" });
  });
  it("rejects explicit Expo deployment in custom mode before accepting durable work", async () => {
    await expect(acceptDeployment("p", { action: "expo", variant: "beta" })).rejects.toMatchObject({
      statusCode: 400,
      code: "EXPO_REQUIRED",
    });
    expect(state.accept).not.toHaveBeenCalled();
  });
  it("returns missing Expo authentication before acceptance with its actionable prompt", async () => {
    state.settings = { deployment: { mode: "expo" } } as ProjectSettings;
    state.auth.mockResolvedValue({
      ok: false,
      code: "EXPO_TOKEN_REQUIRED",
      message: "Authentication required",
      prompt: "Set a project token",
    });
    await expect(acceptDeployment("p", { action: "expo", variant: "beta" })).rejects.toMatchObject({
      statusCode: 400,
      code: "EXPO_TOKEN_REQUIRED",
      details: { prompt: "Set a project token" },
    });
    expect(state.accept).not.toHaveBeenCalled();
  });
  it("records the settings default target when the accepted caller omits a target", async () => {
    const payload = {
      action: "deploy",
      baseSha: "a".repeat(40),
      settingsHash: stableFingerprint(state.settings.deployment),
    };
    await state.handlers.get("deployment.run")!({
      projectId: "p",
      id: "operation",
      payload,
    } as DurableOperation);
    expect(state.create).toHaveBeenCalledWith(
      "p",
      undefined,
      expect.objectContaining({ id: "operation", target: "staging" })
    );
  });
});
