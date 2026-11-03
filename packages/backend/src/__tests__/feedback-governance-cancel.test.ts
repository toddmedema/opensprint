import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FeedbackItem } from "@opensprint/shared";
import { cancelFeedback } from "../services/feedback-cancel.service.js";
const mocks = vi.hoisted(() => ({
  inactive: false,
  held: new Set<string>(),
  stop: vi.fn(),
  removeTasks: vi.fn(),
  removeFeedback: vi.fn(),
  unregister: vi.fn(),
}));
vi.mock("../services/governance.service.js", () => ({
  governanceService: {
    isGovernanceInactive: async () => mocks.inactive,
    withPublicationLock: async (_project: string, operation: () => Promise<unknown>) => operation(),
    retainsTaskWorktree: async (_project: string, taskId: string) => mocks.held.has(taskId),
  },
}));
vi.mock("../services/task-store.service.js", () => ({
  taskStore: { show: vi.fn().mockResolvedValue({ status: "open" }), deleteMany: mocks.removeTasks },
}));
vi.mock("../services/orchestrator.service.js", () => ({
  orchestratorService: { stopTaskAndFreeSlot: mocks.stop },
}));
vi.mock("../services/feedback-store.service.js", () => ({
  feedbackStore: { deleteFeedback: mocks.removeFeedback },
}));
vi.mock("../services/active-agents.service.js", () => ({
  activeAgentsService: {
    listEntries: () => [{ id: "analyst", feedbackId: "feedback" }],
    unregister: mocks.unregister,
  },
}));
vi.mock("../websocket/index.js", () => ({ broadcastToProject: vi.fn() }));
it("cancels on an inactive project without any publication lock", async () => {
  mocks.inactive = true;
  const { governanceService } = await import("../services/governance.service.js");
  const lock = vi.spyOn(governanceService, "withPublicationLock");
  await cancelFeedback("project", "feedback", {
    getFeedback: async () => ({ status: "resolved" }) as FeedbackItem,
  });
  mocks.inactive = false;
  expect(lock).not.toHaveBeenCalled();
  lock.mockRestore();
});

describe("feedback cancellation preserves governed work", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.held.clear();
  });
  it.each(["linked", "source"])(
    "rejects a held %s task before stopping an agent or deleting any artifact",
    async (kind) => {
      mocks.held.add("held-task");
      const item = {
        id: "feedback",
        status: "pending",
        createdTaskIds: kind === "linked" ? ["held-task"] : [],
        feedbackSourceTaskId: kind === "source" ? "held-task" : undefined,
      } as FeedbackItem;
      await expect(
        cancelFeedback("p", "feedback", { getFeedback: async () => item })
      ).rejects.toMatchObject({ code: "GOVERNANCE_HOLD" });
      expect(mocks.stop).not.toHaveBeenCalled();
      expect(mocks.removeTasks).not.toHaveBeenCalled();
      expect(mocks.removeFeedback).not.toHaveBeenCalled();
      expect(mocks.unregister).not.toHaveBeenCalled();
    }
  );
});
