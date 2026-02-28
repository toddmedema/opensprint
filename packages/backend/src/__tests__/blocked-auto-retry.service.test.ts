import { describe, it, expect, beforeEach, vi } from "vitest";
import { runBlockedAutoRetryPass, startBlockedAutoRetry, stopBlockedAutoRetry } from "../services/blocked-auto-retry.service.js";

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    listBlockedByTechnicalErrorEligibleForRetry: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: vi.fn(),
}));

vi.mock("../services/orchestrator.service.js", () => ({
  orchestratorService: {
    nudge: vi.fn(),
  },
}));

import { taskStore } from "../services/task-store.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { orchestratorService } from "../services/orchestrator.service.js";

describe("BlockedAutoRetryService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("runBlockedAutoRetryPass", () => {
    it("unblocks tasks blocked by technical errors and sets last_auto_retry_at", async () => {
      vi.mocked(taskStore.listBlockedByTechnicalErrorEligibleForRetry).mockResolvedValue([
        {
          id: "os-abc.1",
          title: "Task",
          status: "blocked",
          block_reason: "Merge Failure",
        } as never,
      ]);

      vi.mocked(taskStore.update).mockResolvedValue({} as never);

      const getTargets = () =>
        Promise.resolve([{ projectId: "proj-1", repoPath: "/tmp/repo" }]);

      const retried = await runBlockedAutoRetryPass(getTargets);

      expect(retried).toEqual([{ projectId: "proj-1", taskId: "os-abc.1" }]);
      expect(taskStore.update).toHaveBeenCalledWith("proj-1", "os-abc.1", {
        status: "open",
        block_reason: null,
        last_auto_retry_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      });
      expect(broadcastToProject).toHaveBeenCalledWith("proj-1", {
        type: "task.updated",
        taskId: "os-abc.1",
        status: "open",
        assignee: null,
        blockReason: null,
      });
      expect(orchestratorService.nudge).toHaveBeenCalledWith("proj-1");
    });

    it("does not retry when no eligible tasks", async () => {
      vi.mocked(taskStore.listBlockedByTechnicalErrorEligibleForRetry).mockResolvedValue([]);

      const getTargets = () =>
        Promise.resolve([{ projectId: "proj-1", repoPath: "/tmp/repo" }]);

      const retried = await runBlockedAutoRetryPass(getTargets);

      expect(retried).toEqual([]);
      expect(taskStore.update).not.toHaveBeenCalled();
    });

    it("continues when one project fails", async () => {
      vi.mocked(taskStore.listBlockedByTechnicalErrorEligibleForRetry)
        .mockRejectedValueOnce(new Error("db error"))
        .mockResolvedValueOnce([
          {
            id: "os-xyz.1",
            title: "Task 2",
            status: "blocked",
            block_reason: "Coding Failure",
          } as never,
        ]);

      const getTargets = () =>
        Promise.resolve([
          { projectId: "proj-fail", repoPath: "/tmp/fail" },
          { projectId: "proj-ok", repoPath: "/tmp/ok" },
        ]);

      const retried = await runBlockedAutoRetryPass(getTargets);

      expect(retried).toEqual([{ projectId: "proj-ok", taskId: "os-xyz.1" }]);
      expect(taskStore.update).toHaveBeenCalledTimes(1);
    });
  });

  describe("startBlockedAutoRetry and stopBlockedAutoRetry", () => {
    it("start and stop without error", () => {
      const getTargets = () => Promise.resolve([]);
      startBlockedAutoRetry(getTargets);
      stopBlockedAutoRetry();
    });

    it("start is idempotent (does not start twice)", () => {
      const getTargets = () => Promise.resolve([]);
      startBlockedAutoRetry(getTargets);
      startBlockedAutoRetry(getTargets);
      stopBlockedAutoRetry();
    });
  });
});
