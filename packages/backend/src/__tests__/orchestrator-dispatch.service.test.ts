import { describe, it, expect, vi, beforeEach } from "vitest";
// Avoid loading drizzle-orm/pg-core (vitest resolution can fail in some workspaces)
vi.mock("drizzle-orm", () => ({ and: (...args: unknown[]) => args, eq: (a: unknown, b: unknown) => [a, b] }));
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
    state = { nextCoderIndex: 0, status: { queueDepth: 0 }, slots: new Map() };
    taskStore = {
      update: vi.fn().mockResolvedValue(undefined),
      getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(0),
      listAll: vi.fn().mockResolvedValue([]),
    };
    executeCodingPhase = vi.fn().mockResolvedValue(undefined);
    host = {
      getState: vi.fn().mockReturnValue(state),
      createSlot: vi
        .fn()
        .mockImplementation(
          (
            taskId: string,
            taskTitle: string | null,
            branchName: string,
            attempt: number,
            assignee: string,
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
      getBranchManager: vi.fn().mockReturnValue({ ensureOnMain: vi.fn().mockResolvedValue(undefined) }),
      getFileScopeAnalyzer: vi
        .fn()
        .mockReturnValue({ predict: vi.fn().mockResolvedValue({ modify: ["a.ts"] }) }),
      executeCodingPhase,
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
});
