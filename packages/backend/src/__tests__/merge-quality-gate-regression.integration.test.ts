import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { MergeCoordinatorHost, MergeSlot } from "../services/merge-coordinator.service.js";
import { MergeCoordinatorService } from "../services/merge-coordinator.service.js";
import {
  runMergeQualityGates as runMergeQualityGatesShared,
  type MergeQualityGateRunOptions,
} from "../services/merge-quality-gate-runner.js";
import { BranchManager } from "../services/branch-manager.js";
import { TaskExecutionDiagnosticsService } from "../services/task-execution-diagnostics.service.js";
// These gate/repair fixtures intentionally contain a fake .git marker; code admission is covered
// by the native governance/Git suites and must not run against this synthetic repository.
vi.mock("../services/governance-execution.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/governance-execution.service.js")>()),
  governanceCodeSnapshot: async () => ({
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    diffHash: "gate-fixture",
    changedPaths: [],
  }),
  governanceExecutionService: { assertScope: async () => {} },
}));
vi.mock("../services/governance.service.js", async () => ({
  governanceService: (await import("./mocks/disabled-governance.js")).disabledGovernanceService,
}));
vi.mock("../services/worktree-lease.service.js", () => ({
  worktreeLeaseService: {
    canCleanup: vi.fn().mockResolvedValue(true),
    forceRelease: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
  },
}));

/** Merge gate runner runs node/npm preflight before gates; integration mocks must accept these. */
function mergeGateToolchainPreflightOk(
  spec: { command: string; args?: string[] },
  options?: { cwd?: string }
):
  | {
      stdout: string;
      stderr: string;
      executable: string;
      cwd: string;
      exitCode: number;
      signal: null;
    }
  | undefined {
  const command = [spec.command, ...(spec.args ?? [])].join(" ");
  if (command === "node -v") {
    return {
      stdout: "v24.0.0\n",
      stderr: "",
      executable: spec.command,
      cwd: options?.cwd ?? "",
      exitCode: 0,
      signal: null,
    };
  }
  if (command === "npm -v") {
    return {
      stdout: "10.0.0\n",
      stderr: "",
      executable: spec.command,
      cwd: options?.cwd ?? "",
      exitCode: 0,
      signal: null,
    };
  }
  return undefined;
}

const mockRunCommand = vi.fn();
const mockGetMergeQualityGateCommands = vi.fn();
const mockEventAppend = vi.fn();
const mockEventReadForTask = vi.fn();
const { createBaselineWorkspaceMock } = vi.hoisted(() => ({
  createBaselineWorkspaceMock: vi.fn(),
}));

// These synthetic workspaces exercise shared-runner classification and legacy
// repair. Durable controller recovery has separate real Git/database fixtures.
function runFixtureQualityGates(options: MergeQualityGateRunOptions) {
  const branches = new BranchManager();
  return runMergeQualityGatesShared(options, {
    runCommand: mockRunCommand,
    symlinkNodeModules: (repoPath, worktreePath) =>
      branches.symlinkNodeModules(repoPath, worktreePath),
  });
}

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {},
  TaskStoreService: class {},
  resolveEpicId: () => null,
}));

vi.mock("../utils/command-runner.js", () => ({
  runCommand: (...args: unknown[]) => mockRunCommand(...args),
  resolveCommandExecutable: (command: string) => command,
  CommandRunError: class CommandRunError extends Error {
    code?: string;
    stdout: string;
    stderr: string;
    executable: string;
    cwd: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;

    constructor(
      message: string,
      params: {
        code?: string;
        stdout?: string;
        stderr?: string;
        executable: string;
        cwd: string;
        exitCode?: number | null;
        signal?: NodeJS.Signals | null;
        timedOut?: boolean;
      }
    ) {
      super(message);
      this.code = params.code;
      this.stdout = params.stdout ?? "";
      this.stderr = params.stderr ?? "";
      this.executable = params.executable;
      this.cwd = params.cwd;
      this.exitCode = params.exitCode ?? null;
      this.signal = params.signal ?? null;
      this.timedOut = params.timedOut ?? false;
    }
  },
}));

vi.mock("../services/merge-quality-gates.js", () => ({
  getMergeQualityGateCommands: (...args: unknown[]) => mockGetMergeQualityGateCommands(...args),
  getMergeQualityGateExecutionPlan: (options?: {
    profile?: "default" | "deterministic";
    testRunId?: string;
    integrationWorkerCap?: number;
  }) =>
    (mockGetMergeQualityGateCommands() as string[]).map((command) => {
      if (command !== "npm run test" || options?.profile !== "deterministic") {
        return { command };
      }
      return {
        command,
        env: {
          OPENSPRINT_MERGE_GATE_TEST_MODE: "1",
          OPENSPRINT_VITEST_RUN_ID: options?.testRunId,
          OPENSPRINT_VITEST_INTEGRATION_MAX_WORKERS: String(options?.integrationWorkerCap ?? 2),
          NODE_ENV: "test",
        },
      };
    }),
}));

vi.mock("../services/validation-workspace.service.js", () => ({
  validationWorkspaceService: {
    createBaselineWorkspace: createBaselineWorkspaceMock,
  },
  ValidationWorkspaceService: class {
    async verifyWorkspaceHealth() {
      return { healthy: true, errors: [] };
    }
  },
}));

vi.mock("../services/event-log.service.js", () => ({
  eventLogService: {
    append: (...args: unknown[]) => mockEventAppend(...args),
    readForTask: (...args: unknown[]) => mockEventReadForTask(...args),
  },
}));

