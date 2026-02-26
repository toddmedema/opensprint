import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  FailureHandlerService,
  type FailureHandlerHost,
  type FailureSlot,
} from "../services/failure-handler.service.js";

vi.mock("../services/event-log.service.js", () => ({
  eventLogService: { append: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../services/agent-identity.service.js", () => ({
  agentIdentityService: { recordAttempt: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: vi.fn(),
}));

const mockRemoveTaskWorktree = vi.fn();

const mockDeleteBranch = vi.fn();
const mockRevertAndReturnToMain = vi.fn();
const mockGetSettings = vi.fn();
const mockExecuteCodingPhase = vi.fn();

describe("FailureHandlerService", () => {
  let handler: FailureHandlerService;
  let mockHost: FailureHandlerHost;
  const projectId = "proj-1";
  const repoPath = "/tmp/repo";
  const taskId = "os-abc1";
  const branchName = `opensprint/${taskId}`;

  const makeTask = (): { id: string; title: string; status: string; priority: number } =>
    ({
      id: taskId,
      title: "Test task",
      status: "in_progress",
      priority: 2,
      issue_type: "task",
      type: "task",
      labels: [],
      assignee: "Frodo",
      description: "",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    }) as { id: string; title: string; status: string; priority: number };

  const makeSlot = (worktreePath: string | null = "/tmp/worktree"): FailureSlot => ({
    taskId,
    attempt: 1,
    infraRetries: 0,
    worktreePath,
    branchName,
    phaseResult: {
      codingDiff: "",
      codingSummary: "",
      testResults: null,
      testOutput: "",
    },
    agent: {
      outputLog: [],
      startedAt: new Date().toISOString(),
      killedDueToTimeout: false,
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRemoveTaskWorktree.mockResolvedValue(undefined);
    mockDeleteBranch.mockResolvedValue(undefined);
    mockRevertAndReturnToMain.mockResolvedValue(undefined);
    mockExecuteCodingPhase.mockResolvedValue(undefined);
    mockGetSettings.mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null },
      complexComplexityAgent: { type: "cursor", model: null },
      gitWorkingMode: "worktree",
    });

    mockHost = {
      getState: vi.fn().mockReturnValue({
        slots: new Map([[taskId, makeSlot()]]),
        status: { totalFailed: 0, queueDepth: 0 },
      }),
      taskStore: {
        comment: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        setCumulativeAttempts: vi.fn().mockResolvedValue(undefined),
      },
      branchManager: {
        captureBranchDiff: vi.fn().mockResolvedValue(""),
        captureUncommittedDiff: vi.fn().mockResolvedValue(""),
        removeTaskWorktree: mockRemoveTaskWorktree,
        deleteBranch: mockDeleteBranch,
        revertAndReturnToMain: mockRevertAndReturnToMain,
      },
      sessionManager: {
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        archiveSession: vi.fn().mockResolvedValue(undefined),
      },
      projectService: {
        getSettings: mockGetSettings,
      },
      persistCounters: vi.fn().mockResolvedValue(undefined),
      deleteAssignment: vi.fn().mockResolvedValue(undefined),
      transition: vi.fn(),
      nudge: vi.fn(),
      removeSlot: vi.fn(),
      executeCodingPhase: mockExecuteCodingPhase,
    };

    handler = new FailureHandlerService(mockHost);
  });

  describe("Branches mode revert", () => {
    it("calls revertAndReturnToMain when gitWorkingMode is branches (infra retry)", async () => {
      mockGetSettings.mockResolvedValue({
        simpleComplexityAgent: { type: "cursor", model: null },
        complexComplexityAgent: { type: "cursor", model: null },
        gitWorkingMode: "branches",
      });
      mockHost.getState = vi.fn().mockReturnValue({
        slots: new Map([[taskId, makeSlot(repoPath)]]),
        status: { totalFailed: 0, queueDepth: 0 },
      });

      await handler.handleTaskFailure(
        projectId,
        repoPath,
        makeTask(),
        branchName,
        "Agent crashed",
        null,
        "agent_crash"
      );

      expect(mockRevertAndReturnToMain).toHaveBeenCalledWith(repoPath, branchName);
      expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
      expect(mockExecuteCodingPhase).toHaveBeenCalled();
    });

    it("calls revertAndReturnToMain when gitWorkingMode is branches (demotion)", async () => {
      mockGetSettings.mockResolvedValue({
        simpleComplexityAgent: { type: "cursor", model: null },
        complexComplexityAgent: { type: "cursor", model: null },
        gitWorkingMode: "branches",
      });
      const slot = makeSlot(repoPath);
      slot.attempt = 3; // BACKOFF_FAILURE_THRESHOLD
      mockHost.getState = vi.fn().mockReturnValue({
        slots: new Map([[taskId, slot]]),
        status: { totalFailed: 0, queueDepth: 0 },
      });

      await handler.handleTaskFailure(
        projectId,
        repoPath,
        makeTask(),
        branchName,
        "Tests failed",
        null,
        "coding_failure"
      );

      expect(mockRevertAndReturnToMain).toHaveBeenCalledWith(repoPath, branchName);
      expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
      expect(mockDeleteBranch).not.toHaveBeenCalled(); // revertAndReturnToMain does it
    });

    it("calls removeTaskWorktree when gitWorkingMode is worktree (infra retry)", async () => {
      mockGetSettings.mockResolvedValue({
        simpleComplexityAgent: { type: "cursor", model: null },
        complexComplexityAgent: { type: "cursor", model: null },
        gitWorkingMode: "worktree",
      });
      mockHost.getState = vi.fn().mockReturnValue({
        slots: new Map([[taskId, makeSlot("/tmp/worktree")]]),
        status: { totalFailed: 0, queueDepth: 0 },
      });

      await handler.handleTaskFailure(
        projectId,
        repoPath,
        makeTask(),
        branchName,
        "Agent crashed",
        null,
        "agent_crash"
      );

      expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(repoPath, taskId);
      expect(mockRevertAndReturnToMain).not.toHaveBeenCalled();
    });

    it("calls removeTaskWorktree and deleteBranch when gitWorkingMode is worktree (demotion)", async () => {
      mockGetSettings.mockResolvedValue({
        simpleComplexityAgent: { type: "cursor", model: null },
        complexComplexityAgent: { type: "cursor", model: null },
        gitWorkingMode: "worktree",
      });
      const slot = makeSlot("/tmp/worktree");
      slot.attempt = 3; // BACKOFF_FAILURE_THRESHOLD
      mockHost.getState = vi.fn().mockReturnValue({
        slots: new Map([[taskId, slot]]),
        status: { totalFailed: 0, queueDepth: 0 },
      });

      await handler.handleTaskFailure(
        projectId,
        repoPath,
        makeTask(),
        branchName,
        "Tests failed",
        null,
        "coding_failure"
      );

      expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(repoPath, taskId);
      expect(mockDeleteBranch).toHaveBeenCalledWith(repoPath, branchName);
      expect(mockRevertAndReturnToMain).not.toHaveBeenCalled();
    });
  });
});
