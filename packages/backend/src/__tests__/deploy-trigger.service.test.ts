import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs/promises";

const mockGetProject = vi.fn();
const mockGetSettings = vi.fn();
const mockGetLatestDeploy = vi.fn();
const mockCreateRecord = vi.fn();
const mockUpdateRecord = vi.fn();
const mockBroadcastToProject = vi.fn();
const mockRunDeployAsync = vi.fn().mockResolvedValue(undefined);
const mockExecSync = vi.fn();

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getProject: mockGetProject,
    getSettings: mockGetSettings,
  })),
}));

vi.mock("../services/deploy-storage.service.js", () => ({
  deployStorageService: {
    getLatestDeploy: (...args: unknown[]) => mockGetLatestDeploy(...args),
    createRecord: (...args: unknown[]) => mockCreateRecord(...args),
    updateRecord: (...args: unknown[]) => mockUpdateRecord(...args),
  },
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: (...args: unknown[]) => mockBroadcastToProject(...args),
}));

vi.mock("../routes/deliver.js", () => ({
  runDeployAsync: (...args: unknown[]) => mockRunDeployAsync(...args),
}));

vi.mock("child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

const { triggerDeploy, triggerDeployForEvent } =
  await import("../services/deploy-trigger.service.js");

describe("deploy-trigger.service", () => {
  let repoPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    repoPath = path.join(os.tmpdir(), `opensprint-deploy-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });

    mockGetProject.mockResolvedValue({ repoPath });
    mockGetSettings.mockResolvedValue({
      deployment: { mode: "custom", targets: [] },
    });
    mockGetLatestDeploy.mockResolvedValue(null);
    mockCreateRecord.mockResolvedValue({
      id: "deploy-123",
      projectId: "proj-1",
      status: "pending",
      startedAt: new Date().toISOString(),
      completedAt: null,
      log: [],
      previousDeployId: null,
      commitHash: null,
      target: "production",
      mode: "custom",
    });
    mockUpdateRecord.mockResolvedValue({});
    mockExecSync.mockReturnValue("abc123def");
  });

  describe("triggerDeploy", () => {
    it("creates deployment record and returns deploy ID on success", async () => {
      const deployId = await triggerDeploy("proj-1");

      expect(deployId).toBe("deploy-123");
      expect(mockGetProject).toHaveBeenCalledWith("proj-1");
      expect(mockGetSettings).toHaveBeenCalledWith("proj-1");
      expect(mockGetLatestDeploy).toHaveBeenCalledWith("proj-1");
      expect(mockCreateRecord).toHaveBeenCalledWith(
        "proj-1",
        null,
        expect.objectContaining({
          commitHash: "abc123def",
          target: "production",
          mode: "custom",
        })
      );
      expect(mockBroadcastToProject).toHaveBeenCalledWith("proj-1", {
        type: "deliver.started",
        deployId: "deploy-123",
      });
      expect(mockUpdateRecord).toHaveBeenCalledWith("proj-1", "deploy-123", {
        status: "running",
      });
      expect(mockRunDeployAsync).toHaveBeenCalled();
    });

    it("passes previousDeployId when latest deploy exists", async () => {
      mockGetLatestDeploy.mockResolvedValue({
        id: "deploy-prev",
        projectId: "proj-1",
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        log: [],
        previousDeployId: null,
        commitHash: null,
        target: "production",
        mode: "custom",
      });

      await triggerDeploy("proj-1");

      expect(mockCreateRecord).toHaveBeenCalledWith("proj-1", "deploy-prev", expect.any(Object));
    });

    it("returns null when deployment already in progress for project", async () => {
      let resolveDeploy!: () => void;
      const deployPromise = new Promise<void>((r) => {
        resolveDeploy = r;
      });
      mockRunDeployAsync.mockImplementation(() => deployPromise);
      await triggerDeploy("proj-1");
      const secondResult = await triggerDeploy("proj-1");

      expect(secondResult).toBeNull();
      expect(mockCreateRecord).toHaveBeenCalledTimes(1);
      resolveDeploy();
      await new Promise((r) => setImmediate(r));
    });

    it("returns null and does not throw when getProject fails", async () => {
      mockGetProject.mockRejectedValue(new Error("Project not found"));

      const deployId = await triggerDeploy("proj-1");

      expect(deployId).toBeNull();
      expect(mockCreateRecord).not.toHaveBeenCalled();
    });

    it("returns null when createRecord fails", async () => {
      mockCreateRecord.mockRejectedValue(new Error("Storage error"));

      const deployId = await triggerDeploy("proj-1");

      expect(deployId).toBeNull();
    });

    it("uses null commitHash when git rev-parse fails", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("Not a git repo");
      });

      await triggerDeploy("proj-1");

      expect(mockCreateRecord).toHaveBeenCalledWith(
        "proj-1",
        null,
        expect.objectContaining({
          commitHash: null,
        })
      );
    });

    it("passes targetName to runDeployAsync when provided", async () => {
      mockGetSettings.mockResolvedValue({
        deployment: {
          mode: "custom",
          targets: [
            { name: "staging", autoDeployTrigger: "none" },
            { name: "production", autoDeployTrigger: "none" },
          ],
        },
      });

      await triggerDeploy("proj-1", "staging");

      expect(mockCreateRecord).toHaveBeenCalledWith(
        "proj-1",
        null,
        expect.objectContaining({
          target: "staging",
        })
      );
      expect(mockRunDeployAsync).toHaveBeenCalledWith(
        "proj-1",
        "deploy-123",
        repoPath,
        expect.any(Object),
        "staging"
      );
    });
  });

  describe("triggerDeployForEvent", () => {
    it("deploys to each target with matching autoDeployTrigger sequentially", async () => {
      mockGetSettings.mockResolvedValue({
        deployment: {
          mode: "custom",
          targets: [
            { name: "staging", autoDeployTrigger: "each_task" },
            { name: "production", autoDeployTrigger: "each_task" },
          ],
        },
      });
      mockCreateRecord
        .mockResolvedValueOnce({
          id: "deploy-1",
          projectId: "proj-1",
          status: "pending",
          startedAt: new Date().toISOString(),
          completedAt: null,
          log: [],
          previousDeployId: null,
          commitHash: null,
          target: "staging",
          mode: "custom",
        })
        .mockResolvedValueOnce({
          id: "deploy-2",
          projectId: "proj-1",
          status: "pending",
          startedAt: new Date().toISOString(),
          completedAt: null,
          log: [],
          previousDeployId: null,
          commitHash: null,
          target: "production",
          mode: "custom",
        });

      const ids = await triggerDeployForEvent("proj-1", "each_task");

      expect(ids).toEqual(["deploy-1", "deploy-2"]);
      expect(mockRunDeployAsync).toHaveBeenCalledTimes(2);
      expect(mockRunDeployAsync).toHaveBeenNthCalledWith(
        1,
        "proj-1",
        "deploy-1",
        repoPath,
        expect.any(Object),
        "staging"
      );
      expect(mockRunDeployAsync).toHaveBeenNthCalledWith(
        2,
        "proj-1",
        "deploy-2",
        repoPath,
        expect.any(Object),
        "production"
      );
    });

    it("returns empty array when no targets match event", async () => {
      mockGetSettings.mockResolvedValue({
        deployment: {
          mode: "custom",
          targets: [
            { name: "staging", autoDeployTrigger: "each_epic" },
            { name: "production", autoDeployTrigger: "none" },
          ],
        },
      });

      const ids = await triggerDeployForEvent("proj-1", "each_task");

      expect(ids).toEqual([]);
      expect(mockRunDeployAsync).not.toHaveBeenCalled();
    });

    it("returns empty array when targets array is empty", async () => {
      mockGetSettings.mockResolvedValue({
        deployment: { mode: "custom", targets: [] },
      });

      const ids = await triggerDeployForEvent("proj-1", "each_task");

      expect(ids).toEqual([]);
      expect(mockRunDeployAsync).not.toHaveBeenCalled();
    });
  });
});
