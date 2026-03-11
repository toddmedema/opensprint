/**
 * Integration tests for multi-angle review flow.
 *
 * Verifies:
 * (1) 0 angles → 1 general agent, correct prompt (scope + code quality, no Focus Areas)
 * (2) 2 angles → 2 parallel agents, correct prompts (angle-specific)
 * (3) Aggregation: all approved → merge; any rejected → combined feedback
 *
 * Mocks agent spawns and simulates result parsing by writing result.json before onDone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { ContextAssembler } from "../services/context-assembler.js";
import {
  PhaseExecutorService,
  type PhaseExecutorHost,
} from "../services/phase-executor.service.js";
import { SessionManager } from "../services/session-manager.js";
import {
  TaskPhaseCoordinator,
  type TestOutcome,
  type ReviewOutcome,
} from "../services/task-phase-coordinator.js";
import type { StoredTask } from "../services/task-store.service.js";
import type { AgentSlotLike } from "../services/orchestrator-phase-context.js";
import type { ReviewAgentResult } from "@opensprint/shared";

const mockProjectServiceForSession = {
  getProjectByRepoPath: vi.fn().mockResolvedValue(null),
};

// Avoid loading drizzle-orm/pg-core (vitest resolution can fail in some workspaces)
vi.mock("drizzle-orm", () => ({ and: (...args: unknown[]) => args, eq: (a: unknown, b: unknown) => [a, b] }));
vi.mock("../db/drizzle-schema-pg.js", () => ({ plansTable: {} }));

const {
  mockCreateTaskWorktree,
  mockCreateOrCheckoutBranch,
  mockEnsureRepoNodeModules,
  mockSyncMainWithOrigin,
  mockGetSettings,
  mockPreflightCheck,
  mockBuildContext,
  mockWriteJsonAtomic,
  mockLifecycleRun,
  mockPersistCounters,
  mockGetState,
  mockGetNextKey,
} = vi.hoisted(() => ({
  mockCreateTaskWorktree: vi.fn(),
  mockCreateOrCheckoutBranch: vi.fn(),
  mockEnsureRepoNodeModules: vi.fn(),
  mockSyncMainWithOrigin: vi.fn(),
  mockGetSettings: vi.fn(),
  mockPreflightCheck: vi.fn(),
  mockBuildContext: vi.fn(),
  mockWriteJsonAtomic: vi.fn(),
  mockLifecycleRun: vi.fn(),
  mockPersistCounters: vi.fn(),
  mockGetState: vi.fn(),
  mockGetNextKey: vi.fn(),
}));

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
    captureBranchDiff: vi.fn().mockResolvedValue(""),
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
  eventLogService: {
    append: vi.fn().mockImplementation(() => Promise.resolve()),
  },
}));

vi.mock("../services/agent-identity.service.js", () => ({
  agentIdentityService: { getRecentAttempts: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../services/api-key-resolver.service.js", () => ({
  getNextKey: (...args: unknown[]) => mockGetNextKey(...args),
}));

describe("Multi-angle review flow — integration", () => {
  let repoPath: string;
  let phaseExecutor: PhaseExecutorService;
  let mockHost: PhaseExecutorHost;
  const projectId = "proj-1";
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
    repoPath = path.join(os.tmpdir(), `multi-angle-review-integration-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await fs.mkdir(path.join(repoPath, ".opensprint"), { recursive: true });
    await fs.writeFile(path.join(repoPath, "SPEC.md"), "# Product Spec\n");
    await fs.mkdir(path.join(repoPath, ".opensprint", "plans"), { recursive: true });
    await fs.writeFile(path.join(repoPath, ".opensprint", "plans", "auth.md"), "# Plan\n");

    const wtPath = path.join(os.tmpdir(), "opensprint-worktrees", taskId);
    mockCreateTaskWorktree.mockResolvedValue(wtPath);
    mockCreateOrCheckoutBranch.mockResolvedValue(undefined);
    mockEnsureRepoNodeModules.mockResolvedValue(true);
    mockSyncMainWithOrigin.mockResolvedValue("up_to_date");
    mockPreflightCheck.mockResolvedValue(undefined);
    mockBuildContext.mockResolvedValue({
      taskId,
      title: "Test task",
      description: "",
      prdExcerpt: "# Product",
      planContent: "# Plan",
      dependencyOutputs: [],
    });
    mockWriteJsonAtomic.mockResolvedValue(undefined);
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
        captureBranchDiff: vi.fn().mockResolvedValue(""),
      } as PhaseExecutorHost["branchManager"],
      contextAssembler: (() => {
        const realAssembler = new ContextAssembler();
        return {
          buildContext: mockBuildContext,
          assembleTaskDirectory: realAssembler.assembleTaskDirectory.bind(realAssembler),
        };
      })(),
      sessionManager: new SessionManager(mockProjectServiceForSession as never),
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
      handleReviewDone: vi.fn().mockResolvedValue(undefined),
      handleTaskFailure: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await fs.rm(repoPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  describe("(1) 0 angles → 1 general agent, correct prompt", () => {
    it("spawns exactly one review agent with general prompt (scope + code quality, no Focus Areas)", async () => {
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

      const task = makeTask();
      const slot = makeSlot();
      const slots = new Map([[task.id, slot]]);
      mockGetState.mockReturnValue({ slots, status: { queueDepth: 0 } });

      const mockHandleReviewDone = vi.fn().mockResolvedValue(undefined);
      phaseExecutor = new PhaseExecutorService(mockHost, {
        handleCodingDone: vi.fn().mockResolvedValue(undefined),
        handleReviewDone: mockHandleReviewDone,
        handleTaskFailure: vi.fn().mockResolvedValue(undefined),
      });

      await phaseExecutor.executeReviewPhase(projectId, repoPath, task, slot.branchName);

      expect(mockLifecycleRun).toHaveBeenCalledTimes(1);
      const runParams = mockLifecycleRun.mock.calls[0]?.[0] as {
        promptPath: string;
        onDone: (code: number | null) => Promise<void>;
      };
      expect(runParams.promptPath).toContain(
        path.join(".opensprint", "active", taskId, "prompt.md")
      );
      expect(runParams.promptPath).not.toContain("review-angles");

      const taskDir = path.join(repoPath, ".opensprint", "active", taskId);
      const promptPath = path.join(taskDir, "prompt.md");
      const prompt = await fs.readFile(promptPath, "utf-8");
      expect(prompt).not.toContain("## Focus Areas");
      expect(prompt).toContain("Scope compliance");
      expect(prompt).toContain("Code quality");
      expect(prompt).toContain(`.opensprint/active/${taskId}/result.json`);

      const resultPath = path.join(taskDir, "result.json");
      await fs.writeFile(
        resultPath,
        JSON.stringify({ status: "approved", summary: "Looks good", notes: "" } as ReviewAgentResult)
      );
      await runParams.onDone(0);

      expect(mockHandleReviewDone).toHaveBeenCalledTimes(1);
      expect(mockHandleReviewDone).toHaveBeenCalledWith(
        projectId,
        repoPath,
        task,
        slot.branchName,
        0
      );
    });
  });

  describe("(2) 2 angles → 2 parallel agents, correct prompts", () => {
    it("spawns two parallel review agents with angle-specific prompts", async () => {
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

      const task = makeTask();
      const slot = makeSlot();
      slot.worktreePath = repoPath;
      const slots = new Map([[task.id, slot]]);
      mockGetState.mockReturnValue({ slots, status: { queueDepth: 0 } });

      const mockHandleReviewDone = vi.fn().mockResolvedValue(undefined);
      phaseExecutor = new PhaseExecutorService(mockHost, {
        handleCodingDone: vi.fn().mockResolvedValue(undefined),
        handleReviewDone: mockHandleReviewDone,
        handleTaskFailure: vi.fn().mockResolvedValue(undefined),
      });

      await phaseExecutor.executeReviewPhase(projectId, repoPath, task, slot.branchName);

      const runParams = mockLifecycleRun.mock.calls.map(
        (call) =>
          call[0] as {
            promptPath: string;
            onDone: (code: number | null) => Promise<void>;
            outputLogPath?: string;
            heartbeatSubpath?: string;
          }
      );
      const promptPaths = runParams.map((r) => r.promptPath);
      expect(
        promptPaths.some((p) => p.includes("review-angles/security")) ||
          promptPaths.some((p) => p.includes("review-angles/performance"))
      ).toBe(true);

      const securityPrompt = await fs.readFile(
        path.join(repoPath, ".opensprint", "active", taskId, "review-angles", "security", "prompt.md"),
        "utf-8"
      );
      const perfPrompt = await fs.readFile(
        path.join(repoPath, ".opensprint", "active", taskId, "review-angles", "performance", "prompt.md"),
        "utf-8"
      );
      expect(securityPrompt).toContain("Security implications");
      expect(securityPrompt).toContain("No injection vulnerabilities");
      expect(securityPrompt).toContain(`review-angles/security/result.json`);
      expect(perfPrompt).toContain("Performance impact");
      expect(perfPrompt).toContain("No N+1 queries");
      expect(perfPrompt).toContain(`review-angles/performance/result.json`);

      const taskDir = path.join(repoPath, ".opensprint", "active", taskId);
      await fs.writeFile(
        path.join(taskDir, "review-angles", "security", "result.json"),
        JSON.stringify({ status: "approved", summary: "Secure", notes: "" } as ReviewAgentResult)
      );
      await fs.writeFile(
        path.join(taskDir, "review-angles", "performance", "result.json"),
        JSON.stringify({ status: "approved", summary: "Fast", notes: "" } as ReviewAgentResult)
      );

      for (const p of runParams) {
        await p.onDone(0);
      }
    });
  });

  describe("(3) Aggregation", () => {
    it("all approved → coordinator resolves with approved", async () => {
      const resolve = vi.fn().mockResolvedValue(undefined);
      const testPassed: TestOutcome = { status: "passed" };
      const coord = new TaskPhaseCoordinator(taskId, resolve, {
        reviewAngles: ["security", "performance"],
      });

      coord.setTestOutcome(testPassed);
      coord.setReviewOutcome(
        { status: "approved", result: { status: "approved", summary: "OK", notes: "" }, exitCode: 0 },
        "security"
      );
      coord.setReviewOutcome(
        { status: "approved", result: { status: "approved", summary: "OK", notes: "" }, exitCode: 0 },
        "performance"
      );

      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith(
        testPassed,
        expect.objectContaining({
          status: "approved",
        })
      );
    });

    it("any rejected → coordinator resolves with combined feedback", async () => {
      const resolve = vi.fn().mockResolvedValue(undefined);
      const testPassed: TestOutcome = { status: "passed" };
      const coord = new TaskPhaseCoordinator(taskId, resolve, {
        reviewAngles: ["security", "performance"],
      });

      coord.setTestOutcome(testPassed);
      coord.setReviewOutcome(
        {
          status: "rejected",
          result: {
            status: "rejected",
            summary: "Security issue",
            issues: ["Unsanitized SQL input"],
            notes: "Use parameterized queries.",
          },
          exitCode: 1,
        },
        "security"
      );
      coord.setReviewOutcome(
        {
          status: "approved",
          result: { status: "approved", summary: "OK", notes: "" },
          exitCode: 0,
        },
        "performance"
      );

      expect(resolve).toHaveBeenCalledTimes(1);
      const [, reviewOutcome] = resolve.mock.calls[0] as [TestOutcome, ReviewOutcome];
      expect(reviewOutcome.status).toBe("rejected");
      expect(reviewOutcome.result?.summary).toContain("Security issue");
      expect(reviewOutcome.result?.issues).toContain("Unsanitized SQL input");
    });

    it("any no_result → coordinator resolves with no_result", async () => {
      const resolve = vi.fn().mockResolvedValue(undefined);
      const testPassed: TestOutcome = { status: "passed" };
      const coord = new TaskPhaseCoordinator(taskId, resolve, {
        reviewAngles: ["security", "performance"],
      });

      coord.setTestOutcome(testPassed);
      coord.setReviewOutcome(
        { status: "approved", result: { status: "approved", summary: "OK", notes: "" }, exitCode: 0 },
        "security"
      );
      coord.setReviewOutcome({ status: "no_result", result: null, exitCode: 1 }, "performance");

      expect(resolve).toHaveBeenCalledTimes(1);
      const [, reviewOutcome] = resolve.mock.calls[0] as [TestOutcome, ReviewOutcome];
      expect(reviewOutcome.status).toBe("no_result");
    });
  });

  describe("result parsing (mocked agent completion)", () => {
    it("handleReviewDone reads result.json and passes to coordinator for general agent", async () => {
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

      const task = makeTask();
      const slot = makeSlot();
      const slots = new Map([[task.id, slot]]);
      mockGetState.mockReturnValue({ slots, status: { queueDepth: 0 } });

      const testPassed: TestOutcome = { status: "passed" };
      const resolve = vi.fn().mockResolvedValue(undefined);
      const coord = new TaskPhaseCoordinator(taskId, resolve, {});

      const sessionManager = new SessionManager(mockProjectServiceForSession as never);

      const mockHandleReviewDone = vi.fn().mockImplementation(
        async (
          _projectId: string,
          _repoPath: string,
          _task: StoredTask,
          _branchName: string,
          exitCode: number | null,
          angle?: string
        ) => {
          coord.setTestOutcome(testPassed);
          const result = await sessionManager.readResult(repoPath, taskId, angle as import("@opensprint/shared").ReviewAngle | undefined);
          const status: ReviewOutcome["status"] =
            (result as ReviewAgentResult)?.status === "approved"
              ? "approved"
              : (result as ReviewAgentResult)?.status === "rejected"
                ? "rejected"
                : "no_result";
          coord.setReviewOutcome(
            { status, result: result as ReviewAgentResult | null, exitCode },
            angle
          );
        }
      );

      phaseExecutor = new PhaseExecutorService(mockHost, {
        handleCodingDone: vi.fn().mockResolvedValue(undefined),
        handleReviewDone: mockHandleReviewDone,
        handleTaskFailure: vi.fn().mockResolvedValue(undefined),
      });

      await phaseExecutor.executeReviewPhase(projectId, repoPath, task, slot.branchName);

      const runParams = mockLifecycleRun.mock.calls[0]?.[0] as {
        onDone: (code: number | null) => Promise<void>;
      };
      const resultPath = path.join(repoPath, ".opensprint", "active", taskId, "result.json");
      await fs.mkdir(path.dirname(resultPath), { recursive: true });
      await fs.writeFile(
        resultPath,
        JSON.stringify({ status: "approved", summary: "All good", notes: "" } as ReviewAgentResult)
      );
      await runParams.onDone(0);

      await vi.waitFor(() => {
        expect(resolve).toHaveBeenCalledWith(
          testPassed,
          expect.objectContaining({ status: "approved" })
        );
      });
    });
  });
});
