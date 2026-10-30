import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (a: unknown, b: unknown) => [a, b],
}));
vi.mock("../db/drizzle-schema-pg.js", () => ({ plansTable: {}, planVersionsTable: {} }));
import type { StoredTask } from "../services/task-store.service.js";
import {
  OrchestratorDispatchService,
  type DispatchSlotLike,
  type DispatchStateLike,
  type OrchestratorDispatchHost,
} from "../services/orchestrator-dispatch.service.js";

const mockResolveBaseBranch = vi.fn().mockResolvedValue("main");

vi.mock("../utils/git-repo-state.js", () => ({
  resolveBaseBranch: (...args: unknown[]) => mockResolveBaseBranch(...args),
}));

const mockAcquireLease = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/worktree-lease.service.js", () => ({
  worktreeLeaseService: {
    acquire: (...args: unknown[]) => mockAcquireLease(...args),
  },
}));

const mockTransition = vi.fn().mockReturnValue(true);
vi.mock("../services/worktree-registry.js", () => ({
  worktreeRegistry: {
    transition: (...args: unknown[]) => mockTransition(...args),
  },
}));

describe("OrchestratorDispatchService", () => {
  const projectId = "proj-1";
  const repoPath = "/tmp/repo";
  let state: DispatchStateLike;
  let taskStore: {
    update: ReturnType<typeof vi.fn>;
    getCumulativeAttemptsFromIssue: ReturnType<typeof vi.fn>;
    listAll: ReturnType<typeof vi.fn>;
  };
  let executeCodingPhase: ReturnType<typeof vi.fn>;
  let performMergeRetry: ReturnType<typeof vi.fn>;
  let host: OrchestratorDispatchHost;
  let service: OrchestratorDispatchService;

  const baseTask = (id: string): StoredTask =>
    ({
      id,
      title: `Task ${id}`,
      status: "open",
      priority: 2,
      issue_type: "task",
      assignee: null,
      labels: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      dependencies: [],
      dependent_count: 0,
    }) as StoredTask;

  beforeEach(() => {
    mockAcquireLease.mockClear();
    mockAcquireLease.mockResolvedValue(undefined);
    mockTransition.mockClear();
    mockTransition.mockReturnValue(true);
    state = { nextCoderIndex: 0, status: { queueDepth: 0 }, slots: new Map() };
    taskStore = {
      update: vi.fn().mockResolvedValue(undefined),
      getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(0),
      listAll: vi.fn().mockResolvedValue([]),
    };
    executeCodingPhase = vi.fn().mockResolvedValue(undefined);
    performMergeRetry = vi.fn().mockResolvedValue(undefined);
    host = {
      getState: vi.fn().mockReturnValue(state),
      createSlot: vi.fn().mockImplementation(
        (
          taskId: string,
          taskTitle: string | null,
          branchName: string,
          attempt: number,
          assignee?: string,
          worktreeKey?: string
        ) =>
          ({
            taskId,
            taskTitle,
            branchName,
            attempt,
            assignee,
            worktreeKey,
            worktreePath: null,
          }) as DispatchSlotLike
      ),
      transition: vi.fn(),
      persistCounters: vi.fn().mockResolvedValue(undefined),
      getTaskStore: vi.fn().mockReturnValue(taskStore),
      getProjectService: vi
        .fn()
        .mockReturnValue({ getSettings: vi.fn().mockResolvedValue({ mergeStrategy: "per_task" }) }),
      getBranchManager: vi.fn().mockReturnValue({
        ensureOnMain: vi.fn().mockResolvedValue(undefined),
        getWorktreePath: vi.fn().mockImplementation((key: string) => `/tmp/repo/.worktrees/${key}`),
        prepareWorktreeForRemoval: vi.fn().mockResolvedValue(undefined),
        removeTaskWorktree: vi.fn().mockResolvedValue(undefined),
        createTaskWorktree: vi
          .fn()
          .mockImplementation(
            (
              _repoPath: string,
              taskId: string,
              _baseBranch: string,
              opts?: { worktreeKey?: string }
            ) => Promise.resolve(`/tmp/repo/.worktrees/${opts?.worktreeKey ?? taskId}`)
          ),
      }),
      getFileScopeAnalyzer: vi
        .fn()
        .mockReturnValue({ predict: vi.fn().mockResolvedValue({ modify: ["a.ts"] }) }),
      executeCodingPhase,
      performMergeRetry,
    };
    service = new OrchestratorDispatchService(host);
  });

  it("hydrates persisted retry context and passes it to coding phase on redispatch", async () => {
    const task = {
      ...baseTask("os-1234"),
      next_retry_context: {
        previousFailure: "Review rejected: missing endpoint",
        reviewFeedback: "Implement POST /mark-complete and update plan status derivation.",
        previousTestOutput: "FAIL api test",
        previousTestFailures: "- api should return 200",
        previousDiff: "diff --git a/file b/file",
        failureType: "review_rejection",
      },
    } as StoredTask;

    await service.dispatchTask(projectId, repoPath, task, 3);

    expect(taskStore.update).toHaveBeenCalledWith(
      projectId,
      task.id,
      expect.objectContaining({
        status: "in_progress",
        assignee: expect.any(String),
        extra: { next_retry_context: null },
      })
    );
    expect(executeCodingPhase).toHaveBeenCalledWith(
      projectId,
      repoPath,
      task,
      expect.objectContaining({ taskId: task.id }),
      expect.objectContaining({
        previousFailure: "Review rejected: missing endpoint",
        reviewFeedback: "Implement POST /mark-complete and update plan status derivation.",
        failureType: "review_rejection",
        useExistingBranch: false,
      })
    );
  });

  it("uses valid persisted retry fields even if some fields are malformed", async () => {
    const task = {
      ...baseTask("os-5678"),
      next_retry_context: {
        previousFailure: "Review rejected",
        failureType: "not_a_real_failure_type",
      },
    } as StoredTask;

    await service.dispatchTask(projectId, repoPath, task, 1);

    const updateArg = taskStore.update.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(updateArg.extra).toEqual({ next_retry_context: null });
    expect(executeCodingPhase).toHaveBeenCalledWith(
      projectId,
      repoPath,
      task,
      expect.objectContaining({ taskId: task.id }),
      expect.objectContaining({
        previousFailure: "Review rejected",
        useExistingBranch: false,
      })
    );
  });

  it("accepts environment_setup as a persisted retry failure type", async () => {
    const task = {
      ...baseTask("os-9012"),
      next_retry_context: {
        previousFailure: "Pre-merge quality gate failed due missing modules",
        failureType: "environment_setup",
      },
    } as StoredTask;

    await service.dispatchTask(projectId, repoPath, task, 1);

    expect(executeCodingPhase).toHaveBeenCalledWith(
      projectId,
      repoPath,
      task,
      expect.objectContaining({ taskId: task.id }),
      expect.objectContaining({
        previousFailure: "Pre-merge quality gate failed due missing modules",
        failureType: "environment_setup",
        useExistingBranch: false,
      })
    );
  });

  it("hydrates structured quality-gate detail from task fields for redispatch", async () => {
    const task = {
      ...baseTask("os-9013"),
      next_retry_context: {
        previousFailure: "Pre-merge quality gate failed",
        failureType: "merge_quality_gate",
      },
      failedGateCommand: "npm run test",
      failedGateReason: "Command failed: npm run test",
      failedGateOutputSnippet: "AssertionError: expected 401 to be 403",
      qualityGateDetail: {
        command: "npm run test",
        reason: "Command failed: npm run test",
        outputSnippet: "AssertionError: expected 401 to be 403",
        firstErrorLine: "AssertionError: expected 401 to be 403",
        worktreePath: "/tmp/repo/.worktrees/os-9013",
      },
    } as StoredTask;

    await service.dispatchTask(projectId, repoPath, task, 1);

    expect(executeCodingPhase).toHaveBeenCalledWith(
      projectId,
      repoPath,
      task,
      expect.objectContaining({ taskId: task.id }),
      expect.objectContaining({
        previousFailure: "Pre-merge quality gate failed",
        failureType: "merge_quality_gate",
        qualityGateDetail: expect.objectContaining({
          command: "npm run test",
          firstErrorLine: "AssertionError: expected 401 to be 403",
          worktreePath: "/tmp/repo/.worktrees/os-9013",
        }),
        useExistingBranch: false,
      })
    );
  });

  it("extracts quality gate detail from task extra on first dispatch (no retry context)", async () => {
    const task = {
      ...baseTask("os-qg-first"),
      failedGateCommand: "npm run test",
      failedGateReason: "Tests failed: 1 failed, 100 passed",
      firstErrorLine: "AssertionError: expected spy to be called at test.ts:42",
    } as StoredTask;

    await service.dispatchTask(projectId, repoPath, task, 1);

    expect(executeCodingPhase).toHaveBeenCalledWith(
      projectId,
      repoPath,
      task,
      expect.objectContaining({ taskId: task.id }),
      expect.objectContaining({
        qualityGateDetail: expect.objectContaining({
          command: "npm run test",
          reason: "Tests failed: 1 failed, 100 passed",
          firstErrorLine: "AssertionError: expected spy to be called at test.ts:42",
        }),
        useExistingBranch: false,
      })
    );
  });

  it("populates slot.worktreePath from BranchManager in default worktree mode", async () => {
    const task = baseTask("os-wt01");
    await service.dispatchTask(projectId, repoPath, task, 0);

    const slot = executeCodingPhase.mock.calls[0]?.[3] as DispatchSlotLike;
    expect(slot.worktreePath).toBe("/tmp/repo/.worktrees/os-wt01");
    expect(host.getBranchManager().getWorktreePath).toHaveBeenCalledWith("os-wt01", repoPath);
  });

  it("acquires a DB worktree lease and transitions registry to in_use in worktree mode", async () => {
    const task = baseTask("os-lease");
    await service.dispatchTask(projectId, repoPath, task, 0);

    expect(mockAcquireLease).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeKey: task.id,
        taskId: task.id,
        projectId,
      })
    );
    expect(mockTransition).toHaveBeenCalledWith(task.id, "in_use");
  });

  it("retries worktree lease acquire once after a failure", async () => {
    mockAcquireLease
      .mockRejectedValueOnce(new Error("db transient"))
      .mockResolvedValueOnce(undefined);
    const task = baseTask("os-retry");
    await service.dispatchTask(projectId, repoPath, task, 0);

    expect(mockAcquireLease).toHaveBeenCalledTimes(2);
    expect(mockTransition).toHaveBeenCalledWith(task.id, "in_use");
  });

  it("sets slot.worktreePath to repoPath in branches mode", async () => {
    (
      host.getProjectService() as { getSettings: ReturnType<typeof vi.fn> }
    ).getSettings.mockResolvedValueOnce({ mergeStrategy: "per_task", gitWorkingMode: "branches" });

    const task = baseTask("os-br01");
    await service.dispatchTask(projectId, repoPath, task, 0);

    const slot = executeCodingPhase.mock.calls[0]?.[3] as DispatchSlotLike;
    expect(slot.worktreePath).toBe(repoPath);
  });

  it("resumes baseline-paused tasks at merge instead of relaunching a coder", async () => {
    const task = {
      ...baseTask("os-3456"),
      worktreePath: "/tmp/repo/.worktrees/os-3456",
      merge_retry_mode: "baseline_wait",
      merge_quality_gate_paused_until: "2026-03-14T10:00:00.000Z",
      next_retry_context: {
        previousFailure: "baseline quality gates failed on main: Command failed: npm run lint",
        failureType: "merge_quality_gate",
      },
    } as StoredTask;

    await service.dispatchTask(projectId, repoPath, task, 2);

    expect(taskStore.update).toHaveBeenCalledWith(
      projectId,
      task.id,
      expect.objectContaining({
        status: "in_progress",
        extra: expect.objectContaining({
          next_retry_context: null,
          merge_retry_mode: null,
          merge_quality_gate_paused_until: null,
          merge_attempt_lease_expires_at: expect.any(String),
          merge_attempt_lease_acquired_at: expect.any(String),
          merge_attempt_lease_owner: expect.stringContaining(task.id),
        }),
      })
    );
    expect(performMergeRetry).toHaveBeenCalledWith(
      projectId,
      repoPath,
      task,
      expect.objectContaining({
        taskId: task.id,
        branchName: `opensprint/${task.id}`,
        worktreePath: "/tmp/repo/.worktrees/os-3456",
      })
    );
    expect(executeCodingPhase).not.toHaveBeenCalled();
  });

  it("skips dispatch when merge-attempt lease is still active", async () => {
    const task = {
      ...baseTask("os-leased"),
      merge_attempt_lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    } as StoredTask;

    await service.dispatchTask(projectId, repoPath, task, 0);

    expect(taskStore.update).not.toHaveBeenCalled();
    expect(executeCodingPhase).not.toHaveBeenCalled();
    expect(performMergeRetry).not.toHaveBeenCalled();
  });

  it("skips dispatch when a slot already exists for the task", async () => {
    const task = baseTask("os-slotted");
    state.slots.set(task.id, {
      taskId: task.id,
      taskTitle: task.title ?? null,
      branchName: `opensprint/${task.id}`,
      attempt: 1,
      worktreePath: "/tmp/repo/.worktrees/os-slotted",
    } as DispatchSlotLike);

    await service.dispatchTask(projectId, repoPath, task, 0);

    expect(taskStore.update).not.toHaveBeenCalled();
    expect(executeCodingPhase).not.toHaveBeenCalled();
    expect(performMergeRetry).not.toHaveBeenCalled();
  });
});

vi.mock("../services/governance.service.js", async () => ({
  governanceService: (await import("./mocks/disabled-governance.js")).disabledGovernanceService,
}));
