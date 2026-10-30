import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runGovernanceCongress } from "../services/congress.service.js";
vi.mock("../services/congress.service.js", () => ({
  runGovernanceCongress: vi.fn().mockResolvedValue(undefined),
}));

const { mockListProjects, mockGetSettings, mockRunIfDue } = vi.hoisted(() => ({
  mockListProjects: vi.fn(),
  mockGetSettings: vi.fn(),
  mockRunIfDue: vi.fn(),
}));

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    listProjects: mockListProjects,
    getSettings: mockGetSettings,
  })),
}));

vi.mock("../services/self-improvement.service.js", () => ({
  selfImprovementService: {
    runIfDue: (...args: unknown[]) => mockRunIfDue(...args),
  },
}));

import {
  runSelfImprovementTick,
  startSelfImprovementScheduler,
  stopSelfImprovementScheduler,
} from "../services/self-improvement-scheduler.service.js";

describe("self-improvement-scheduler.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stopSelfImprovementScheduler();
    mockRunIfDue.mockResolvedValue({ tasksCreated: 0, skipped: "no_changes" });
  });

  afterEach(() => {
    stopSelfImprovementScheduler();
    vi.useRealTimers();
  });

  describe("runSelfImprovementTick", () => {
    it("calls runIfDue for daily project at midnight UTC when not yet run today", async () => {
      // Wed Jan 15 2025 00:00 UTC
      const now = new Date(Date.UTC(2025, 0, 15, 0, 0, 0, 0));
      mockListProjects.mockResolvedValue([
        { id: "proj-daily", name: "Daily Project", repoPath: "/tmp/daily" },
      ]);
      mockGetSettings.mockResolvedValue({
        selfImprovementFrequency: "daily",
        selfImprovementLastRunAt: undefined,
      });

      const results = await runSelfImprovementTick(now);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ projectId: "proj-daily", triggered: true });
      expect(mockRunIfDue).toHaveBeenCalledTimes(1);
      expect(mockRunIfDue).toHaveBeenCalledWith("proj-daily", { trigger: "scheduled" });
      expect(runGovernanceCongress).toHaveBeenCalledWith("proj-daily");
    });

    it("does not call runIfDue for daily project at midnight UTC when already run today", async () => {
      const now = new Date(Date.UTC(2025, 0, 15, 0, 0, 0, 0));
      mockListProjects.mockResolvedValue([
        { id: "proj-daily", name: "Daily Project", repoPath: "/tmp/daily" },
      ]);
      mockGetSettings.mockResolvedValue({
        selfImprovementFrequency: "daily",
        selfImprovementLastRunAt: "2025-01-15T00:00:00.000Z",
      });

      const results = await runSelfImprovementTick(now);

      expect(results).toHaveLength(0);
      expect(mockRunIfDue).not.toHaveBeenCalled();
    });

    it("does not call runIfDue for daily project when not midnight UTC", async () => {
      const now = new Date(Date.UTC(2025, 0, 15, 1, 0, 0, 0)); // 01:00 UTC
      mockListProjects.mockResolvedValue([
        { id: "proj-daily", name: "Daily Project", repoPath: "/tmp/daily" },
      ]);
      mockGetSettings.mockResolvedValue({
        selfImprovementFrequency: "daily",
        selfImprovementLastRunAt: undefined,
      });

      const results = await runSelfImprovementTick(now);

      expect(results).toHaveLength(0);
      expect(mockRunIfDue).not.toHaveBeenCalled();
    });

    it("calls runIfDue for weekly project on Sunday 00:00 UTC when not yet run this week", async () => {
      const now = new Date(Date.UTC(2025, 0, 12, 0, 0, 0, 0)); // Sun Jan 12 2025 00:00 UTC
      mockListProjects.mockResolvedValue([
        { id: "proj-weekly", name: "Weekly Project", repoPath: "/tmp/weekly" },
      ]);
      mockGetSettings.mockResolvedValue({
        selfImprovementFrequency: "weekly",
        selfImprovementLastRunAt: undefined,
      });

      const results = await runSelfImprovementTick(now);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({ projectId: "proj-weekly", triggered: true });
      expect(mockRunIfDue).toHaveBeenCalledWith("proj-weekly", { trigger: "scheduled" });
    });

    it("does not call runIfDue for weekly project on Sunday 00:00 UTC when already run this week", async () => {
      const now = new Date(Date.UTC(2025, 0, 12, 0, 0, 0, 0));
      mockListProjects.mockResolvedValue([
        { id: "proj-weekly", name: "Weekly Project", repoPath: "/tmp/weekly" },
      ]);
      mockGetSettings.mockResolvedValue({
        selfImprovementFrequency: "weekly",
        selfImprovementLastRunAt: "2025-01-12T00:00:00.000Z",
      });

      const results = await runSelfImprovementTick(now);

      expect(results).toHaveLength(0);
      expect(mockRunIfDue).not.toHaveBeenCalled();
    });

    it("does not call runIfDue for weekly project on Monday 00:00 UTC", async () => {
      const now = new Date(Date.UTC(2025, 0, 13, 0, 0, 0, 0)); // Mon Jan 13 2025 00:00 UTC
      mockListProjects.mockResolvedValue([
        { id: "proj-weekly", name: "Weekly Project", repoPath: "/tmp/weekly" },
      ]);
      mockGetSettings.mockResolvedValue({
        selfImprovementFrequency: "weekly",
        selfImprovementLastRunAt: undefined,
      });

      const results = await runSelfImprovementTick(now);

      expect(results).toHaveLength(0);
      expect(mockRunIfDue).not.toHaveBeenCalled();
    });

    it("skips projects with frequency never or after_each_plan", async () => {
      const now = new Date(Date.UTC(2025, 0, 12, 0, 0, 0, 0)); // Sunday midnight UTC
      mockListProjects.mockResolvedValue([
        { id: "proj-never", name: "Never", repoPath: "/tmp/n" },
        { id: "proj-plan", name: "After Plan", repoPath: "/tmp/p" },
      ]);
      mockGetSettings
        .mockResolvedValueOnce({ selfImprovementFrequency: "never" })
        .mockResolvedValueOnce({ selfImprovementFrequency: "after_each_plan" });

      const results = await runSelfImprovementTick(now);

      expect(results).toHaveLength(0);
      expect(mockRunIfDue).not.toHaveBeenCalled();
    });

    it("at Sunday midnight UTC triggers both daily and weekly due projects", async () => {
      const now = new Date(Date.UTC(2025, 0, 12, 0, 0, 0, 0));
      mockListProjects.mockResolvedValue([
        { id: "proj-daily", name: "Daily", repoPath: "/tmp/d" },
        { id: "proj-weekly", name: "Weekly", repoPath: "/tmp/w" },
      ]);
      mockGetSettings
        .mockResolvedValueOnce({
          selfImprovementFrequency: "daily",
          selfImprovementLastRunAt: undefined,
        })
        .mockResolvedValueOnce({
          selfImprovementFrequency: "weekly",
          selfImprovementLastRunAt: undefined,
        });

      const results = await runSelfImprovementTick(now);

      expect(results).toHaveLength(2);
      expect(mockRunIfDue).toHaveBeenCalledWith("proj-daily", { trigger: "scheduled" });
      expect(mockRunIfDue).toHaveBeenCalledWith("proj-weekly", { trigger: "scheduled" });
    });

    it("returns empty array when no projects", async () => {
      mockListProjects.mockResolvedValue([]);
      const now = new Date(Date.UTC(2025, 0, 12, 0, 0, 0, 0));

      const results = await runSelfImprovementTick(now);

      expect(results).toHaveLength(0);
      expect(mockRunIfDue).not.toHaveBeenCalled();
    });

    it("daily project with lastRunAt yesterday is due at midnight UTC", async () => {
      const now = new Date(Date.UTC(2025, 0, 15, 0, 0, 0, 0)); // Jan 15 00:00 UTC
      mockListProjects.mockResolvedValue([{ id: "proj-daily", name: "Daily", repoPath: "/tmp/d" }]);
      mockGetSettings.mockResolvedValue({
        selfImprovementFrequency: "daily",
        selfImprovementLastRunAt: "2025-01-14T12:00:00.000Z",
      });

      const results = await runSelfImprovementTick(now);

      expect(results).toHaveLength(1);
      expect(mockRunIfDue).toHaveBeenCalledWith("proj-daily", { trigger: "scheduled" });
    });

    it("returns triggered: false for project when runIfDue throws; other projects still get triggered: true", async () => {
      const now = new Date(Date.UTC(2025, 0, 12, 0, 0, 0, 0)); // Sunday midnight UTC
      mockListProjects.mockResolvedValue([
        { id: "proj-ok", name: "OK", repoPath: "/tmp/ok" },
        { id: "proj-fail", name: "Fail", repoPath: "/tmp/fail" },
        { id: "proj-ok2", name: "OK2", repoPath: "/tmp/ok2" },
      ]);
      mockGetSettings
        .mockResolvedValueOnce({
          selfImprovementFrequency: "daily",
          selfImprovementLastRunAt: undefined,
        })
        .mockResolvedValueOnce({
          selfImprovementFrequency: "daily",
          selfImprovementLastRunAt: undefined,
        })
        .mockResolvedValueOnce({
          selfImprovementFrequency: "daily",
          selfImprovementLastRunAt: undefined,
        });
      mockRunIfDue
        .mockResolvedValueOnce({ tasksCreated: 0, skipped: "no_changes" })
        .mockRejectedValueOnce(new Error("runIfDue failed for proj-fail"))
        .mockResolvedValueOnce({ tasksCreated: 0, skipped: "no_changes" });

      const results = await runSelfImprovementTick(now);

      expect(results).toHaveLength(3);
      expect(results).toContainEqual({ projectId: "proj-ok", triggered: true });
      expect(results).toContainEqual({ projectId: "proj-fail", triggered: false });
      expect(results).toContainEqual({ projectId: "proj-ok2", triggered: true });
      expect(mockRunIfDue).toHaveBeenCalledTimes(3);
      expect(mockRunIfDue).toHaveBeenCalledWith("proj-ok", { trigger: "scheduled" });
      expect(mockRunIfDue).toHaveBeenCalledWith("proj-fail", { trigger: "scheduled" });
      expect(mockRunIfDue).toHaveBeenCalledWith("proj-ok2", { trigger: "scheduled" });
    });

    it("returns triggered: false for project when getSettings throws; other projects still get triggered: true", async () => {
      const now = new Date(Date.UTC(2025, 0, 12, 0, 0, 0, 0)); // Sunday midnight UTC
      mockListProjects.mockResolvedValue([
        { id: "proj-ok", name: "OK", repoPath: "/tmp/ok" },
        { id: "proj-settings-fail", name: "SettingsFail", repoPath: "/tmp/sf" },
      ]);
      mockGetSettings
        .mockResolvedValueOnce({
          selfImprovementFrequency: "daily",
          selfImprovementLastRunAt: undefined,
        })
        .mockRejectedValueOnce(new Error("getSettings failed"));

      const results = await runSelfImprovementTick(now);

      expect(results).toHaveLength(2);
      expect(results).toContainEqual({ projectId: "proj-ok", triggered: true });
      expect(results).toContainEqual({ projectId: "proj-settings-fail", triggered: false });
      expect(mockRunIfDue).toHaveBeenCalledTimes(1);
      expect(mockRunIfDue).toHaveBeenCalledWith("proj-ok", { trigger: "scheduled" });
    });
  });

  describe("startSelfImprovementScheduler / stopSelfImprovementScheduler", () => {
    it("starts and stops without error", () => {
      vi.useFakeTimers();
      expect(() => startSelfImprovementScheduler()).not.toThrow();
      expect(() => stopSelfImprovementScheduler()).not.toThrow();
    });

    it("does not schedule multiple timers on double start", () => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      startSelfImprovementScheduler();
      startSelfImprovementScheduler();

      expect(setTimeoutSpy).toHaveBeenCalled();
      expect(() => stopSelfImprovementScheduler()).not.toThrow();
    });

    it("clears the pending timer on stop", () => {
      vi.useFakeTimers();
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      startSelfImprovementScheduler();
      stopSelfImprovementScheduler();

      expect(clearTimeoutSpy).toHaveBeenCalled();
    });
  });
});
