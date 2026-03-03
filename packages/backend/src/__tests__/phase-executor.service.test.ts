import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";
import fs from "fs/promises";
import {
  PhaseExecutorService,
  type PhaseExecutorHost,
} from "../services/phase-executor.service.js";
import type { StoredTask } from "../services/task-store.service.js";
import type { AgentSlotLike } from "../services/orchestrator-phase-context.js";

const mockCreateTaskWorktree = vi.fn();
const mockCreateOrCheckoutBranch = vi.fn();
const mockEnsureRepoNodeModules = vi.fn();
const mockSyncMainWithOrigin = vi.fn();
const mockGetSettings = vi.fn();
const mockPreflightCheck = vi.fn();
const mockBuildContext = vi.fn();
const mockAssembleTaskDirectory = vi.fn();
const mockGetActiveDir = vi.fn();
const mockWriteJsonAtomic = vi.fn();
const mockLifecycleRun = vi.fn();
const mockPersistCounters = vi.fn();
const mockGetState = vi.fn();
const mockHandleReviewDone = vi.fn();
const mockGetNextKey = vi.fn();

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn(),
}));

vi.mock("../services/branch-manager.js", () => ({
  BranchManager: vi.fn().mockImplementation(() => ({
    createTaskWorktree: mockCreateTaskWorktree,
    createOrCheckoutBranch: mockCreateOrCheckoutBranch,
    ensureRepoNodeModules: mockEnsureRepoNodeModules,
    syncMainWithOrigin: mockSyncMainWithOrigin,
    waitForGitReady: vi.fn().mockResolvedValue(undefined),
    rebaseOntoMain: vi.fn().mockResolvedValue(undefined),
    rebaseAbort: vi.fn().mockResolvedValue(undefined),
    getConflictedFiles: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("../services/context-assembler.js", () => ({
  ContextAssembler: vi.fn().mockImplementation(() => ({
    buildContext: mockBuildContext,
    assembleTaskDirectory: mockAssembleTaskDirectory,
  })),
}));

vi.mock("../services/session-manager.js", () => ({
  SessionManager: vi.fn().mockImplementation(() => ({
    getActiveDir: mockGetActiveDir,
  })),
}));

vi.mock("../utils/file-utils.js", () => ({
  writeJsonAtomic: (...args: unknown[]) => mockWriteJsonAtomic(...args),
}));

vi.mock("../services/plan-complexity.js", () => ({
  getComplexityForAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/summarizer.service.js", () => ({
  shouldInvokeSummarizer: vi.fn().mockReturnValue(false),
}));

vi.mock("../services/agent-lifecycle.js", () => ({
  AgentLifecycleManager: vi.fn().mockImplementation(() => ({
    run: mockLifecycleRun,
  })),
}));

vi.mock("../services/event-log.service.js", () => ({
  eventLogService: { append: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../services/agent-identity.service.js", () => ({
  agentIdentityService: { getRecentAttempts: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../services/api-key-resolver.service.js", () => ({
  getNextKey: (...args: unknown[]) => mockGetNextKey(...args),
}));

describe("PhaseExecutorService", () => {
  let phaseExecutor: PhaseExecutorService;
  let mockHost: PhaseExecutorHost;
  const projectId = "proj-1";
  const repoPath = path.join(os.tmpdir(), "phase-executor-test-repo");
  const taskId = "os-abc1";

  const makeTask = (): StoredTask => ({
    id: taskId,
    title: "Test task",
    status: "open",
    priority: 2,
    issue_type: "task",
    type: "task",
    labels: [],
    assignee: null,
    description: "",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  });

  const makeSlot = (): AgentSlotLike & {
    agent: { startedAt: string | null; killedDueToTimeout: boolean };
    timers: Record<string, unknown>;
  } => ({
    taskId,
    taskTitle: "Test task",
    branchName: `opensprint/${taskId}`,
    worktreePath: null,
    attempt: 1,
    agent: { startedAt: null, killedDueToTimeout: false },
    timers: {},
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(path.join(repoPath, ".opensprint"), { recursive: true });

    mockGetSettings.mockResolvedValue({
      testFramework: "vitest",
      simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      reviewMode: "never",
      deployment: { mode: "custom", autoResolveFeedbackOnTaskCompletion: false },
      maxConcurrentCoders: 1,
      gitWorkingMode: "worktree",
    });

    const wtPath = path.join(os.tmpdir(), "opensprint-worktrees", taskId);
    mockCreateTaskWorktree.mockResolvedValue(wtPath);
    mockCreateOrCheckoutBranch.mockResolvedValue(undefined);
    mockEnsureRepoNodeModules.mockResolvedValue(true);
    mockSyncMainWithOrigin.mockResolvedValue("up_to_date");
    mockPreflightCheck.mockResolvedValue(undefined);
    mockBuildContext.mockResolvedValue({
      prdExcerpt: "",
      planContent: "",
      dependencyOutputs: [],
      taskDescription: "",
    });
    mockAssembleTaskDirectory.mockImplementation(async (base: string, tid: string) => {
      const taskDir = path.join(base, ".opensprint", "active", tid);
      await fs.mkdir(taskDir, { recursive: true });
    });
    mockGetActiveDir.mockImplementation((base: string, tid: string) =>
      path.join(base, ".opensprint", "active", tid)
    );
    mockWriteJsonAtomic.mockResolvedValue(undefined);
    mockLifecycleRun.mockResolvedValue(undefined);
    mockPersistCounters.mockResolvedValue(undefined);
    mockGetNextKey.mockResolvedValue({ key: "test-key" });

    const slots = new Map<string, ReturnType<typeof makeSlot>>();
    mockGetState.mockReturnValue({
      slots,
      status: { queueDepth: 0 },
    });

    mockHost = {
      getState: mockGetState,
      taskStore: {} as PhaseExecutorHost["taskStore"],
      projectService: { getSettings: mockGetSettings } as PhaseExecutorHost["projectService"],
      branchManager: {
        createTaskWorktree: mockCreateTaskWorktree,
        createOrCheckoutBranch: mockCreateOrCheckoutBranch,
        ensureRepoNodeModules: mockEnsureRepoNodeModules,
        syncMainWithOrigin: mockSyncMainWithOrigin,
        waitForGitReady: vi.fn().mockResolvedValue(undefined),
        rebaseOntoMain: vi.fn().mockResolvedValue(undefined),
        rebaseAbort: vi.fn().mockResolvedValue(undefined),
        getConflictedFiles: vi.fn().mockResolvedValue([]),
      } as PhaseExecutorHost["branchManager"],
      contextAssembler: {
        buildContext: mockBuildContext,
        assembleTaskDirectory: mockAssembleTaskDirectory,
      } as PhaseExecutorHost["contextAssembler"],
      sessionManager: { getActiveDir: mockGetActiveDir } as PhaseExecutorHost["sessionManager"],
      testRunner: {} as PhaseExecutorHost["testRunner"],
      lifecycleManager: { run: mockLifecycleRun } as PhaseExecutorHost["lifecycleManager"],
      persistCounters: mockPersistCounters,
      preflightCheck: mockPreflightCheck,
      runSummarizer: vi.fn().mockResolvedValue({}),
      getCachedSummarizerContext: vi.fn().mockReturnValue(undefined),
      setCachedSummarizerContext: vi.fn(),
      buildReviewHistory: vi.fn().mockResolvedValue(""),
      onAgentStateChange: vi.fn().mockReturnValue(() => {}),
    };

    phaseExecutor = new PhaseExecutorService(mockHost, {
      handleCodingDone: vi.fn().mockResolvedValue(undefined),
      handleReviewDone: mockHandleReviewDone,
      handleTaskFailure: vi.fn().mockResolvedValue(undefined),
    });
  });

  describe("executeCodingPhase", () => {
    it("uses createTaskWorktree when gitWorkingMode is worktree (default)", async () => {
      mockGetSettings.mockResolvedValue({
        testFramework: "vitest",
        simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
        complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
        reviewMode: "never",
        deployment: {
          mode: "custom",
          autoResolveFeedbackOnTaskCompletion: false,
        },
        maxConcurrentCoders: 1,
        gitWorkingMode: "worktree",
      });
      const task = makeTask();
      const slot = makeSlot();
      const slots = new Map([[task.id, slot]]);
      mockGetState.mockReturnValue({ slots, status: { queueDepth: 0 } });

      await phaseExecutor.executeCodingPhase(projectId, repoPath, task, slot);

      expect(mockCreateTaskWorktree).toHaveBeenCalledWith(repoPath, task.id);
      expect(mockCreateOrCheckoutBranch).not.toHaveBeenCalled();
      expect(mockEnsureRepoNodeModules).not.toHaveBeenCalled();
      expect(slot.worktreePath).not.toBe(repoPath);
      expect(slot.worktreePath).toBe(await mockCreateTaskWorktree.mock.results[0]?.value);
    });

    it("uses createOrCheckoutBranch and sets worktreePath=repoPath when gitWorkingMode is branches", async () => {
      mockGetSettings.mockResolvedValue({
        testFramework: "vitest",
        simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
        complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
        reviewMode: "never",
        deployment: {
          mode: "custom",
          autoResolveFeedbackOnTaskCompletion: false,
        },
        maxConcurrentCoders: 1,
        gitWorkingMode: "branches",
      });
      const task = makeTask();
      const slot = makeSlot();
      const slots = new Map([[task.id, slot]]);
      mockGetState.mockReturnValue({ slots, status: { queueDepth: 0 } });

      await phaseExecutor.executeCodingPhase(projectId, repoPath, task, slot);

      expect(mockCreateOrCheckoutBranch).toHaveBeenCalledWith(repoPath, `opensprint/${taskId}`);
      expect(mockCreateTaskWorktree).not.toHaveBeenCalled();
      expect(mockEnsureRepoNodeModules).toHaveBeenCalledWith(repoPath);
      expect(slot.worktreePath).toBe(repoPath);
    });

    it("defaults to worktree when gitWorkingMode is missing", async () => {
      mockGetSettings.mockResolvedValue({
        testFramework: "vitest",
        simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
        complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
        reviewMode: "never",
        deployment: {
          mode: "custom",
          autoResolveFeedbackOnTaskCompletion: false,
        },
        maxConcurrentCoders: 1,
      });
      const task = makeTask();
      const slot = makeSlot();
      const slots = new Map([[task.id, slot]]);
      mockGetState.mockReturnValue({ slots, status: { queueDepth: 0 } });

      await phaseExecutor.executeCodingPhase(projectId, repoPath, task, slot);

      expect(mockCreateTaskWorktree).toHaveBeenCalledWith(repoPath, task.id);
      expect(mockCreateOrCheckoutBranch).not.toHaveBeenCalled();
    });
  });

  describe("executeReviewPhase", () => {
    it("spawns one general review agent when reviewAngles are empty", async () => {
      mockGetSettings.mockResolvedValue({
        testFramework: "vitest",
        simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
        complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
        reviewMode: "always",
        reviewAngles: undefined,
        deployment: { mode: "custom", autoResolveFeedbackOnTaskCompletion: false },
        maxConcurrentCoders: 1,
        gitWorkingMode: "worktree",
      });
      mockBuildContext.mockResolvedValue({
        taskId,
        title: "Test task",
        description: "",
        prdExcerpt: "",
        planContent: "",
        dependencyOutputs: [],
      });
      const task = makeTask();
      const slot = makeSlot();
      const slots = new Map([[task.id, slot]]);
      mockGetState.mockReturnValue({ slots, status: { queueDepth: 0 } });
      (
        mockHost.branchManager as { captureBranchDiff: ReturnType<typeof vi.fn> }
      ).captureBranchDiff = vi.fn().mockResolvedValue("");

      await phaseExecutor.executeReviewPhase(projectId, repoPath, task, slot.branchName);

      expect(mockLifecycleRun).toHaveBeenCalledTimes(1);
      const runParams = mockLifecycleRun.mock.calls[0]?.[0] as {
        promptPath: string;
        onDone: (code: number | null) => Promise<void>;
      };
      expect(runParams.promptPath).toContain(
        path.join(".opensprint", "active", taskId, "prompt.md")
      );

      await runParams.onDone(0);
      expect(mockHandleReviewDone).toHaveBeenCalledWith(
        projectId,
        repoPath,
        task,
        slot.branchName,
        0
      );
    });

    it("spawns one review agent per angle when reviewAngles has values", async () => {
      mockGetSettings.mockResolvedValue({
        testFramework: "vitest",
        simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
        complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
        reviewMode: "always",
        reviewAngles: ["security", "performance"],
        deployment: { mode: "custom", autoResolveFeedbackOnTaskCompletion: false },
        maxConcurrentCoders: 1,
        gitWorkingMode: "worktree",
      });
      mockBuildContext.mockResolvedValue({
        taskId,
        title: "Test task",
        description: "",
        prdExcerpt: "",
        planContent: "",
        dependencyOutputs: [],
      });
      const task = makeTask();
      const slot = makeSlot();
      const slots = new Map([[task.id, slot]]);
      mockGetState.mockReturnValue({ slots, status: { queueDepth: 0 } });
      (
        mockHost.branchManager as { captureBranchDiff: ReturnType<typeof vi.fn> }
      ).captureBranchDiff = vi.fn().mockResolvedValue("");

      await phaseExecutor.executeReviewPhase(projectId, repoPath, task, slot.branchName);

      expect(mockLifecycleRun).toHaveBeenCalledTimes(2);
      const runParams = mockLifecycleRun.mock.calls.map(
        (call) =>
          call[0] as {
            promptPath: string;
            onDone: (code: number | null) => Promise<void>;
          }
      );
      expect(runParams.map((r) => r.promptPath)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(path.join("review-angles", "security", "prompt.md")),
          expect.stringContaining(path.join("review-angles", "performance", "prompt.md")),
        ])
      );

      for (const p of runParams) {
        await p.onDone(0);
      }
      expect(mockHandleReviewDone).toHaveBeenCalledWith(
        projectId,
        repoPath,
        task,
        slot.branchName,
        0,
        "security"
      );
      expect(mockHandleReviewDone).toHaveBeenCalledWith(
        projectId,
        repoPath,
        task,
        slot.branchName,
        0,
        "performance"
      );
    });
  });
});
