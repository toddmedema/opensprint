import { describe, it, expect, vi, beforeEach } from "vitest";
const state = vi.hoisted(() => ({
  accept: vi.fn(),
  settings: vi.fn(),
  project: vi.fn(),
  get: vi.fn(),
  execute: vi.fn(),
  git: vi.fn(),
}));
vi.mock("../services/project.service.js", () => ({
  ProjectService: vi
    .fn()
    .mockImplementation(() => ({ getSettings: state.settings, getProject: state.project })),
}));
vi.mock("../services/durable-deployment.service.js", () => ({ acceptDeployment: state.accept }));
vi.mock("../services/operation.service.js", () => ({ operationService: { get: state.get } }));
vi.mock("../services/operation-worker.service.js", () => ({
  operationWorker: { execute: state.execute },
}));
vi.mock("child_process", () => ({ execSync: state.git }));
import { triggerDeploy, triggerDeployForEvent } from "../services/deploy-trigger.service.js";

describe("durable auto deployment admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.accept.mockResolvedValue({ deployId: "deployment", operationId: "operation" });
    state.project.mockResolvedValue({ repoPath: "/repo" });
    state.settings.mockResolvedValue({ deployment: { mode: "custom", targets: [] } });
    state.get.mockResolvedValue({ id: "operation" });
    state.execute.mockResolvedValue({ status: "completed" });
    state.git.mockReturnValue("commit\n");
  });
  it("delegates manual trigger admission to the durable service", async () => {
    expect(await triggerDeploy("project", "staging")).toBe("deployment");
    expect(state.accept).toHaveBeenCalledWith(
      "project",
      { action: "deploy", target: "staging" },
      undefined
    );
  });
  it("reports failed acceptance without claiming execution succeeded", async () => {
    state.accept.mockRejectedValue(new Error("Unavailable"));
    expect(await triggerDeploy("project")).toBeNull();
    expect(state.execute).not.toHaveBeenCalled();
  });
  it("binds automatic event identities to event, commit and destination", async () => {
    state.settings.mockResolvedValue({
      deployment: {
        mode: "custom",
        targets: [
          { name: "staging", autoDeployTrigger: "each_task" },
          { name: "production", autoDeployTrigger: "each_task" },
        ],
      },
    });
    expect(await triggerDeployForEvent("project", "each_task")).toEqual([
      "deployment",
      "deployment",
    ]);
    expect(state.accept.mock.calls.map((call) => call[2].requestId)).toEqual([
      "auto:each_task:commit:staging",
      "auto:each_task:commit:production",
    ]);
    expect(state.execute).toHaveBeenCalledTimes(2);
  });
  it("waits for one destination's durable operation before admitting the next", async () => {
    state.settings.mockResolvedValue({
      deployment: {
        mode: "custom",
        targets: [
          { name: "staging", autoDeployTrigger: "each_task" },
          { name: "production", autoDeployTrigger: "each_task" },
        ],
      },
    });
    let release!: () => void;
    state.execute.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const pending = triggerDeployForEvent("project", "each_task");
    await vi.waitFor(() => expect(state.execute).toHaveBeenCalledOnce());
    expect(state.accept).toHaveBeenCalledOnce();
    release();
    await pending;
    expect(state.accept).toHaveBeenCalledTimes(2);
  });
});
