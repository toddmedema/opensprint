import { describe, it, expect, vi, beforeEach } from "vitest";
import { runNightlyTick, startNightlyDeployScheduler, stopNightlyDeployScheduler } from "../services/nightly-deploy-scheduler.service.js";

const { mockListProjects, mockGetSettings, mockTriggerDeploy, mockGetLastSuccessfulDeployForTarget, mockExecSync } = vi.hoisted(() => ({
  mockListProjects: vi.fn(),
  mockGetSettings: vi.fn(),
  mockTriggerDeploy: vi.fn(),
  mockGetLastSuccessfulDeployForTarget: vi.fn(),
  mockExecSync: vi.fn(),
}));

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    listProjects: mockListProjects,
    getSettings: mockGetSettings,
  })),
}));

vi.mock("../services/deploy-trigger.service.js", () => ({
  triggerDeploy: (...args: unknown[]) => mockTriggerDeploy(...args),
}));

vi.mock("../services/deploy-storage.service.js", () => ({
  deployStorageService: {
    getLastSuccessfulDeployForTarget: (...args: unknown[]) =>
      mockGetLastSuccessfulDeployForTarget(...args),
  },
}));

vi.mock("child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

describe("nightly-deploy-scheduler.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopNightlyDeployScheduler();
    mockGetLastSuccessfulDeployForTarget.mockResolvedValue(null); // First deployment by default
  });

  describe("runNightlyTick", () => {
    it("triggers deploy for projects with nightly targets when time matches", async () => {
      mockListProjects.mockResolvedValue([
        { id: "proj-1", name: "Project One", repoPath: "/tmp/proj-1" },
      ]);
      mockGetSettings.mockResolvedValue({
        deployment: {
          mode: "custom",
          targets: [
            { name: "staging", autoDeployTrigger: "nightly" },
            { name: "production", autoDeployTrigger: "none" },
          ],
          nightlyDeployTime: "02:00",
        },
      });
      mockTriggerDeploy.mockResolvedValue("deploy-123");

      const now = new Date(2025, 1, 15, 2, 0, 0); // Feb 15, 2025 02:00 local
      const results = await runNightlyTick(now);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        projectId: "proj-1",
        targetName: "staging",
        deployId: "deploy-123",
      });
      expect(mockTriggerDeploy).toHaveBeenCalledWith("proj-1", "staging");
    });

    it("uses default 02:00 when nightlyDeployTime is not set", async () => {
      mockListProjects.mockResolvedValue([
        { id: "proj-1", name: "Project One", repoPath: "/tmp/proj-1" },
      ]);
      mockGetSettings.mockResolvedValue({
        deployment: {
          mode: "custom",
          targets: [{ name: "staging", autoDeployTrigger: "nightly" }],
        },
      });
      mockTriggerDeploy.mockResolvedValue("deploy-456");

      const now = new Date(2025, 1, 20, 2, 0, 0); // Feb 20, 2025 02:00 local
      const results = await runNightlyTick(now);

      expect(results).toHaveLength(1);
      expect(mockTriggerDeploy).toHaveBeenCalledWith("proj-1", "staging");
    });

    it("does not trigger when current time does not match nightlyDeployTime", async () => {
      mockListProjects.mockResolvedValue([
        { id: "proj-1", name: "Project One", repoPath: "/tmp/proj-1" },
      ]);
      mockGetSettings.mockResolvedValue({
        deployment: {
          mode: "custom",
          targets: [{ name: "staging", autoDeployTrigger: "nightly" }],
          nightlyDeployTime: "03:30",
        },
      });

      const now = new Date(2025, 1, 15, 2, 0, 0); // 02:00, but config says 03:30
      const results = await runNightlyTick(now);

      expect(results).toHaveLength(0);
      expect(mockTriggerDeploy).not.toHaveBeenCalled();
    });

    it("triggers for custom time 03:30 when time matches", async () => {
      mockListProjects.mockResolvedValue([
        { id: "proj-1", name: "Project One", repoPath: "/tmp/proj-1" },
      ]);
      mockGetSettings.mockResolvedValue({
        deployment: {
          mode: "custom",
          targets: [
            { name: "staging", autoDeployTrigger: "nightly" },
            { name: "production", autoDeployTrigger: "nightly" },
          ],
          nightlyDeployTime: "03:30",
        },
      });
      mockTriggerDeploy
        .mockResolvedValueOnce("deploy-1")
        .mockResolvedValueOnce("deploy-2");

      const now = new Date(2025, 1, 15, 3, 30, 0); // Feb 15, 2025 03:30 local
      const results = await runNightlyTick(now);

      expect(results).toHaveLength(2);
      expect(mockTriggerDeploy).toHaveBeenNthCalledWith(1, "proj-1", "staging");
      expect(mockTriggerDeploy).toHaveBeenNthCalledWith(2, "proj-1", "production");
    });

    it("skips projects with no nightly targets", async () => {
      mockListProjects.mockResolvedValue([
        { id: "proj-1", name: "Project One", repoPath: "/tmp/proj-1" },
      ]);
      mockGetSettings.mockResolvedValue({
        deployment: {
          mode: "custom",
          targets: [
            { name: "staging", autoDeployTrigger: "each_task" },
            { name: "production", autoDeployTrigger: "none" },
          ],
          nightlyDeployTime: "02:00",
        },
      });

      const now = new Date(2025, 1, 15, 2, 0, 0);
      const results = await runNightlyTick(now);

      expect(results).toHaveLength(0);
      expect(mockTriggerDeploy).not.toHaveBeenCalled();
    });

    it("runs at most once per day per project", async () => {
      mockListProjects.mockResolvedValue([
        { id: "proj-once-per-day", name: "Project Once", repoPath: "/tmp/proj-once" },
      ]);
      mockGetSettings.mockResolvedValue({
        deployment: {
          mode: "custom",
          targets: [{ name: "staging", autoDeployTrigger: "nightly" }],
          nightlyDeployTime: "02:00",
        },
      });
      mockTriggerDeploy.mockResolvedValue("deploy-123");

      const now = new Date(2025, 5, 10, 2, 0, 0); // Jun 10, 2025 02:00
      const results1 = await runNightlyTick(now);
      const results2 = await runNightlyTick(now); // Same time, same day

      expect(results1).toHaveLength(1);
      expect(results2).toHaveLength(0); // Already ran today
      expect(mockTriggerDeploy).toHaveBeenCalledTimes(1);
    });

    it("handles multiple projects with different nightly times", async () => {
      mockListProjects.mockResolvedValue([
        { id: "proj-multi-1", name: "Project One", repoPath: "/tmp/proj-multi-1" },
        { id: "proj-multi-2", name: "Project Two", repoPath: "/tmp/proj-multi-2" },
      ]);
      mockGetSettings
        .mockResolvedValueOnce({
          deployment: {
            mode: "custom",
            targets: [{ name: "staging", autoDeployTrigger: "nightly" }],
            nightlyDeployTime: "02:00",
          },
        })
        .mockResolvedValueOnce({
          deployment: {
            mode: "custom",
            targets: [{ name: "production", autoDeployTrigger: "nightly" }],
            nightlyDeployTime: "04:00",
          },
        });
      mockTriggerDeploy.mockResolvedValue("deploy-x");

      const now = new Date(2025, 7, 20, 2, 0, 0); // Aug 20, 2025 02:00 - only proj-multi-1 matches
      const results = await runNightlyTick(now);

      expect(results).toHaveLength(1);
      expect(results[0].projectId).toBe("proj-multi-1");
      expect(mockTriggerDeploy).toHaveBeenCalledWith("proj-multi-1", "staging");
    });

    it("returns empty array when no projects", async () => {
      mockListProjects.mockResolvedValue([]);

      const now = new Date(2025, 1, 15, 2, 0, 0);
      const results = await runNightlyTick(now);

      expect(results).toHaveLength(0);
      expect(mockTriggerDeploy).not.toHaveBeenCalled();
    });

    it("skips deploy when no new commits on main since last successful deploy", async () => {
      mockListProjects.mockResolvedValue([
        { id: "proj-skip", name: "Project Skip", repoPath: "/tmp/proj-skip" },
      ]);
      mockGetSettings.mockResolvedValue({
        deployment: {
          mode: "custom",
          targets: [{ name: "staging", autoDeployTrigger: "nightly" }],
          nightlyDeployTime: "02:00",
        },
      });
      mockGetLastSuccessfulDeployForTarget.mockResolvedValue({
        id: "deploy-prev",
        completedAt: "2025-02-15T01:00:00.000Z",
        startedAt: "2025-02-15T00:55:00.000Z",
      });
      mockExecSync.mockReturnValue("0"); // No commits after timestamp

      const now = new Date(2025, 1, 15, 2, 0, 0);
      const results = await runNightlyTick(now);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        projectId: "proj-skip",
        targetName: "staging",
        deployId: null,
      });
      expect(mockTriggerDeploy).not.toHaveBeenCalled();
    });

    it("proceeds with deploy when new commits exist on main since last successful deploy", async () => {
      mockListProjects.mockResolvedValue([
        { id: "proj-proceed", name: "Project Proceed", repoPath: "/tmp/proj-proceed" },
      ]);
      mockGetSettings.mockResolvedValue({
        deployment: {
          mode: "custom",
          targets: [{ name: "staging", autoDeployTrigger: "nightly" }],
          nightlyDeployTime: "02:00",
        },
      });
      mockGetLastSuccessfulDeployForTarget.mockResolvedValue({
        id: "deploy-prev",
        completedAt: "2025-02-14T00:00:00.000Z",
        startedAt: "2025-02-13T23:55:00.000Z",
      });
      mockExecSync.mockReturnValue("3"); // 3 commits after timestamp
      mockTriggerDeploy.mockResolvedValue("deploy-123");

      const now = new Date(2025, 1, 15, 2, 0, 0);
      const results = await runNightlyTick(now);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        projectId: "proj-proceed",
        targetName: "staging",
        deployId: "deploy-123",
      });
      expect(mockTriggerDeploy).toHaveBeenCalledWith("proj-proceed", "staging");
    });

    it("proceeds with deploy on first deployment (no previous successful deploy)", async () => {
      mockListProjects.mockResolvedValue([
        { id: "proj-first", name: "Project First", repoPath: "/tmp/proj-first" },
      ]);
      mockGetSettings.mockResolvedValue({
        deployment: {
          mode: "custom",
          targets: [{ name: "staging", autoDeployTrigger: "nightly" }],
          nightlyDeployTime: "02:00",
        },
      });
      mockGetLastSuccessfulDeployForTarget.mockResolvedValue(null);
      mockTriggerDeploy.mockResolvedValue("deploy-first");

      const now = new Date(2025, 1, 15, 2, 0, 0);
      const results = await runNightlyTick(now);

      expect(results).toHaveLength(1);
      expect(results[0].deployId).toBe("deploy-first");
      expect(mockTriggerDeploy).toHaveBeenCalledWith("proj-first", "staging");
      expect(mockExecSync).not.toHaveBeenCalled();
    });
  });

  describe("startNightlyDeployScheduler / stopNightlyDeployScheduler", () => {
    it("starts and stops without error", () => {
      expect(() => startNightlyDeployScheduler()).not.toThrow();
      expect(() => stopNightlyDeployScheduler()).not.toThrow();
    });

    it("can stop after double start (idempotent)", () => {
      startNightlyDeployScheduler();
      startNightlyDeployScheduler();
      expect(() => stopNightlyDeployScheduler()).not.toThrow();
    });
  });
});
