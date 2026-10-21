import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectSettings } from "@opensprint/shared";
import type { ProjectService } from "../services/project.service.js";
import { initAppDb } from "../db/app-db.js";
import { withOperationEffect } from "../services/operation-effect-context.js";
import type { DurableOperation } from "../services/operation.service.js";

const state = vi.hoisted(() => ({
  isolated: vi.fn(),
  unsafe: vi.fn(),
  update: vi.fn(),
  append: vi.fn(),
  broadcast: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("../services/task-store.service.js", () => ({
  taskStore: { runWrite: state.transaction },
}));
vi.mock("../services/deployment-service.js", () => ({ deploymentService: {} }));
vi.mock("../services/deploy-storage.service.js", () => ({
  deployStorageService: {
    updateRecord: state.update,
    appendLog: state.append,
    getRecord: vi.fn().mockResolvedValue({ status: "running" }),
  },
}));
vi.mock("../services/orchestrator.service.js", () => ({ orchestratorService: {} }));
vi.mock("../websocket/index.js", () => ({ broadcastToProject: state.broadcast }));
vi.mock("../services/test-runner.js", () => ({ testRunner: {} }));
vi.mock("../services/deploy-fix-epic.service.js", () => ({ createFixEpicFromTestOutput: vi.fn() }));
vi.mock("../services/durable-deployment.service.js", () => ({ acceptDeployment: vi.fn() }));
vi.mock("../services/durable-request.service.js", () => ({ runDurableRequest: vi.fn() }));
vi.mock("../services/agent/isolated-runner.js", async () => ({
  getDeploymentMode: () => "isolated-hosted",
  runIsolatedCommand: state.isolated,
}));
vi.mock("../utils/expo-install.js", () => ({
  isExpoInstalled: state.unsafe,
  ensureExpoInstalled: state.unsafe,
}));
vi.mock("../utils/expo-auth-check.js", () => ({ checkExpoAuth: state.unsafe }));
vi.mock("../utils/eas-project-link.js", () => ({
  isEasProjectLinked: state.unsafe,
  ensureEasProjectIdInAppJson: state.unsafe,
}));
import { createDeliverRouter, runExplicitExpoDeployment } from "../routes/deliver.js";
import {
  withDeploymentEffect,
  requestDeploymentStop,
} from "../services/deployment-control.service.js";

describe("hosted Expo deployment boundary", () => {
  let root: string;
  const settings = {
    deployment: { mode: "expo", expoToken: "scoped-project-token", easProjectId: "project-id" },
  } as ProjectSettings;
  beforeEach(async () => {
    vi.stubEnv("OPENSPRINT_DEPLOYMENT_MODE", "isolated-hosted");
    vi.stubEnv("EXPO_TOKEN", "ambient-host-token");
    state.isolated.mockReset().mockResolvedValue({ exitCode: 0, output: "Published" });
    state.update.mockReset().mockResolvedValue({});
    state.append.mockReset().mockResolvedValue({});
    state.broadcast.mockReset();
    state.unsafe.mockReset().mockRejectedValue(new Error("Host CLI must never execute"));
    root = await fs.mkdtemp(path.join(os.tmpdir(), "hosted-expo-"));
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { expo: "1" } })
    );
    await fs.writeFile(
      path.join(root, "app.json"),
      JSON.stringify({
        expo: { name: "App", slug: "app", extra: { eas: { projectId: "project-id" } } },
      })
    );
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
  const app = () => {
    const server = express();
    const projects = {
      getProject: async () => ({ repoPath: root }),
      getSettings: async () => settings,
    };
    server.use(
      "/projects/:projectId/deliver",
      createDeliverRouter(projects as unknown as ProjectService)
    );
    return server;
  };
  it("serves read-only readiness without invoking any repository CLI on the backend", async () => {
    const response = await request(app()).get("/projects/p/deliver/expo-readiness");
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      expoInstalled: true,
      expoConfigured: true,
      authOk: true,
      easProjectLinked: true,
    });
    expect(state.unsafe).not.toHaveBeenCalled();
    expect(state.isolated).not.toHaveBeenCalled();
  });
  it("runs installation, generated config and deployment in one isolated snapshot with scoped credentials", async () => {
    const original = await fs.readFile(path.join(root, "app.json"), "utf8");
    await runExplicitExpoDeployment("p", "deploy", root, settings, "prod", "App's name");
    expect(state.unsafe).not.toHaveBeenCalled();
    expect(state.isolated).toHaveBeenCalledOnce();
    const [workspace, command, , , environment] = state.isolated.mock.calls[0];
    expect(workspace).toBe(root);
    expect(command).toContain("npm ci --offline --ignore-scripts");
    expect(command).toContain("node -e");
    expect(command).toContain("npx eas-cli deploy --prod");
    expect(environment).toEqual({ EXPO_TOKEN: "scoped-project-token" });
    expect(command).not.toContain("scoped-project-token");
    expect(command).not.toContain("ambient-host-token");
    expect(await fs.readFile(path.join(root, "app.json"), "utf8")).toBe(original);
    await expect(fs.access(path.join(root, "eas.json"))).rejects.toThrow();
    expect(state.update).toHaveBeenLastCalledWith(
      "p",
      "deploy",
      expect.objectContaining({ status: "success" })
    );
  });
  it("requires explicit project credentials and does not borrow the host's authenticated Expo session", async () => {
    await runExplicitExpoDeployment(
      "p",
      "deploy",
      root,
      { deployment: { mode: "expo" } } as ProjectSettings,
      "beta"
    );
    expect(state.unsafe).not.toHaveBeenCalled();
    expect(state.isolated).not.toHaveBeenCalled();
    expect(state.update).toHaveBeenLastCalledWith(
      "p",
      "deploy",
      expect.objectContaining({
        status: "failed",
        error: expect.stringContaining("project Expo access token"),
      })
    );
  });
  it("does not launch a container after an already observed stop request", async () => {
    await withDeploymentEffect("p", "deploy", async () => {
      expect(await requestDeploymentStop("p", "deploy")).toEqual({
        stopRequested: true,
        uncertain: false,
      });
      await runExplicitExpoDeployment("p", "deploy", root, settings, "beta");
    });
    expect(state.isolated).not.toHaveBeenCalled();
    expect(state.unsafe).not.toHaveBeenCalled();
    expect(state.update).toHaveBeenLastCalledWith(
      "p",
      "deploy",
      expect.objectContaining({ status: "stopped" })
    );
  });
  it("keeps missing container-stop acknowledgement uncertain", async () => {
    state.isolated.mockRejectedValue(
      Object.assign(new Error("Container ownership unknown"), {
        code: "ISOLATED_EXECUTION_UNCERTAIN",
      })
    );
    await withDeploymentEffect("p", "deploy", () =>
      runExplicitExpoDeployment("p", "deploy", root, settings, "beta")
    );
    expect(state.update).toHaveBeenLastCalledWith(
      "p",
      "deploy",
      expect.objectContaining({ status: "uncertain" })
    );
  });
  it("does not launch a deployment command after its operation owner has expired", async () => {
    const db = await initAppDb("sqlite://:memory:");
    state.transaction.mockImplementation((fn) => db.runWrite(fn));
    try {
      const operation = {
        projectId: "p",
        kind: "deployment.run",
        id: "deploy",
        ownerId: "expired-owner",
        generation: 1,
      } as DurableOperation;
      await withOperationEffect(operation, () =>
        runExplicitExpoDeployment("p", "deploy", root, settings, "prod")
      );
      expect(state.isolated).not.toHaveBeenCalled();
      expect(state.update).toHaveBeenLastCalledWith(
        "p",
        "deploy",
        expect.objectContaining({
          status: "failed",
          error: expect.stringContaining("operation owner expired"),
        })
      );
    } finally {
      await db.close();
      state.transaction.mockReset();
    }
  });
  it("broadcasts Expo output only after its durable log transaction commits", async () => {
    let commit!: () => void;
    state.append.mockReturnValue(
      new Promise<void>((resolve) => {
        commit = resolve;
      })
    );
    const deployment = runExplicitExpoDeployment("p", "deploy", root, settings, "prod");
    await vi.waitFor(() => expect(state.append).toHaveBeenCalledWith("p", "deploy", "Published"));
    expect(state.broadcast).not.toHaveBeenCalled();
    commit();
    await deployment;
    expect(state.broadcast).toHaveBeenCalledWith("p", {
      type: "deliver.output",
      deployId: "deploy",
      chunk: "Published",
    });
  });
  it("does not broadcast output rejected by its durable log fence", async () => {
    state.append.mockRejectedValue(new Error("Deployment owner expired"));
    await runExplicitExpoDeployment("p", "deploy", root, settings, "prod");
    expect(state.broadcast.mock.calls.some(([, event]) => event.type === "deliver.output")).toBe(
      false
    );
    expect(state.update).toHaveBeenLastCalledWith(
      "p",
      "deploy",
      expect.objectContaining({ status: "failed" })
    );
  });
});
