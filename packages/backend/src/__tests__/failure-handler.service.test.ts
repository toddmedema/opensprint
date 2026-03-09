import { describe, it, expect, vi, beforeEach } from "vitest";
import { AGENT_INACTIVITY_TIMEOUT_MS } from "@opensprint/shared";
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

vi.mock("../services/notification.service.js", () => ({
  notificationService: {
    createApiBlocked: vi.fn().mockResolvedValue({
      id: "notif-1",
      projectId: "proj-1",
      source: "execute",
      sourceId: "os-abc1",
      questions: [],
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      errorCode: "rate_limit",
    }),
    createAgentFailed: vi.fn().mockResolvedValue({
      id: "af-1",
      projectId: "proj-1",
      source: "execute",
      sourceId: "os-abc1",
      questions: [{ id: "q-1", text: "Agent failed", createdAt: new Date().toISOString() }],
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      kind: "agent_failed",
    }),
  },
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
    phase: "coding",
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

      expect(mockRevertAndReturnToMain).toHaveBeenCalledWith(repoPath, branchName, "main");
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

      expect(mockRevertAndReturnToMain).toHaveBeenCalledWith(repoPath, branchName, "main");
      expect(mockRemoveTaskWorktree).not.toHaveBeenCalled();
      expect(mockDeleteBranch).not.toHaveBeenCalled(); // revertAndReturnToMain does it
    });

    it("passes worktreeBaseBranch from settings to captureBranchDiff when worktree mode", async () => {
      const mockCaptureBranchDiff = vi.fn().mockResolvedValue("");
      mockHost.branchManager = {
        ...mockHost.branchManager,
        captureBranchDiff: mockCaptureBranchDiff,
      };
      mockGetSettings.mockResolvedValue({
        simpleComplexityAgent: { type: "cursor", model: null },
        complexComplexityAgent: { type: "cursor", model: null },
        gitWorkingMode: "worktree",
        worktreeBaseBranch: "develop",
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

      expect(mockCaptureBranchDiff).toHaveBeenCalledWith(repoPath, branchName, "develop");
    });

    it("branches mode uses the configured base branch for revertAndReturnToMain", async () => {
      mockGetSettings.mockResolvedValue({
        simpleComplexityAgent: { type: "cursor", model: null },
        complexComplexityAgent: { type: "cursor", model: null },
        gitWorkingMode: "branches",
        worktreeBaseBranch: "develop",
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

      expect(mockRevertAndReturnToMain).toHaveBeenCalledWith(repoPath, branchName, "develop");
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

      expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(repoPath, taskId, "/tmp/worktree");
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

      expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(repoPath, taskId, "/tmp/worktree");
      expect(mockDeleteBranch).toHaveBeenCalledWith(repoPath, branchName);
      expect(mockRevertAndReturnToMain).not.toHaveBeenCalled();
    });
  });

  it("passes highlighted test failures into coder retry context", async () => {
    const slot = makeSlot("/tmp/worktree");
    slot.phaseResult.testResults = {
      passed: 0,
      failed: 1,
      skipped: 0,
      total: 1,
      details: [
        {
          name: "src/foo.test.ts > auth > rejects invalid token",
          status: "failed",
          duration: 7,
        },
      ],
    };
    slot.phaseResult.testOutput = [
      " FAIL  src/foo.test.ts > auth > rejects invalid token",
      "AssertionError: expected 401 to be 403 // Object.is equality",
    ].join("\n");
    mockHost.getState = vi.fn().mockReturnValue({
      slots: new Map([[taskId, slot]]),
      status: { totalFailed: 0, queueDepth: 0 },
    });

    await handler.handleTaskFailure(
      projectId,
      repoPath,
      makeTask(),
      branchName,
      "Tests failed: 1 failed, 0 passed",
      slot.phaseResult.testResults,
      "test_failure"
    );

    expect(mockExecuteCodingPhase).toHaveBeenCalledWith(
      projectId,
      repoPath,
      expect.objectContaining({ id: taskId }),
      expect.objectContaining({ taskId }),
      expect.objectContaining({
        previousTestFailures:
          "- src/foo.test.ts > auth > rejects invalid token — AssertionError: expected 401 to be 403 // Object.is equality",
      })
    );
  });

  describe("failure comment", () => {
    it("includes explicit inactivity message for timeout failures", async () => {
      const mockComment = vi.fn().mockResolvedValue(undefined);
      mockHost.taskStore = {
        ...mockHost.taskStore,
        comment: mockComment,
      };

      await handler.handleTaskFailure(
        projectId,
        repoPath,
        makeTask(),
        branchName,
        "Agent exited with code null without producing a result",
        null,
        "timeout"
      );

      const inactivityMinutes = Math.round(AGENT_INACTIVITY_TIMEOUT_MS / (60 * 1000));
      expect(mockComment).toHaveBeenCalledWith(
        projectId,
        taskId,
        `Attempt 1 failed [timeout]: Agent stopped responding (${inactivityMinutes} min inactivity); task requeued.`
      );
    });

    it("uses generic format for non-timeout failures", async () => {
      const mockComment = vi.fn().mockResolvedValue(undefined);
      mockHost.taskStore = {
        ...mockHost.taskStore,
        comment: mockComment,
      };

      await handler.handleTaskFailure(
        projectId,
        repoPath,
        makeTask(),
        branchName,
        "Tests failed: 2 failed, 1 passed",
        null,
        "test_failure"
      );

      expect(mockComment).toHaveBeenCalledWith(
        projectId,
        taskId,
        "Attempt 1 failed [test_failure]: Tests failed: 2 failed, 1 passed"
      );
    });

    it("blocks diagnosed no_result startup failures without blind retries", async () => {
      const slot = makeSlot("/tmp/worktree");
      slot.agent.outputLog = [
        "[Agent error: Cursor agent not found. Install: curl https://cursor.com/install -fsS | bash]\n",
      ];
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      const mockDeleteAssignment = vi.fn().mockResolvedValue(undefined);
      mockHost.getState = vi.fn().mockReturnValue({
        slots: new Map([[taskId, slot]]),
        status: { totalFailed: 0, queueDepth: 0 },
      });
      mockHost.taskStore = {
        ...mockHost.taskStore,
        update: mockUpdate,
      };
      mockHost.deleteAssignment = mockDeleteAssignment;

      await handler.handleTaskFailure(
        projectId,
        repoPath,
        makeTask(),
        branchName,
        "Agent exited with code 1 without producing a result",
        null,
        "no_result"
      );

      expect(mockExecuteCodingPhase).not.toHaveBeenCalled();
      expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(repoPath, taskId, "/tmp/worktree");
      expect(mockDeleteAssignment).toHaveBeenCalledWith(repoPath, taskId);
      expect(mockUpdate).toHaveBeenCalledWith(
        projectId,
        taskId,
        expect.objectContaining({ status: "blocked", block_reason: "Coding Failure" })
      );
    });

    it("reopens no_result failures caused by API limits instead of blocking the task", async () => {
      const slot = makeSlot("/tmp/worktree");
      slot.agent.outputLog = [
        "S: You've hit your usage limit. Switch to Auto for more usage or set a Spend Limit to continue with this model.\n",
      ];
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      const mockDeleteAssignment = vi.fn().mockResolvedValue(undefined);
      const mockSetCumulativeAttempts = vi.fn().mockResolvedValue(undefined);
      mockHost.getState = vi.fn().mockReturnValue({
        slots: new Map([[taskId, slot]]),
        status: { totalFailed: 0, queueDepth: 0 },
      });
      mockHost.taskStore = {
        ...mockHost.taskStore,
        update: mockUpdate,
        setCumulativeAttempts: mockSetCumulativeAttempts,
      };
      mockHost.deleteAssignment = mockDeleteAssignment;

      await handler.handleTaskFailure(
        projectId,
        repoPath,
        makeTask(),
        branchName,
        "Agent exited with code 1 without producing a result",
        null,
        "no_result"
      );

      expect(mockExecuteCodingPhase).not.toHaveBeenCalled();
      expect(mockRemoveTaskWorktree).toHaveBeenCalledWith(repoPath, taskId, "/tmp/worktree");
      expect(mockDeleteAssignment).toHaveBeenCalledWith(repoPath, taskId);
      expect(mockSetCumulativeAttempts).not.toHaveBeenCalled();
      expect(mockUpdate).toHaveBeenCalledWith(
        projectId,
        taskId,
        expect.objectContaining({
          status: "open",
          assignee: "",
          extra: expect.objectContaining({
            last_execution_summary: expect.objectContaining({
              outcome: "requeued",
              failureType: "no_result",
            }),
          }),
        })
      );
      expect(mockUpdate).not.toHaveBeenCalledWith(
        projectId,
        taskId,
        expect.objectContaining({ status: "blocked" })
      );
    });

    it("persists last_execution_summary when requeuing after a coding failure", async () => {
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      mockHost.taskStore = {
        ...mockHost.taskStore,
        update: mockUpdate,
      };

      await handler.handleTaskFailure(
        projectId,
        repoPath,
        makeTask(),
        branchName,
        "Tests failed: 2 failed, 1 passed",
        null,
        "test_failure"
      );

      expect(mockUpdate).toHaveBeenCalledWith(
        projectId,
        taskId,
        expect.objectContaining({
          extra: expect.objectContaining({
            last_execution_summary: expect.objectContaining({
              outcome: "requeued",
              phase: "coding",
              failureType: "test_failure",
            }),
          }),
        })
      );
    });
  });
});