vi.mock("../services/notification.service.js", () => ({
  notificationService: {
    createAgentFailed: vi.fn().mockResolvedValue({
      id: "af-1",
      projectId: "proj-1",
      source: "execute",
      sourceId: "merge-quality-gate-baseline:main",
      questions: [],
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      kind: "agent_failed",
    }),
    listByProject: vi.fn().mockResolvedValue([]),
    resolve: vi.fn().mockResolvedValue(undefined),
    createApiBlocked: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
    resolveRateLimitNotifications: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: vi.fn(),
}));

vi.mock("../services/deploy-trigger.service.js", () => ({
  triggerDeployForEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/final-review.service.js", () => ({
  finalReviewService: {
    runFinalReview: vi.fn().mockResolvedValue(null),
    createTasksFromReview: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../services/self-improvement.service.js", () => ({
  selfImprovementService: {
    runIfDue: vi.fn().mockResolvedValue(undefined),
  },
}));

describe("Cross-service quality-gate regression integration", () => {
  const projectId = "proj-1";
  let repoPath: string;
  let worktreePath: string;
  let baselineWorktreePath: string;
  const taskId = "os-regression-1";
  const branchName = `opensprint/${taskId}`;
  const task = {
    id: taskId,
    title: "Regression integration task",
    status: "open",
    priority: 2,
    issue_type: "task",
    type: "task",
    labels: [],
    assignee: null,
    description: "",
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  };

  let previousNodeEnv: string | undefined;

  async function prepareWorkspace(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
    await fs.writeFile(path.join(dirPath, ".git"), "gitdir: /tmp/fake");
    await fs.writeFile(
      path.join(dirPath, "package.json"),
      JSON.stringify({ name: "test-workspace", private: true, scripts: { lint: "eslint ." } })
    );
    await fs.writeFile(
      path.join(dirPath, "package-lock.json"),
      JSON.stringify(
        {
          name: "test-workspace",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "test-workspace",
              private: true,
            },
          },
        },
        null,
        2
      )
    );
    await fs.mkdir(path.join(dirPath, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(dirPath, "node_modules", ".opensprint-test"), "ok");
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    repoPath = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-qg-repo-")));
    worktreePath = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-qg-worktree-"))
    );
    baselineWorktreePath = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-qg-baseline-"))
    );
    await Promise.all([
      prepareWorkspace(repoPath),
      prepareWorkspace(worktreePath),
      prepareWorkspace(baselineWorktreePath),
    ]);
    mockGetMergeQualityGateCommands.mockReturnValue(["npm run lint"]);
    mockEventAppend.mockResolvedValue(undefined);
    createBaselineWorkspaceMock.mockResolvedValue({
      kind: "baseline",
      worktreePath: baselineWorktreePath,
      branchName: null,
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(async () => {
    process.env.NODE_ENV = previousNodeEnv;
    await Promise.all([
      repoPath ? fs.rm(repoPath, { recursive: true, force: true }) : Promise.resolve(),
      worktreePath ? fs.rm(worktreePath, { recursive: true, force: true }) : Promise.resolve(),
      baselineWorktreePath
        ? fs.rm(baselineWorktreePath, { recursive: true, force: true })
        : Promise.resolve(),
    ]);
    vi.restoreAllMocks();
  });

  it("runs one repair cycle, blocks env-setup failures, and preserves structured diagnostics fields", async () => {
    const symlinkSpy = vi
      .spyOn(BranchManager.prototype, "symlinkNodeModules")
      .mockResolvedValue(undefined);

    let worktreeLintCalls = 0;
    mockRunCommand.mockImplementation(
      async (
        spec: { command: string; args?: string[] },
        options?: { cwd?: string; timeout?: number }
      ) => {
        const preflight = mergeGateToolchainPreflightOk(spec, options);
        if (preflight) return preflight;
        const command = [spec.command, ...(spec.args ?? [])].join(" ");
        if (command === "git rev-parse --verify HEAD") {
          return {
            stdout: "deadbeef",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? repoPath,
            exitCode: 0,
            signal: null,
          };
        }
        if (command === "npm run lint" && options?.cwd !== worktreePath) {
          return {
            stdout: "baseline ok",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? repoPath,
            exitCode: 0,
            signal: null,
          };
        }
        if (command === "npm run lint" && options?.cwd === worktreePath) {
          worktreeLintCalls += 1;
          throw {
            message: "Command failed: npm run lint",
            stderr: "Cannot find module 'eslint'",
            executable: spec.command,
            cwd: options?.cwd ?? worktreePath,
            exitCode: 1,
            signal: null,
          };
        }
        if (command === "npm ci" && options?.cwd === repoPath) {
          return {
            stdout: "added 1 package",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? repoPath,
            exitCode: 0,
            signal: null,
          };
        }
        throw new Error(`Unexpected command: ${command} (${options?.cwd ?? "no-cwd"})`);
      }
    );

    const slot: MergeSlot = {
      taskId,
      attempt: 1,
      worktreePath,
      branchName,
      phaseResult: {
        codingDiff: "",
        codingSummary: "Done",
        testResults: null,
        testOutput: "",
      },
      agent: { outputLog: [], startedAt: new Date().toISOString() },
    };
    const state = {
      slots: new Map([[taskId, slot]]),
      status: { totalDone: 0, totalFailed: 0, queueDepth: 0 },
      globalTimers: {} as never,
    };
    const updates: Array<Record<string, unknown>> = [];
    const mockTaskStoreUpdate = vi
      .fn()
      .mockImplementation(
        async (_projectId: string, _id: string, fields: Record<string, unknown>) => {
          updates.push(fields);
        }
      );

    const host: MergeCoordinatorHost = {
      getState: vi.fn().mockImplementation(() => state),
      taskStore: {
        close: vi.fn().mockResolvedValue(undefined),
        update: mockTaskStoreUpdate,
        comment: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        syncForPush: vi.fn().mockResolvedValue(undefined),
        listAll: vi.fn().mockResolvedValue([]),
        show: vi.fn().mockResolvedValue(task),
        setCumulativeAttempts: vi.fn().mockResolvedValue(undefined),
        getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(0),
        setConflictFiles: vi.fn().mockResolvedValue(undefined),
        setMergeStage: vi.fn().mockResolvedValue(undefined),
        planGetByEpicId: vi.fn().mockResolvedValue(null),
      },
      branchManager: {
        waitForGitReady: vi.fn().mockResolvedValue(undefined),
        commitWip: vi.fn().mockResolvedValue(undefined),
        prepareWorktreeForRemoval: vi.fn().mockResolvedValue(undefined),
        removeTaskWorktree: vi.fn().mockResolvedValue(undefined),
        deleteBranch: vi.fn().mockResolvedValue(undefined),
        getChangedFiles: vi.fn().mockResolvedValue([]),
        pushMain: vi.fn().mockResolvedValue(undefined),
        pushMainToOrigin: vi.fn().mockResolvedValue(undefined),
        isMergeInProgress: vi.fn().mockResolvedValue(false),
        mergeAbort: vi.fn().mockResolvedValue(undefined),
        mergeContinue: vi.fn().mockResolvedValue(undefined),
        rebaseAbort: vi.fn().mockResolvedValue(undefined),
        rebaseContinue: vi.fn().mockResolvedValue(undefined),
        getGitRev: vi
          .fn()
          .mockImplementation(async (_cwd: string, ref: string) =>
            ref === "HEAD" ? "headsha111" : "basesha222"
          ),
      },
      runMergerAgentAndWait: vi.fn().mockResolvedValue(false),
      runMergeQualityGates: (options) => runFixtureQualityGates(options),
      setBaselineRuntimeState: vi.fn().mockResolvedValue(undefined),
      sessionManager: {
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        archiveSession: vi.fn().mockResolvedValue(undefined),
      },
      fileScopeAnalyzer: {
        recordActual: vi.fn().mockResolvedValue(undefined),
      },
      feedbackService: {
        checkAutoResolveOnTaskDone: vi.fn().mockResolvedValue(undefined),
      },
      projectService: {
        getSettings: vi.fn().mockResolvedValue({
          simpleComplexityAgent: { type: "cursor", model: null },
          complexComplexityAgent: { type: "cursor", model: null },
          deployment: { mode: "custom" },
          gitWorkingMode: "worktree",
        }),
      },
      transition: vi.fn(),
      persistCounters: vi.fn().mockResolvedValue(undefined),
      nudge: vi.fn(),
    };

    const coordinator = new MergeCoordinatorService(host);
    await coordinator.performMergeAndDone(projectId, repoPath, task as never, branchName);

    expect(worktreeLintCalls).toBe(2);
    expect(
      mockRunCommand.mock.calls.filter(
        (call) => call[0]?.command === "npm" && call[0]?.args?.join(" ") === "ci"
      )
    ).toHaveLength(1);
    expect(symlinkSpy).toHaveBeenCalledTimes(1);
    expect(symlinkSpy).toHaveBeenCalledWith(repoPath, worktreePath);
    expect(mockTaskStoreUpdate).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({
        status: "open",
        extra: expect.objectContaining({
          failedGateCommand: "npm run lint",
          failedGateReason: "Command failed: npm run lint",
          failedGateOutputSnippet: "Cannot find module 'eslint'",
          worktreePath,
          qualityGateDetail: expect.objectContaining({
            command: "npm run lint",
            reason: "Command failed: npm run lint",
            outputSnippet: "Cannot find module 'eslint'",
            worktreePath,
            firstErrorLine: "Cannot find module 'eslint'",
          }),
        }),
      })
    );

    const loggedEvents = mockEventAppend.mock.calls.map(([, event]) => event);
    const mergeFailedEvent = loggedEvents.find((event) => event.event === "merge.failed");
    const taskBlockedEvent = loggedEvents.find((event) => event.event === "task.requeued");
    expect(mergeFailedEvent?.data).toEqual(
      expect.objectContaining({
        qualityGateCategory: "environment_setup",
        failedGateCommand: "npm run lint",
        qualityGateDetail: expect.objectContaining({
          command: "npm run lint",
          firstErrorLine: "Cannot find module 'eslint'",
        }),
      })
    );
    expect(taskBlockedEvent?.data).toEqual(
      expect.objectContaining({
        failedGateCommand: "npm run lint",
        nextAction: "Requeued for retry",
        qualityGateDetail: expect.objectContaining({
          command: "npm run lint",
          firstErrorLine: "Cannot find module 'eslint'",
        }),
      })
    );

    const blockedUpdate = updates.find((fields) => fields.status === "open");
    expect(blockedUpdate).toBeDefined();
    const blockedExtra = (blockedUpdate?.extra as Record<string, unknown>) ?? {};
    const diagnosticsTask = {
      ...task,
      status: "open",
      labels: ["attempts:1", "merge_stage:quality_gate"],
      ...blockedExtra,
    };

    mockEventReadForTask.mockResolvedValue(
      loggedEvents.map((event) => ({
        ...event,
        taskId,
        projectId,
      }))
    );

    const diagnosticsService = new TaskExecutionDiagnosticsService(
      {
        getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath }),
      } as never,
      {
        show: vi.fn().mockResolvedValue(diagnosticsTask),
        getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(1),
      } as never,
      {
        listSessions: vi.fn().mockResolvedValue([]),
      } as never
    );

    const diagnostics = await diagnosticsService.getDiagnostics(projectId, taskId);
    expect(diagnostics.latestSummary).toContain("Missing dependency:");
    const mergeFailedTimelineEntry = diagnostics.timeline.find((item) =>
      item.summary.includes("repair:")
    );
    expect(mergeFailedTimelineEntry?.summary).toMatch(/repair:.*failed/i);
    expect(mergeFailedTimelineEntry?.summary).not.toContain("category: environment_setup");
    expect(diagnostics.latestQualityGateDetail).toEqual(
      expect.objectContaining({
        command: "npm run lint",
        reason: "Command failed: npm run lint",
        outputSnippet: "Cannot find module 'eslint'",
        worktreePath,
        firstErrorLine: "Cannot find module 'eslint'",
        category: "environment_setup",
        validationWorkspace: "task_worktree",
        repairAttempted: true,
        repairSucceeded: false,
        userTitle: "Missing dependency",
        userSummary: expect.stringMatching(/required package could not be loaded/i),
      })
    );
  });

  it("requeues non-environment quality-gate failures without repair and persists structured details", async () => {
    const symlinkSpy = vi
      .spyOn(BranchManager.prototype, "symlinkNodeModules")
      .mockResolvedValue(undefined);

    let worktreeLintCalls = 0;
    mockRunCommand.mockImplementation(
      async (
        spec: { command: string; args?: string[] },
        options?: { cwd?: string; timeout?: number }
      ) => {
        const preflight = mergeGateToolchainPreflightOk(spec, options);
        if (preflight) return preflight;
        const command = [spec.command, ...(spec.args ?? [])].join(" ");
        if (command === "git rev-parse --verify HEAD") {
          return {
            stdout: "deadbeef",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? repoPath,
            exitCode: 0,
            signal: null,
          };
        }
        if (command === "npm run lint" && options?.cwd !== worktreePath) {
          return {
            stdout: "baseline ok",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? repoPath,
            exitCode: 0,
            signal: null,
          };
        }
        if (command === "npm run lint" && options?.cwd === worktreePath) {
          worktreeLintCalls += 1;
          throw {
            message: "Command failed: npm run lint",
            stderr: "src/foo.ts: error TS2304: Cannot find name 'x'",
            executable: spec.command,
            cwd: options?.cwd ?? worktreePath,
            exitCode: 1,
            signal: null,
          };
        }
        throw new Error(`Unexpected command: ${command} (${options?.cwd ?? "no-cwd"})`);
      }
    );

    const slot: MergeSlot = {
      taskId,
      attempt: 1,
      worktreePath,
      branchName,
      phaseResult: {
        codingDiff: "",
        codingSummary: "Done",
        testResults: null,
        testOutput: "",
      },
      agent: { outputLog: [], startedAt: new Date().toISOString() },
    };
    const state = {
      slots: new Map([[taskId, slot]]),
      status: { totalDone: 0, totalFailed: 0, queueDepth: 0 },
      globalTimers: {} as never,
    };
    const updates: Array<Record<string, unknown>> = [];
    const mockTaskStoreUpdate = vi
      .fn()
      .mockImplementation(
        async (_projectId: string, _id: string, fields: Record<string, unknown>) => {
          updates.push(fields);
        }
      );

    const host: MergeCoordinatorHost = {
      getState: vi.fn().mockImplementation(() => state),
      taskStore: {
        close: vi.fn().mockResolvedValue(undefined),
        update: mockTaskStoreUpdate,
        comment: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        syncForPush: vi.fn().mockResolvedValue(undefined),
        listAll: vi.fn().mockResolvedValue([]),
        show: vi.fn().mockResolvedValue(task),
        setCumulativeAttempts: vi.fn().mockResolvedValue(undefined),
        getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(0),
        setConflictFiles: vi.fn().mockResolvedValue(undefined),
        setMergeStage: vi.fn().mockResolvedValue(undefined),
        planGetByEpicId: vi.fn().mockResolvedValue(null),
      },
      branchManager: {
        waitForGitReady: vi.fn().mockResolvedValue(undefined),
        commitWip: vi.fn().mockResolvedValue(undefined),
        prepareWorktreeForRemoval: vi.fn().mockResolvedValue(undefined),
        removeTaskWorktree: vi.fn().mockResolvedValue(undefined),
        deleteBranch: vi.fn().mockResolvedValue(undefined),
        getChangedFiles: vi.fn().mockResolvedValue([]),
        pushMain: vi.fn().mockResolvedValue(undefined),
        pushMainToOrigin: vi.fn().mockResolvedValue(undefined),
        isMergeInProgress: vi.fn().mockResolvedValue(false),
        mergeAbort: vi.fn().mockResolvedValue(undefined),
        mergeContinue: vi.fn().mockResolvedValue(undefined),
        rebaseAbort: vi.fn().mockResolvedValue(undefined),
        rebaseContinue: vi.fn().mockResolvedValue(undefined),
        getGitRev: vi
          .fn()
          .mockImplementation(async (_cwd: string, ref: string) =>
            ref === "HEAD" ? "headsha111" : "basesha222"
          ),
      },
      runMergerAgentAndWait: vi.fn().mockResolvedValue(false),
      runMergeQualityGates: (options) => runFixtureQualityGates(options),
      setBaselineRuntimeState: vi.fn().mockResolvedValue(undefined),
      sessionManager: {
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        archiveSession: vi.fn().mockResolvedValue(undefined),
      },
      fileScopeAnalyzer: {
        recordActual: vi.fn().mockResolvedValue(undefined),
      },
      feedbackService: {
        checkAutoResolveOnTaskDone: vi.fn().mockResolvedValue(undefined),
      },
      projectService: {
        getSettings: vi.fn().mockResolvedValue({
          simpleComplexityAgent: { type: "cursor", model: null },
          complexComplexityAgent: { type: "cursor", model: null },
          deployment: { mode: "custom" },
          gitWorkingMode: "worktree",
        }),
      },
      transition: vi.fn(),
      persistCounters: vi.fn().mockResolvedValue(undefined),
      nudge: vi.fn(),
    };

    const coordinator = new MergeCoordinatorService(host);
    await coordinator.performMergeAndDone(projectId, repoPath, task as never, branchName);

    expect(worktreeLintCalls).toBe(1);
    expect(
      mockRunCommand.mock.calls.filter(
        (call) => call[0]?.command === "npm" && call[0]?.args?.join(" ") === "ci"
      )
    ).toHaveLength(0);
    expect(symlinkSpy).not.toHaveBeenCalled();
    expect(mockTaskStoreUpdate).toHaveBeenCalledWith(
      projectId,
      taskId,
      expect.objectContaining({
        status: "open",
        extra: expect.objectContaining({
          failedGateCommand: "npm run lint",
          failedGateReason: "Command failed: npm run lint",
          failedGateOutputSnippet: "src/foo.ts: error TS2304: Cannot find name 'x'",
          worktreePath,
          qualityGateDetail: expect.objectContaining({
            command: "npm run lint",
            reason: "Command failed: npm run lint",
            outputSnippet: "src/foo.ts: error TS2304: Cannot find name 'x'",
            worktreePath,
            firstErrorLine: "src/foo.ts: error TS2304: Cannot find name 'x'",
          }),
        }),
      })
    );

    const loggedEvents = mockEventAppend.mock.calls.map(([, event]) => event);
    const mergeFailedEvent = loggedEvents.find((event) => event.event === "merge.failed");
    const taskRequeuedEvent = loggedEvents.find((event) => event.event === "task.requeued");
    expect(mergeFailedEvent?.data).toEqual(
      expect.objectContaining({
        qualityGateCategory: "quality_gate",
        failedGateCommand: "npm run lint",
        failedGateReason: "Command failed: npm run lint",
        failedGateOutputSnippet: "src/foo.ts: error TS2304: Cannot find name 'x'",
        worktreePath,
        qualityGateDetail: expect.objectContaining({
          command: "npm run lint",
          firstErrorLine: "src/foo.ts: error TS2304: Cannot find name 'x'",
        }),
      })
    );
    expect(taskRequeuedEvent?.data).toEqual(
      expect.objectContaining({
        failedGateCommand: "npm run lint",
        failedGateReason: "Command failed: npm run lint",
        failedGateOutputSnippet: "src/foo.ts: error TS2304: Cannot find name 'x'",
        worktreePath,
        qualityGateDetail: expect.objectContaining({
          command: "npm run lint",
          firstErrorLine: "src/foo.ts: error TS2304: Cannot find name 'x'",
        }),
      })
    );

    const requeuedUpdate = updates.find((fields) => fields.status === "open");
    expect(requeuedUpdate).toBeDefined();
    const requeuedExtra = (requeuedUpdate?.extra as Record<string, unknown>) ?? {};
    const diagnosticsTask = {
      ...task,
      status: "open",
      labels: ["attempts:1", "merge_stage:quality_gate"],
      ...requeuedExtra,
    };

    mockEventReadForTask.mockResolvedValue(
      loggedEvents.map((event) => ({
        ...event,
        taskId,
        projectId,
      }))
    );

    const diagnosticsService = new TaskExecutionDiagnosticsService(
      {
        getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath }),
      } as never,
      {
        show: vi.fn().mockResolvedValue(diagnosticsTask),
        getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(1),
      } as never,
      {
        listSessions: vi.fn().mockResolvedValue([]),
      } as never
    );

    const diagnostics = await diagnosticsService.getDiagnostics(projectId, taskId);
    expect(diagnostics.latestSummary).toContain(
      "npm run lint: src/foo.ts: error TS2304: Cannot find name 'x'"
    );
    expect(diagnostics.latestSummary).not.toContain("repair:");
    expect(diagnostics.latestQualityGateDetail).toEqual(
      expect.objectContaining({
        command: "npm run lint",
        reason: "Command failed: npm run lint",
        outputSnippet: "src/foo.ts: error TS2304: Cannot find name 'x'",
        worktreePath,
        firstErrorLine: "src/foo.ts: error TS2304: Cannot find name 'x'",
        category: "quality_gate",
        validationWorkspace: "task_worktree",
        repairAttempted: false,
        repairSucceeded: false,
      })
    );
  });

  it("missing-symlink-source: host repo with no node_modules triggers repair that creates them, and gate passes", async () => {
    // Remove node_modules from the repo (simulates host with no deps)
    await fs.rm(path.join(repoPath, "node_modules"), { recursive: true, force: true });
    // worktreePath also has no node_modules (simulates broken symlink target)
    await fs.rm(path.join(worktreePath, "node_modules"), { recursive: true, force: true });

    const symlinkSpy = vi
      .spyOn(BranchManager.prototype, "symlinkNodeModules")
      .mockImplementation(async (_repo: string, wt: string) => {
        // Simulate successful symlink by creating node_modules at worktree
        const repoNm = path.join(_repo, "node_modules");
        try {
          await fs.access(repoNm);
          const nm = path.join(wt, "node_modules");
          await fs.mkdir(nm, { recursive: true });
          await fs.writeFile(path.join(nm, ".opensprint-test"), "ok");
        } catch {
          // repo has no node_modules yet — symlink would fail
        }
      });

    mockRunCommand.mockImplementation(
      async (
        spec: { command: string; args?: string[] },
        options?: { cwd?: string; timeout?: number }
      ) => {
        const preflight = mergeGateToolchainPreflightOk(spec, options);
        if (preflight) return preflight;
        const command = [spec.command, ...(spec.args ?? [])].join(" ");
        if (command === "git rev-parse --verify HEAD") {
          return {
            stdout: "deadbeef",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? repoPath,
            exitCode: 0,
            signal: null,
          };
        }
        if (command.startsWith("npm ls")) {
          return {
            stdout: "",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? repoPath,
            exitCode: 0,
            signal: null,
          };
        }
        if (command === "npm run lint" && options?.cwd !== worktreePath) {
          return {
            stdout: "baseline ok",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? repoPath,
            exitCode: 0,
            signal: null,
          };
        }
        if (command === "npm run lint" && options?.cwd === worktreePath) {
          return {
            stdout: "lint passed",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? worktreePath,
            exitCode: 0,
            signal: null,
          };
        }
        if (command === "npm ci") {
          // Simulate npm ci creating node_modules
          const cwd = options?.cwd ?? repoPath;
          const nm = path.join(cwd, "node_modules");
          await fs.mkdir(nm, { recursive: true });
          await fs.writeFile(path.join(nm, ".opensprint-test"), "ok");
          return {
            stdout: "added 42 packages",
            stderr: "",
            executable: spec.command,
            cwd,
            exitCode: 0,
            signal: null,
          };
        }
        throw new Error(`Unexpected command: ${command} (${options?.cwd ?? "no-cwd"})`);
      }
    );

    const slot: MergeSlot = {
      taskId,
      attempt: 1,
      worktreePath,
      branchName,
      phaseResult: { codingDiff: "", codingSummary: "Done", testResults: null, testOutput: "" },
      agent: { outputLog: [], startedAt: new Date().toISOString() },
    };
    const state = {
      slots: new Map([[taskId, slot]]),
      status: { totalDone: 0, totalFailed: 0, queueDepth: 0 },
      globalTimers: {} as never,
    };
    const updates: Array<Record<string, unknown>> = [];
    const mockTaskStoreUpdate = vi
      .fn()
      .mockImplementation(
        async (_projectId: string, _id: string, fields: Record<string, unknown>) => {
          updates.push(fields);
        }
      );

    const host: MergeCoordinatorHost = {
      getState: vi.fn().mockImplementation(() => state),
      taskStore: {
        close: vi.fn().mockResolvedValue(undefined),
        update: mockTaskStoreUpdate,
        comment: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        syncForPush: vi.fn().mockResolvedValue(undefined),
        listAll: vi.fn().mockResolvedValue([]),
        show: vi.fn().mockResolvedValue(task),
        setCumulativeAttempts: vi.fn().mockResolvedValue(undefined),
        getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(0),
        setConflictFiles: vi.fn().mockResolvedValue(undefined),
        setMergeStage: vi.fn().mockResolvedValue(undefined),
        planGetByEpicId: vi.fn().mockResolvedValue(null),
      },
      branchManager: {
        waitForGitReady: vi.fn().mockResolvedValue(undefined),
        commitWip: vi.fn().mockResolvedValue(undefined),
        prepareWorktreeForRemoval: vi.fn().mockResolvedValue(undefined),
        removeTaskWorktree: vi.fn().mockResolvedValue(undefined),
        deleteBranch: vi.fn().mockResolvedValue(undefined),
        getChangedFiles: vi.fn().mockResolvedValue([]),
        pushMain: vi.fn().mockResolvedValue(undefined),
        pushMainToOrigin: vi.fn().mockResolvedValue(undefined),
        isMergeInProgress: vi.fn().mockResolvedValue(false),
        mergeAbort: vi.fn().mockResolvedValue(undefined),
        mergeContinue: vi.fn().mockResolvedValue(undefined),
        rebaseAbort: vi.fn().mockResolvedValue(undefined),
        rebaseContinue: vi.fn().mockResolvedValue(undefined),
        getGitRev: vi
          .fn()
          .mockImplementation(async (_cwd: string, ref: string) =>
            ref === "HEAD" ? "headsha111" : "basesha222"
          ),
      },
      runMergerAgentAndWait: vi.fn().mockResolvedValue(false),
      runMergeQualityGates: (options) => runFixtureQualityGates(options),
      setBaselineRuntimeState: vi.fn().mockResolvedValue(undefined),
      sessionManager: {
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        archiveSession: vi.fn().mockResolvedValue(undefined),
      },
      fileScopeAnalyzer: { recordActual: vi.fn().mockResolvedValue(undefined) },
      feedbackService: { checkAutoResolveOnTaskDone: vi.fn().mockResolvedValue(undefined) },
      projectService: {
        getSettings: vi.fn().mockResolvedValue({
          simpleComplexityAgent: { type: "cursor", model: null },
          complexComplexityAgent: { type: "cursor", model: null },
          deployment: { mode: "custom" },
          gitWorkingMode: "worktree",
        }),
      },
      transition: vi.fn(),
      persistCounters: vi.fn().mockResolvedValue(undefined),
      nudge: vi.fn(),
    };

    const coordinator = new MergeCoordinatorService(host);
    await coordinator.performMergeAndDone(projectId, repoPath, task as never, branchName);

    // npm ci should have been called to install deps at repo root
    const npmCiCalls = mockRunCommand.mock.calls.filter(
      (call) => call[0]?.command === "npm" && call[0]?.args?.join(" ") === "ci"
    );
    expect(npmCiCalls.length).toBeGreaterThanOrEqual(1);

    // symlinkNodeModules should have been called during repair
    expect(symlinkSpy).toHaveBeenCalledWith(repoPath, worktreePath);

    // After repair, the quality gates should pass — no quality gate category failures
    const loggedEvents = mockEventAppend.mock.calls.map(([, event]) => event);
    const mergeFailedEvents = loggedEvents.filter((e) => e.event === "merge.failed");
    const qualityGateFailures = mergeFailedEvents.filter(
      (e: Record<string, unknown>) =>
        (e.data as Record<string, unknown>)?.qualityGateCategory != null
    );
    expect(qualityGateFailures).toHaveLength(0);

    // The task may still get requeued for merge-related reasons (since mergeToMain is not fully mocked),
    // but the quality gate node_modules repair should have succeeded
    const requeuedEvents = loggedEvents.filter((e) => e.event === "task.requeued");
    for (const requeued of requeuedEvents) {
      const data = requeued.data as Record<string, unknown> | undefined;
      expect(data?.qualityGateCategory ?? null).not.toBe("environment_setup");
    }
  });

  it("post-repair success: npm ci in worktree fallback + re-symlink when host becomes healthy", async () => {
    // Remove node_modules from both repo and worktree
    await fs.rm(path.join(repoPath, "node_modules"), { recursive: true, force: true });
    await fs.rm(path.join(worktreePath, "node_modules"), { recursive: true, force: true });

    const repoNpmCiFailed = true;
    vi.spyOn(BranchManager.prototype, "symlinkNodeModules").mockResolvedValue(undefined);

    mockRunCommand.mockImplementation(
      async (
        spec: { command: string; args?: string[] },
        options?: { cwd?: string; timeout?: number }
      ) => {
        const preflight = mergeGateToolchainPreflightOk(spec, options);
        if (preflight) return preflight;
        const command = [spec.command, ...(spec.args ?? [])].join(" ");
        if (command === "git rev-parse --verify HEAD") {
          return {
            stdout: "deadbeef",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? repoPath,
            exitCode: 0,
            signal: null,
          };
        }
        if (command.startsWith("npm ls")) {
          return {
            stdout: "",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? repoPath,
            exitCode: 0,
            signal: null,
          };
        }
        if (command === "npm run lint" && options?.cwd !== worktreePath) {
          return {
            stdout: "baseline ok",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? repoPath,
            exitCode: 0,
            signal: null,
          };
        }
        if (command === "npm run lint" && options?.cwd === worktreePath) {
          return {
            stdout: "lint passed",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? worktreePath,
            exitCode: 0,
            signal: null,
          };
        }
        if (command === "npm ci" && options?.cwd === repoPath && repoNpmCiFailed) {
          // First npm ci at repo root fails (e.g. network error)
          throw {
            message: "npm ci failed: network error",
            stderr: "npm ERR! network error",
            executable: spec.command,
            cwd: options.cwd,
            exitCode: 1,
            signal: null,
          };
        }
        if (command === "npm ci" && options?.cwd === worktreePath) {
          // npm ci in worktree succeeds
          const nm = path.join(worktreePath, "node_modules");
          await fs.mkdir(nm, { recursive: true });
          await fs.writeFile(path.join(nm, ".opensprint-test"), "ok");
          return {
            stdout: "added 42 packages",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? worktreePath,
            exitCode: 0,
            signal: null,
          };
        }
        throw new Error(`Unexpected command: ${command} (${options?.cwd ?? "no-cwd"})`);
      }
    );

    const slot: MergeSlot = {
      taskId,
      attempt: 1,
      worktreePath,
      branchName,
      phaseResult: { codingDiff: "", codingSummary: "Done", testResults: null, testOutput: "" },
      agent: { outputLog: [], startedAt: new Date().toISOString() },
    };
    const state = {
      slots: new Map([[taskId, slot]]),
      status: { totalDone: 0, totalFailed: 0, queueDepth: 0 },
      globalTimers: {} as never,
    };
    const mockTaskStoreUpdate = vi.fn().mockResolvedValue(undefined);

    const host: MergeCoordinatorHost = {
      getState: vi.fn().mockImplementation(() => state),
      taskStore: {
        close: vi.fn().mockResolvedValue(undefined),
        update: mockTaskStoreUpdate,
        comment: vi.fn().mockResolvedValue(undefined),
        sync: vi.fn().mockResolvedValue(undefined),
        syncForPush: vi.fn().mockResolvedValue(undefined),
        listAll: vi.fn().mockResolvedValue([]),
        show: vi.fn().mockResolvedValue(task),
        setCumulativeAttempts: vi.fn().mockResolvedValue(undefined),
        getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(0),
        setConflictFiles: vi.fn().mockResolvedValue(undefined),
        setMergeStage: vi.fn().mockResolvedValue(undefined),
        planGetByEpicId: vi.fn().mockResolvedValue(null),
      },
      branchManager: {
        waitForGitReady: vi.fn().mockResolvedValue(undefined),
        commitWip: vi.fn().mockResolvedValue(undefined),
        prepareWorktreeForRemoval: vi.fn().mockResolvedValue(undefined),
        removeTaskWorktree: vi.fn().mockResolvedValue(undefined),
        deleteBranch: vi.fn().mockResolvedValue(undefined),
        getChangedFiles: vi.fn().mockResolvedValue([]),
        pushMain: vi.fn().mockResolvedValue(undefined),
        pushMainToOrigin: vi.fn().mockResolvedValue(undefined),
        isMergeInProgress: vi.fn().mockResolvedValue(false),
        mergeAbort: vi.fn().mockResolvedValue(undefined),
        mergeContinue: vi.fn().mockResolvedValue(undefined),
        rebaseAbort: vi.fn().mockResolvedValue(undefined),
        rebaseContinue: vi.fn().mockResolvedValue(undefined),
        getGitRev: vi
          .fn()
          .mockImplementation(async (_cwd: string, ref: string) =>
            ref === "HEAD" ? "headsha111" : "basesha222"
          ),
      },
      runMergerAgentAndWait: vi.fn().mockResolvedValue(false),
      runMergeQualityGates: (options) => runFixtureQualityGates(options),
      setBaselineRuntimeState: vi.fn().mockResolvedValue(undefined),
      sessionManager: {
        createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
        archiveSession: vi.fn().mockResolvedValue(undefined),
      },
      fileScopeAnalyzer: { recordActual: vi.fn().mockResolvedValue(undefined) },
      feedbackService: { checkAutoResolveOnTaskDone: vi.fn().mockResolvedValue(undefined) },
      projectService: {
        getSettings: vi.fn().mockResolvedValue({
          simpleComplexityAgent: { type: "cursor", model: null },
          complexComplexityAgent: { type: "cursor", model: null },
          deployment: { mode: "custom" },
          gitWorkingMode: "worktree",
        }),
      },
      transition: vi.fn(),
      persistCounters: vi.fn().mockResolvedValue(undefined),
      nudge: vi.fn(),
    };

    const coordinator = new MergeCoordinatorService(host);
    await coordinator.performMergeAndDone(projectId, repoPath, task as never, branchName);

    // npm ci at worktree should have been called as fallback
    const worktreeNpmCiCalls = mockRunCommand.mock.calls.filter(
      (call) =>
        call[0]?.command === "npm" &&
        call[0]?.args?.join(" ") === "ci" &&
        call[1]?.cwd === worktreePath
    );
    expect(worktreeNpmCiCalls.length).toBeGreaterThanOrEqual(1);

    // node_modules should exist in the worktree after repair
    const nodeModulesExists = await fs
      .access(path.join(worktreePath, "node_modules"))
      .then(() => true)
      .catch(() => false);
    expect(nodeModulesExists).toBe(true);

    // The gate should have passed — no quality gate failures should be reported
    const loggedEvents = mockEventAppend.mock.calls.map(([, event]) => event);
    const qualityGateFailures = loggedEvents.filter(
      (e) =>
        e.event === "merge.failed" &&
        (e.data as Record<string, unknown>)?.qualityGateCategory != null
    );
    expect(qualityGateFailures).toHaveLength(0);
  });

  describe("merged_candidate: node_modules missing + npm ci repair regression", () => {
    it("merged_candidate with no node_modules triggers precheck failure that leads to auto-repair", async () => {
      await fs.rm(path.join(worktreePath, "node_modules"), { recursive: true, force: true });

      let repairNpmCiCalled = false;
      const symlinkSpy = vi
        .spyOn(BranchManager.prototype, "symlinkNodeModules")
        .mockImplementation(async (_repo: string, wt: string) => {
          const repoNm = path.join(_repo, "node_modules");
          try {
            await fs.access(repoNm);
            const nm = path.join(wt, "node_modules");
            await fs.mkdir(nm, { recursive: true });
            await fs.writeFile(path.join(nm, ".opensprint-test"), "ok");
          } catch {
            // repo has no node_modules — symlink would fail
          }
        });

      mockRunCommand.mockImplementation(
        async (
          spec: { command: string; args?: string[] },
          options?: { cwd?: string; timeout?: number }
        ) => {
          const preflight = mergeGateToolchainPreflightOk(spec, options);
          if (preflight) return preflight;
          const command = [spec.command, ...(spec.args ?? [])].join(" ");
          if (command === "git rev-parse --verify HEAD") {
            return {
              stdout: "deadbeef",
              stderr: "",
              executable: spec.command,
              cwd: options?.cwd ?? repoPath,
              exitCode: 0,
              signal: null,
            };
          }
          if (command.startsWith("npm ls")) {
            return {
              stdout: "",
              stderr: "",
              executable: spec.command,
              cwd: options?.cwd ?? repoPath,
              exitCode: 0,
              signal: null,
            };
          }
          if (command === "npm run lint" && options?.cwd !== worktreePath) {
            return {
              stdout: "baseline ok",
              stderr: "",
              executable: spec.command,
              cwd: options?.cwd ?? repoPath,
              exitCode: 0,
              signal: null,
            };
          }
          if (command === "npm run lint" && options?.cwd === worktreePath) {
            return {
              stdout: "lint passed",
              stderr: "",
              executable: spec.command,
              cwd: options?.cwd ?? worktreePath,
              exitCode: 0,
              signal: null,
            };
          }
          if (command === "npm ci") {
            repairNpmCiCalled = true;
            return {
              stdout: "added 10 packages",
              stderr: "",
              executable: spec.command,
              cwd: options?.cwd ?? repoPath,
              exitCode: 0,
              signal: null,
            };
          }
          throw new Error(`Unexpected command: ${command} (${options?.cwd ?? "no-cwd"})`);
        }
      );

      const slot: MergeSlot = {
        taskId,
        attempt: 1,
        worktreePath,
        branchName,
        phaseResult: { codingDiff: "", codingSummary: "Done", testResults: null, testOutput: "" },
        agent: { outputLog: [], startedAt: new Date().toISOString() },
      };
      const state = {
        slots: new Map([[taskId, slot]]),
        status: { totalDone: 0, totalFailed: 0, queueDepth: 0 },
        globalTimers: {} as never,
      };
      const mockTaskStoreUpdate = vi.fn().mockResolvedValue(undefined);

      const host: MergeCoordinatorHost = {
        getState: vi.fn().mockImplementation(() => state),
        taskStore: {
          close: vi.fn().mockResolvedValue(undefined),
          update: mockTaskStoreUpdate,
          comment: vi.fn().mockResolvedValue(undefined),
          sync: vi.fn().mockResolvedValue(undefined),
          syncForPush: vi.fn().mockResolvedValue(undefined),
          listAll: vi.fn().mockResolvedValue([]),
          show: vi.fn().mockResolvedValue(task),
          setCumulativeAttempts: vi.fn().mockResolvedValue(undefined),
          getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(0),
          setConflictFiles: vi.fn().mockResolvedValue(undefined),
          setMergeStage: vi.fn().mockResolvedValue(undefined),
          planGetByEpicId: vi.fn().mockResolvedValue(null),
        },
        branchManager: {
          waitForGitReady: vi.fn().mockResolvedValue(undefined),
          commitWip: vi.fn().mockResolvedValue(undefined),
          prepareWorktreeForRemoval: vi.fn().mockResolvedValue(undefined),
          removeTaskWorktree: vi.fn().mockResolvedValue(undefined),
          deleteBranch: vi.fn().mockResolvedValue(undefined),
          getChangedFiles: vi.fn().mockResolvedValue([]),
          pushMain: vi.fn().mockResolvedValue(undefined),
          pushMainToOrigin: vi.fn().mockResolvedValue(undefined),
          isMergeInProgress: vi.fn().mockResolvedValue(false),
          mergeAbort: vi.fn().mockResolvedValue(undefined),
          mergeContinue: vi.fn().mockResolvedValue(undefined),
          rebaseAbort: vi.fn().mockResolvedValue(undefined),
          rebaseContinue: vi.fn().mockResolvedValue(undefined),
          getGitRev: vi
            .fn()
            .mockImplementation(async (_cwd: string, ref: string) =>
              ref === "HEAD" ? "headsha111" : "basesha222"
            ),
        },
        runMergerAgentAndWait: vi.fn().mockResolvedValue(false),
        runMergeQualityGates: (options) => runFixtureQualityGates(options),
        setBaselineRuntimeState: vi.fn().mockResolvedValue(undefined),
        sessionManager: {
          createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
          archiveSession: vi.fn().mockResolvedValue(undefined),
        },
        fileScopeAnalyzer: { recordActual: vi.fn().mockResolvedValue(undefined) },
        feedbackService: { checkAutoResolveOnTaskDone: vi.fn().mockResolvedValue(undefined) },
        projectService: {
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null },
            complexComplexityAgent: { type: "cursor", model: null },
            deployment: { mode: "custom" },
            gitWorkingMode: "worktree",
          }),
        },
        transition: vi.fn(),
        persistCounters: vi.fn().mockResolvedValue(undefined),
        nudge: vi.fn(),
      };

      const coordinator = new MergeCoordinatorService(host);
      await coordinator.performMergeAndDone(projectId, repoPath, task as never, branchName);

      expect(repairNpmCiCalled).toBe(true);
      expect(symlinkSpy).toHaveBeenCalledWith(repoPath, worktreePath);

      const loggedEvents = mockEventAppend.mock.calls.map(([, event]) => event);
      const qualityGateFailures = loggedEvents.filter(
        (e) =>
          e.event === "merge.failed" &&
          (e.data as Record<string, unknown>)?.qualityGateCategory === "environment_setup"
      );
      expect(qualityGateFailures).toHaveLength(0);
    });

    it("merged_candidate npm ci repair failure surfaces actionable error with stderr in diagnostics", async () => {
      await fs.rm(path.join(repoPath, "node_modules"), { recursive: true, force: true });
      await fs.rm(path.join(worktreePath, "node_modules"), { recursive: true, force: true });

      vi.spyOn(BranchManager.prototype, "symlinkNodeModules").mockResolvedValue(undefined);

      const npmCiStderr =
        'npm ERR! code ERESOLVE\nnpm ERR! Could not resolve dependency:\nnpm ERR! peer react@"^17" from react-dom@17.0.2';
      mockRunCommand.mockImplementation(
        async (
          spec: { command: string; args?: string[] },
          options?: { cwd?: string; timeout?: number }
        ) => {
          const preflight = mergeGateToolchainPreflightOk(spec, options);
          if (preflight) return preflight;
          const command = [spec.command, ...(spec.args ?? [])].join(" ");
          if (command === "git rev-parse --verify HEAD") {
            return {
              stdout: "deadbeef",
              stderr: "",
              executable: spec.command,
              cwd: options?.cwd ?? repoPath,
              exitCode: 0,
              signal: null,
            };
          }
          if (command.startsWith("npm ls")) {
            return {
              stdout: "",
              stderr: "",
              executable: spec.command,
              cwd: options?.cwd ?? repoPath,
              exitCode: 0,
              signal: null,
            };
          }
          if (command === "npm run lint" && options?.cwd !== worktreePath) {
            return {
              stdout: "baseline ok",
              stderr: "",
              executable: spec.command,
              cwd: options?.cwd ?? repoPath,
              exitCode: 0,
              signal: null,
            };
          }
          if (command === "npm ci") {
            throw {
              message: "npm ci failed: ERESOLVE",
              stderr: npmCiStderr,
              stdout: "",
              executable: spec.command,
              cwd: options?.cwd ?? repoPath,
              exitCode: 1,
              signal: null,
            };
          }
          if (command === "npm run lint" && options?.cwd === worktreePath) {
            throw {
              message: "Command failed: npm run lint",
              stderr: "Cannot find module 'eslint'",
              executable: spec.command,
              cwd: options?.cwd ?? worktreePath,
              exitCode: 1,
              signal: null,
            };
          }
          throw new Error(`Unexpected command: ${command} (${options?.cwd ?? "no-cwd"})`);
        }
      );

      const slot: MergeSlot = {
        taskId,
        attempt: 1,
        worktreePath,
        branchName,
        phaseResult: { codingDiff: "", codingSummary: "Done", testResults: null, testOutput: "" },
        agent: { outputLog: [], startedAt: new Date().toISOString() },
      };
      const state = {
        slots: new Map([[taskId, slot]]),
        status: { totalDone: 0, totalFailed: 0, queueDepth: 0 },
        globalTimers: {} as never,
      };
      const updates: Array<Record<string, unknown>> = [];
      const mockTaskStoreUpdate = vi
        .fn()
        .mockImplementation(
          async (_projectId: string, _id: string, fields: Record<string, unknown>) => {
            updates.push(fields);
          }
        );

      const host: MergeCoordinatorHost = {
        getState: vi.fn().mockImplementation(() => state),
        taskStore: {
          close: vi.fn().mockResolvedValue(undefined),
          update: mockTaskStoreUpdate,
          comment: vi.fn().mockResolvedValue(undefined),
          sync: vi.fn().mockResolvedValue(undefined),
          syncForPush: vi.fn().mockResolvedValue(undefined),
          listAll: vi.fn().mockResolvedValue([]),
          show: vi.fn().mockResolvedValue(task),
          setCumulativeAttempts: vi.fn().mockResolvedValue(undefined),
          getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(0),
          setConflictFiles: vi.fn().mockResolvedValue(undefined),
          setMergeStage: vi.fn().mockResolvedValue(undefined),
          planGetByEpicId: vi.fn().mockResolvedValue(null),
        },
        branchManager: {
          waitForGitReady: vi.fn().mockResolvedValue(undefined),
          commitWip: vi.fn().mockResolvedValue(undefined),
          prepareWorktreeForRemoval: vi.fn().mockResolvedValue(undefined),
          removeTaskWorktree: vi.fn().mockResolvedValue(undefined),
          deleteBranch: vi.fn().mockResolvedValue(undefined),
          getChangedFiles: vi.fn().mockResolvedValue([]),
          pushMain: vi.fn().mockResolvedValue(undefined),
          pushMainToOrigin: vi.fn().mockResolvedValue(undefined),
          isMergeInProgress: vi.fn().mockResolvedValue(false),
          mergeAbort: vi.fn().mockResolvedValue(undefined),
          mergeContinue: vi.fn().mockResolvedValue(undefined),
          rebaseAbort: vi.fn().mockResolvedValue(undefined),
          rebaseContinue: vi.fn().mockResolvedValue(undefined),
          getGitRev: vi
            .fn()
            .mockImplementation(async (_cwd: string, ref: string) =>
              ref === "HEAD" ? "headsha111" : "basesha222"
            ),
        },
        runMergerAgentAndWait: vi.fn().mockResolvedValue(false),
        runMergeQualityGates: (options) => runFixtureQualityGates(options),
        setBaselineRuntimeState: vi.fn().mockResolvedValue(undefined),
        sessionManager: {
          createSession: vi.fn().mockResolvedValue({ id: "sess-1" }),
          archiveSession: vi.fn().mockResolvedValue(undefined),
        },
        fileScopeAnalyzer: { recordActual: vi.fn().mockResolvedValue(undefined) },
        feedbackService: { checkAutoResolveOnTaskDone: vi.fn().mockResolvedValue(undefined) },
        projectService: {
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null },
            complexComplexityAgent: { type: "cursor", model: null },
            deployment: { mode: "custom" },
            gitWorkingMode: "worktree",
          }),
        },
        transition: vi.fn(),
        persistCounters: vi.fn().mockResolvedValue(undefined),
        nudge: vi.fn(),
      };

      const coordinator = new MergeCoordinatorService(host);
      await coordinator.performMergeAndDone(projectId, repoPath, task as never, branchName);

      const loggedEvents = mockEventAppend.mock.calls.map(([, event]) => event);
      const mergeFailedEvent = loggedEvents.find((event) => event.event === "merge.failed");
      expect(mergeFailedEvent).toBeDefined();
      expect(mergeFailedEvent?.data?.qualityGateCategory).toBe("environment_setup");

      const requeuedUpdate = updates.find((fields) => fields.status === "open");
      expect(requeuedUpdate).toBeDefined();
      const extra = requeuedUpdate?.extra as Record<string, unknown>;
      const qualityGateDetail = extra?.qualityGateDetail as Record<string, unknown> | undefined;
      expect(qualityGateDetail?.category).toBe("environment_setup");

      mockEventReadForTask.mockResolvedValue(
        loggedEvents.map((event) => ({ ...event, taskId, projectId }))
      );

      const diagnosticsTask = {
        ...task,
        status: "open",
        labels: ["attempts:1", "merge_stage:quality_gate"],
        ...extra,
      };

      const diagnosticsService = new TaskExecutionDiagnosticsService(
        { getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath }) } as never,
        {
          show: vi.fn().mockResolvedValue(diagnosticsTask),
          getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(1),
        } as never,
        { listSessions: vi.fn().mockResolvedValue([]) } as never
      );

      const diagnostics = await diagnosticsService.getDiagnostics(projectId, taskId);
      expect(diagnostics.latestQualityGateDetail).toEqual(
        expect.objectContaining({
          category: "environment_setup",
          repairAttempted: true,
          repairSucceeded: false,
        })
      );
    });
  });

  it("applies deterministic merge-gate env policy consistently across task and merged-candidate workspaces", async () => {
    await fs.writeFile(
      path.join(repoPath, "package.json"),
      JSON.stringify({ name: "test-workspace", private: true, scripts: { test: "vitest run" } })
    );
    await fs.writeFile(
      path.join(worktreePath, "package.json"),
      JSON.stringify({ name: "test-workspace", private: true, scripts: { test: "vitest run" } })
    );

    mockGetMergeQualityGateCommands.mockReturnValue(["npm run test"]);
    const observedEnvs: Array<Record<string, string | undefined>> = [];
    mockRunCommand.mockImplementation(
      async (
        spec: { command: string; args?: string[] },
        options?: { cwd?: string; timeout?: number; env?: Record<string, string | undefined> }
      ) => {
        const preflight = mergeGateToolchainPreflightOk(spec, options);
        if (preflight) return preflight;
        const command = [spec.command, ...(spec.args ?? [])].join(" ");
        if (command === "git rev-parse --verify HEAD") {
          return {
            stdout: "deadbeef",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? repoPath,
            exitCode: 0,
            signal: null,
          };
        }
        if (command.startsWith("npm ls")) {
          return {
            stdout: "",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? repoPath,
            exitCode: 0,
            signal: null,
          };
        }
        if (command === "npm run test") {
          observedEnvs.push(options?.env ?? {});
          return {
            stdout: "ok",
            stderr: "",
            executable: spec.command,
            cwd: options?.cwd ?? repoPath,
            exitCode: 0,
            signal: null,
          };
        }
        throw new Error(`Unexpected command: ${command} (${options?.cwd ?? "no-cwd"})`);
      }
    );

    await runFixtureQualityGates({
      projectId,
      repoPath,
      worktreePath,
      taskId,
      branchName,
      baseBranch: "main",
      validationWorkspace: "task_worktree",
    });
    await runFixtureQualityGates({
      projectId,
      repoPath,
      worktreePath,
      taskId,
      branchName,
      baseBranch: "main",
      validationWorkspace: "merged_candidate",
    });

    expect(observedEnvs).toHaveLength(2);
    for (const env of observedEnvs) {
      expect(env.OPENSPRINT_MERGE_GATE_TEST_MODE).toBe("1");
      expect(env.OPENSPRINT_VITEST_INTEGRATION_MAX_WORKERS).toBe("2");
      expect(env.OPENSPRINT_VITEST_RUN_ID).toMatch(/^mergegate_/);
      expect(env.NODE_ENV).toBe("test");
    }
  });
});
