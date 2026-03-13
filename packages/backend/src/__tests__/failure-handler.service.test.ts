import { describe, it, expect, vi, beforeEach } from "vitest";
import { AGENT_INACTIVITY_TIMEOUT_MS } from "@opensprint/shared";
import {
  FailureHandlerService,
  type FailureHandlerHost,
  type FailureSlot,
} from "../services/failure-handler.service.js";
import { eventLogService } from "../services/event-log.service.js";
import { notificationService } from "../services/notification.service.js";

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

  describe("dependency preflight failures", () => {
    it("blocks immediately for dependency setup preflight failures with remediation guidance", async () => {
      await handler.handleTaskFailure(
        projectId,
        repoPath,
        makeTask(),
        branchName,
        "[REPO_DEPENDENCIES_INVALID] Dependency setup check failed after automatic repair.",
        null,
        "repo_preflight"
      );

      expect(mockHost.taskStore.update).toHaveBeenCalledWith(
        projectId,
        taskId,
        expect.objectContaining({
          status: "blocked",
          block_reason: "Coding Failure",
          extra: expect.objectContaining({
            next_retry_context: expect.objectContaining({
              failureType: "repo_preflight",
            }),
          }),
        })
      );
      expect(mockHost.taskStore.comment).toHaveBeenCalledWith(
        projectId,
        taskId,
        expect.stringContaining("Remediation: Run npm ci")
      );
      expect(eventLogService.append).toHaveBeenCalledWith(
        repoPath,
        expect.objectContaining({
          event: "task.blocked",
          data: expect.objectContaining({
            nextAction: expect.stringContaining("Run npm ci"),
          }),
        })
      );
      expect(mockHost.executeCodingPhase).not.toHaveBeenCalled();
    });

    it("blocks environment_setup failures without blind retries", async () => {
      await handler.handleTaskFailure(
        projectId,
        repoPath,
        makeTask(),
        branchName,
        "Cannot find module 'better-sqlite3'",
        null,
        "environment_setup"
      );

      expect(mockHost.taskStore.update).toHaveBeenCalledWith(
        projectId,
        taskId,
        expect.objectContaining({
          status: "blocked",
          block_reason: "Coding Failure",
          extra: expect.objectContaining({
            next_retry_context: expect.objectContaining({
              failureType: "environment_setup",
            }),
          }),
        })
      );
      expect(mockHost.executeCodingPhase).not.toHaveBeenCalled();
    });
  });

  it("passes highlighted test failures into coder retry context", async () => {
    const slot = makeSlot("/tmp/worktree");
    slot.phaseResult.validationCommand = "node ./node_modules/vitest/vitest.mjs run src/foo.test.ts";
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
        previousTestOutput: expect.stringContaining(
          "Failed command: node ./node_modules/vitest/vitest.mjs run src/foo.test.ts"
        ),
      })
    );
    expect(mockExecuteCodingPhase).toHaveBeenCalledWith(
      projectId,
      repoPath,
      expect.objectContaining({ id: taskId }),
      expect.objectContaining({ taskId }),
      expect.objectContaining({
        previousTestOutput: expect.stringContaining(
          "First failure: AssertionError: expected 401 to be 403 // Object.is equality"
        ),
      })
    );
  });

  it("persists structured execution diagnostics for test-failure requeues", async () => {
    const slot = makeSlot("/tmp/worktree");
    slot.phaseResult.validationCommand = "node ./node_modules/vitest/vitest.mjs run src/foo.test.ts";
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
          error: "AssertionError: expected 401 to be 403 // Object.is equality",
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

    expect(mockHost.taskStore.update).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({
        extra: expect.objectContaining({
          failedGateCommand: "node ./node_modules/vitest/vitest.mjs run src/foo.test.ts",
          failedGateReason: "Tests failed: 1 failed, 0 passed",
          failedGateOutputSnippet: expect.stringContaining(
            "AssertionError: expected 401 to be 403"
          ),
          firstErrorLine: "AssertionError: expected 401 to be 403 // Object.is equality",
          qualityGateDetail: expect.objectContaining({
            command: "node ./node_modules/vitest/vitest.mjs run src/foo.test.ts",
            firstErrorLine: "AssertionError: expected 401 to be 403 // Object.is equality",
          }),
        }),
      })
    );

    const appendCalls = vi.mocked(eventLogService.append).mock.calls.map(([, event]) => event);
    const failedEvent = appendCalls.find((event) => event.event === "task.failed");
    const requeuedEvent = appendCalls.find((event) => event.event === "task.requeued");

    expect(failedEvent?.data).toEqual(
      expect.objectContaining({
        failedGateCommand: "node ./node_modules/vitest/vitest.mjs run src/foo.test.ts",
        firstErrorLine: "AssertionError: expected 401 to be 403 // Object.is equality",
        qualityGateDetail: expect.objectContaining({
          command: "node ./node_modules/vitest/vitest.mjs run src/foo.test.ts",
          firstErrorLine: "AssertionError: expected 401 to be 403 // Object.is equality",
        }),
      })
    );
    expect(requeuedEvent?.data).toEqual(
      expect.objectContaining({
        failedGateCommand: "node ./node_modules/vitest/vitest.mjs run src/foo.test.ts",
        firstErrorLine: "AssertionError: expected 401 to be 403 // Object.is equality",
        qualityGateDetail: expect.objectContaining({
          command: "node ./node_modules/vitest/vitest.mjs run src/foo.test.ts",
          firstErrorLine: "AssertionError: expected 401 to be 403 // Object.is equality",
        }),
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
        "[Agent error: Cursor agent CLI was not found. Install: Unix/macOS/Linux: curl https://cursor.com/install -fsS | bash. Windows (PowerShell): irm 'https://cursor.com/install?win32=true' | iex. Then restart your terminal.]\n",
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
        "The coding agent stopped without reporting whether the task succeeded or failed.",
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
        "The coding agent stopped without reporting whether the task succeeded or failed.",
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

    it("ignores punctuation-only no_result fragments when enriching the failure reason", async () => {
      const slot = makeSlot("/tmp/worktree");
      slot.agent.outputLog = ["}\n"];
      mockHost.getState = vi.fn().mockReturnValue({
        slots: new Map([[taskId, slot]]),
        status: { totalFailed: 0, queueDepth: 0 },
      });

      await handler.handleTaskFailure(
        projectId,
        repoPath,
        makeTask(),
        branchName,
        "The coding agent stopped without reporting whether the task succeeded or failed.",
        null,
        "no_result"
      );

      expect(notificationService.createAgentFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining(
            "The coding agent stopped without reporting whether the task succeeded or failed."
          ),
        })
      );
      expect(notificationService.createAgentFailed).not.toHaveBeenCalledWith(
        expect.objectContaining({ message: "}" })
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

    it("persists retry context (including review feedback) when demoting after repeated review rejections", async () => {
      const slot = makeSlot("/tmp/worktree");
      slot.phase = "review";
      slot.attempt = 3; // demotion point
      mockHost.getState = vi.fn().mockReturnValue({
        slots: new Map([[taskId, slot]]),
        status: { totalFailed: 0, queueDepth: 0 },
      });
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
        "Review rejected",
        null,
        "review_rejection",
        "Add mark-complete endpoint and in_review status derivation."
      );

      expect(mockUpdate).toHaveBeenCalledWith(
        projectId,
        taskId,
        expect.objectContaining({
          status: "open",
          assignee: "",
          priority: 3,
          complexity: 3, // no task complexity → default 1, bump +2 = 3
          extra: expect.objectContaining({
            next_retry_context: expect.objectContaining({
              previousFailure: "Review rejected",
              reviewFeedback: "Add mark-complete endpoint and in_review status derivation.",
              failureType: "review_rejection",
            }),
          }),
        })
      );
    });

    it("bumps task complexity by 2 on demotion (capped at 10)", async () => {
      const slot = makeSlot("/tmp/worktree");
      slot.attempt = 3; // demotion point
      mockHost.getState = vi.fn().mockReturnValue({
        slots: new Map([[taskId, slot]]),
        status: { totalFailed: 0, queueDepth: 0 },
      });
      const mockUpdate = vi.fn().mockResolvedValue(undefined);
      mockHost.taskStore = { ...mockHost.taskStore, update: mockUpdate };

      const taskWithComplexity9 = makeTask() as ReturnType<typeof makeTask> & { complexity?: number };
      taskWithComplexity9.complexity = 9;

      await handler.handleTaskFailure(
        projectId,
        repoPath,
        taskWithComplexity9,
        branchName,
        "Tests failed",
        null,
        "coding_failure"
      );

      expect(mockUpdate).toHaveBeenCalledWith(
        projectId,
        taskId,
        expect.objectContaining({
          status: "open",
          assignee: "",
          priority: 3, // makeTask has priority 2 → newPriority 3
          complexity: 10, // 9 + 2 capped at 10
          extra: expect.any(Object),
        })
      );
    });
  });

  describe("review failure notifications and execution diagnostics", () => {
    it("does not create notification for review-phase failure when requeuing (retries not exceeded)", async () => {
      const slot = makeSlot("/tmp/worktree");
      slot.phase = "review";
      slot.attempt = 1;
      mockHost.getState = vi.fn().mockReturnValue({
        slots: new Map([[taskId, slot]]),
        status: { totalFailed: 0, queueDepth: 0 },
      });

      await handler.handleTaskFailure(
        projectId,
        repoPath,
        makeTask(),
        branchName,
        "Review agent crashed",
        null,
        "agent_crash"
      );

      expect(notificationService.createAgentFailed).not.toHaveBeenCalled();
      expect(notificationService.createApiBlocked).not.toHaveBeenCalled();
    });

    it("creates notification when review-phase failure blocks (retries exceeded)", async () => {
      const slot = makeSlot("/tmp/worktree");
      slot.phase = "review";
      slot.attempt = 3;
      slot.infraRetries = 0;
      mockHost.getState = vi.fn().mockReturnValue({
        slots: new Map([[taskId, slot]]),
        status: { totalFailed: 0, queueDepth: 0 },
      });
      const task = makeTask();
      (task as { priority?: number }).priority = 4;

      await handler.handleTaskFailure(
        projectId,
        repoPath,
        task,
        branchName,
        "Review failed: tests did not pass",
        null,
        "test_failure"
      );

      expect(notificationService.createAgentFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId,
          sourceId: taskId,
          message: expect.stringContaining("Review failed"),
        })
      );
    });

    it("logs all review failures to event log for Execution Diagnostics (including review_rejection)", async () => {
      const slot = makeSlot("/tmp/worktree");
      slot.phase = "review";
      slot.attempt = 1;
      mockHost.getState = vi.fn().mockReturnValue({
        slots: new Map([[taskId, slot]]),
        status: { totalFailed: 0, queueDepth: 0 },
      });

      await handler.handleTaskFailure(
        projectId,
        repoPath,
        makeTask(),
        branchName,
        "Review rejected",
        "Fix the bug in foo.ts",
        "review_rejection"
      );

      expect(eventLogService.append).toHaveBeenCalledWith(
        repoPath,
        expect.objectContaining({
          event: "task.failed",
          data: expect.objectContaining({
            phase: "review",
            failureType: "review_rejection",
            reason: "Review rejected",
          }),
        })
      );
    });
  });
});
