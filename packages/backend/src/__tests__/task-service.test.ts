import { describe, it, expect, beforeEach, vi } from "vitest";
import { TaskService } from "../services/task.service.js";
import { ProjectService } from "../services/project.service.js";
import { taskStore } from "../services/task-store.service.js";
import { FeedbackService } from "../services/feedback.service.js";
import { SessionManager } from "../services/session-manager.js";
import { ContextAssembler } from "../services/context-assembler.js";
import { BranchManager } from "../services/branch-manager.js";
import type { StoredTask } from "../services/task-store.service.js";

const { mockTaskStoreState, mockBranchManagerInstance, mockOrchestrator, lastAssembleConfig } =
  vi.hoisted(() => ({
    mockTaskStoreState: { listAll: [] as StoredTask[], readyCalls: 0 },
    mockBranchManagerInstance: {
      listTaskWorktrees: vi.fn().mockResolvedValue([]),
      removeTaskWorktree: vi.fn().mockResolvedValue(undefined),
      revertAndReturnToMain: vi.fn().mockResolvedValue(undefined),
      createOrCheckoutBranch: vi.fn().mockResolvedValue(undefined),
    },
    mockOrchestrator: {
    stopTaskAndFreeSlot: vi.fn().mockResolvedValue(undefined),
    nudge: vi.fn(),
  },
  lastAssembleConfig: { branch: undefined as string | undefined },
}));

// Avoid loading drizzle-orm/pg-core when task-store mock uses importOriginal (vitest resolution can fail)
vi.mock("drizzle-orm", () => ({ and: (...args: unknown[]) => args, eq: (a: unknown, b: unknown) => [a, b] }));
vi.mock("../db/drizzle-schema-pg.js", () => ({ plansTable: {} }));

vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const { createMockDbClient } = await import("./test-db-helper.js");
  const actual = await importOriginal<typeof import("../services/task-store.service.js")>();
  const mockDb = createMockDbClient();
  return {
    ...actual,
    taskStore: {
      listAll: vi.fn().mockImplementation(async () => mockTaskStoreState.listAll),
      show: vi.fn().mockImplementation(async (_p: string, id: string) => {
        const found = mockTaskStoreState.listAll.find((i) => i.id === id);
        if (!found) throw new Error(`Issue ${id} not found`);
        return found;
      }),
      ready: vi.fn().mockImplementation(async () => {
        mockTaskStoreState.readyCalls++;
        return [];
      }),
      getDb: vi.fn().mockResolvedValue(mockDb),
      runWrite: vi.fn().mockImplementation(async (fn: (db: typeof mockDb) => void) => {
        await fn(mockDb);
      }),
      update: vi.fn(),
      close: vi.fn(),
      delete: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      addDependencies: vi.fn(),
      removeLabel: vi.fn(),
      getBlockersFromIssue: vi.fn().mockReturnValue([]),
      planGet: vi.fn(),
      planGetByEpicId: vi.fn(),
      planUpdateMetadata: vi.fn(),
      syncForPush: vi.fn(),
      listRecentlyCompletedTasks: vi.fn().mockResolvedValue([]),
    },
    TaskStoreService: vi.fn(),
    SCHEMA_SQL: "",
    resolveEpicId: actual.resolveEpicId,
  };
});

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getProject: vi.fn().mockResolvedValue({
      id: "proj-1",
      repoPath: "/tmp/test-repo",
    }),
    getProjectByRepoPath: vi.fn().mockResolvedValue({ id: "proj-1", repoPath: "/tmp/test-repo" }),
    getSettings: vi.fn().mockResolvedValue({ gitWorkingMode: "branches" }),
    updateSettings: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock("../services/branch-manager.js", () => ({
  BranchManager: vi.fn().mockImplementation(() => mockBranchManagerInstance),
}));

vi.mock("../services/feedback.service.js", () => ({
  FeedbackService: vi.fn().mockImplementation(() => ({
    checkAutoResolveOnTaskDone: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../services/session-manager.js", () => {
  const MockSessionManager = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    // Rely on prototype methods so vi.spyOn(SessionManager.prototype, ...) is invoked
  });
  const proto = (MockSessionManager as unknown as { prototype: Record<string, unknown> }).prototype;
  proto.loadSessionsTestResultsOnlyGroupedByTaskId = vi.fn().mockResolvedValue(new Map());
  proto.loadSessionsGroupedByTaskId = vi.fn().mockResolvedValue(new Map());
  proto.listSessions = vi.fn().mockResolvedValue([]);
  proto.readSession = vi.fn().mockResolvedValue(null);
  proto.getActiveDir = vi.fn().mockReturnValue("/tmp/opensprint-worktrees/task-1");
  return { SessionManager: MockSessionManager };
});

vi.mock("../services/context-assembler.js", () => ({
  ContextAssembler: vi.fn().mockImplementation(() => ({
    extractPrdExcerpt: vi.fn().mockResolvedValue(""),
    getPlanContentForTask: vi.fn().mockResolvedValue(""),
    collectDependencyOutputs: vi.fn().mockResolvedValue([]),
    assembleTaskDirectory: vi.fn().mockImplementation(
      (_repoPath: string, _taskId: string, config: { branch?: string }) => {
        lastAssembleConfig.branch = config.branch;
        return Promise.resolve("/tmp/test-dir");
      }
    ),
  })),
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    rm: vi.fn().mockResolvedValue(undefined),
  };
});

const mockTriggerDeployForEvent = vi.fn().mockResolvedValue([]);
vi.mock("../services/deploy-trigger.service.js", () => ({
  triggerDeploy: vi.fn().mockResolvedValue(null),
  triggerDeployForEvent: (...args: unknown[]) => mockTriggerDeployForEvent(...args),
}));

const defaultIssues: StoredTask[] = [
  {
    id: "task-1",
    title: "Test Task",
    description: "Test description",
    issue_type: "task",
    status: "open",
    priority: 1,
    assignee: null,
    labels: [],
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    dependencies: [],
  } as StoredTask,
];

describe("TaskService", () => {
  let taskService: TaskService;

  beforeEach(() => {
    mockTaskStoreState.listAll = [...defaultIssues];
    mockTaskStoreState.readyCalls = 0;
    lastAssembleConfig.branch = undefined;
    mockOrchestrator.stopTaskAndFreeSlot.mockClear();
    mockOrchestrator.nudge.mockClear();
    mockBranchManagerInstance.listTaskWorktrees.mockClear();
    mockBranchManagerInstance.removeTaskWorktree.mockClear();
    mockBranchManagerInstance.revertAndReturnToMain.mockClear();
    mockBranchManagerInstance.createOrCheckoutBranch.mockClear();
    taskService = new TaskService(
      new ProjectService(),
      taskStore,
      new FeedbackService(),
      new SessionManager(),
      new ContextAssembler(),
      new BranchManager(),
      mockOrchestrator
    );
  });

  it("getTaskAnalytics returns analytics grouped by complexity", async () => {
    vi.mocked(taskStore.listRecentlyCompletedTasks).mockResolvedValue([
      {
        id: "t1",
        created_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T01:00:00Z",
        complexity: 3,
      },
      {
        id: "t2",
        created_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T02:00:00Z",
        complexity: 3,
      },
      {
        id: "t3",
        created_at: "2024-01-01T00:00:00Z",
        completed_at: "2024-01-01T00:30:00Z",
        complexity: 5,
      },
    ]);
    const analytics = await taskService.getTaskAnalytics("proj-1");
    expect(analytics.byComplexity).toHaveLength(10);
    const bucket3 = analytics.byComplexity.find((b) => b.complexity === 3);
    expect(bucket3).toBeDefined();
    expect(bucket3!.taskCount).toBe(2);
    expect(bucket3!.avgCompletionTimeMs).toBe(1.5 * 60 * 60 * 1000); // avg of 1h and 2h = 1.5h
    const bucket5 = analytics.byComplexity.find((b) => b.complexity === 5);
    expect(bucket5).toBeDefined();
    expect(bucket5!.taskCount).toBe(1);
    expect(bucket5!.avgCompletionTimeMs).toBe(30 * 60 * 1000); // 30 min
    expect(analytics.totalTasks).toBe(3);
  });

  it("getTaskAnalytics (global) calls listRecentlyCompletedTasks with null projectId", async () => {
    vi.mocked(taskStore.listRecentlyCompletedTasks).mockResolvedValue([]);
    await taskService.getTaskAnalytics();
    expect(taskStore.listRecentlyCompletedTasks).toHaveBeenCalledWith(null, 100);
  });

  it("getTask returns task from task store listAll", async () => {
    const task = await taskService.getTask("proj-1", "task-1");
    expect(task).toBeDefined();
    expect(task.id).toBe("task-1");
    expect(task.title).toBe("Test Task");
    expect(mockTaskStoreState.readyCalls).toBe(0);
  });

  it("getTask throws 404 for unknown task ID", async () => {
    await expect(taskService.getTask("proj-1", "nonexistent")).rejects.toThrow("not found");
  });

  it("getTask does not call taskStore.ready (avoids N show calls)", async () => {
    await taskService.getTask("proj-1", "task-1");
    expect(mockTaskStoreState.readyCalls).toBe(0);
  });

  it("listTasks returns tasks from task store listAll", async () => {
    const tasks = await taskService.listTasks("proj-1");
    expect(tasks).toBeDefined();
    expect(tasks.length).toBe(1);
    expect(mockTaskStoreState.readyCalls).toBe(0);
  });

  it("listTasks returns task with source when stored issue has source (e.g. from extra.source)", async () => {
    mockTaskStoreState.listAll = [
      {
        id: "task-a",
        title: "Improvement task",
        status: "open",
        issue_type: "task",
        dependencies: [],
        created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z",
        source: "self-improvement",
      },
    ] as StoredTask[];

    const tasks = await taskService.listTasks("proj-1");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].source).toBe("self-improvement");
  });

  it("listTasks does not call taskStore.ready (computes ready from store)", async () => {
    await taskService.listTasks("proj-1");
    expect(mockTaskStoreState.readyCalls).toBe(0);
  });

  it("getReadyTasks does not call taskStore.ready (computes ready from store)", async () => {
    const tasks = await taskService.getReadyTasks("proj-1");
    expect(tasks).toBeDefined();
    expect(mockTaskStoreState.readyCalls).toBe(0);
  });

  it("listTasks computes ready status: task with no blockers is ready", async () => {
    mockTaskStoreState.listAll = [
      {
        id: "task-a",
        title: "Task A",
        status: "open",
        issue_type: "task",
        dependencies: [],
      },
    ] as StoredTask[];

    const tasks = await taskService.listTasks("proj-1");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].kanbanColumn).toBe("ready");
  });

  it("listTasks computes ready status: task with open blocker is backlog", async () => {
    mockTaskStoreState.listAll = [
      { id: "blocker-1", status: "open", issue_type: "task", dependencies: [] },
      {
        id: "task-a",
        title: "Task A",
        status: "open",
        issue_type: "task",
        dependencies: [{ type: "blocks", depends_on_id: "blocker-1" }],
      },
    ] as StoredTask[];

    const tasks = await taskService.listTasks("proj-1");
    const taskA = tasks.find((t) => t.id === "task-a");
    expect(taskA).toBeDefined();
    expect(taskA!.kanbanColumn).toBe("backlog");
  });

  it("listTasks computes ready status: task with closed blocker is ready", async () => {
    mockTaskStoreState.listAll = [
      { id: "blocker-1", status: "closed", issue_type: "task", dependencies: [] },
      {
        id: "task-a",
        title: "Task A",
        status: "open",
        issue_type: "task",
        dependencies: [{ type: "blocks", depends_on_id: "blocker-1" }],
      },
    ] as StoredTask[];

    const tasks = await taskService.listTasks("proj-1");
    const taskA = tasks.find((t) => t.id === "task-a");
    expect(taskA).toBeDefined();
    expect(taskA!.kanbanColumn).toBe("ready");
  });

  it("listTasks excludes epics from ready (epics are containers, not work items)", async () => {
    mockTaskStoreState.listAll = [
      { id: "epic-1", status: "open", issue_type: "epic", dependencies: [] },
    ] as StoredTask[];

    const tasks = await taskService.listTasks("proj-1");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].kanbanColumn).not.toBe("ready");
  });

  it("listTasks excludes chore tasks (feedback source provenance, not work items)", async () => {
    mockTaskStoreState.listAll = [
      {
        id: "chore-1",
        title: "Feedback: The homepage projects list should be 50% wider",
        status: "open",
        issue_type: "chore",
        dependencies: [],
      },
      {
        id: "task-1",
        title: "Widen homepage projects list by 50%",
        status: "open",
        issue_type: "task",
        dependencies: [],
      },
    ] as StoredTask[];

    const tasks = await taskService.listTasks("proj-1");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe("task-1");
    expect(tasks[0].title).toBe("Widen homepage projects list by 50%");
  });

  it("getTask: task in blocked epic shows planning and is not ready", async () => {
    mockTaskStoreState.listAll = [
      {
        id: "os-a3f8",
        title: "Epic",
        status: "blocked",
        issue_type: "epic",
        dependencies: [],
      },
      {
        id: "os-a3f8.1",
        title: "Task in blocked epic",
        status: "open",
        issue_type: "task",
        dependencies: [],
      },
    ] as StoredTask[];

    const task = await taskService.getTask("proj-1", "os-a3f8.1");
    expect(task).toBeDefined();
    expect(task.kanbanColumn).toBe("planning");
    expect(task.epicId).toBe("os-a3f8");

    const readyTasks = await taskService.getReadyTasks("proj-1");
    expect(readyTasks.map((t) => t.id)).not.toContain("os-a3f8.1");
  });

  it("listTasks: task in blocked epic is not ready and shows planning column", async () => {
    mockTaskStoreState.listAll = [
      {
        id: "os-a3f8",
        title: "Epic",
        status: "blocked",
        issue_type: "epic",
        dependencies: [],
      },
      {
        id: "os-a3f8.1",
        title: "Task in blocked epic",
        status: "open",
        issue_type: "task",
        dependencies: [],
      },
    ] as StoredTask[];

    const tasks = await taskService.listTasks("proj-1");
    const task = tasks.find((t) => t.id === "os-a3f8.1");
    expect(task).toBeDefined();
    expect(task!.kanbanColumn).toBe("planning");

    const readyTasks = await taskService.getReadyTasks("proj-1");
    expect(readyTasks.map((t) => t.id)).not.toContain("os-a3f8.1");
  });

  it("listTasks: task in open epic with no blockers is ready", async () => {
    mockTaskStoreState.listAll = [
      {
        id: "os-a3f8",
        title: "Epic",
        status: "open",
        issue_type: "epic",
        dependencies: [],
      },
      {
        id: "os-a3f8.1",
        title: "Task in open epic",
        status: "open",
        issue_type: "task",
        dependencies: [],
      },
    ] as StoredTask[];

    const tasks = await taskService.listTasks("proj-1");
    const task = tasks.find((t) => t.id === "os-a3f8.1");
    expect(task).toBeDefined();
    expect(task!.kanbanColumn).toBe("ready");

    const readyTasks = await taskService.getReadyTasks("proj-1");
    expect(readyTasks.map((t) => t.id)).toContain("os-a3f8.1");
  });

  it("listTasks: mixed epics — blocked epic tasks show planning, open epic tasks show ready", async () => {
    mockTaskStoreState.listAll = [
      {
        id: "os-e1",
        title: "Blocked Epic",
        status: "blocked",
        issue_type: "epic",
        dependencies: [],
      },
      {
        id: "os-e2",
        title: "Open Epic",
        status: "open",
        issue_type: "epic",
        dependencies: [],
      },
      {
        id: "os-e1.1",
        title: "Task in blocked epic",
        status: "open",
        issue_type: "task",
        dependencies: [],
      },
      {
        id: "os-e2.1",
        title: "Task in open epic",
        status: "open",
        issue_type: "task",
        dependencies: [],
      },
    ] as StoredTask[];

    const tasks = await taskService.listTasks("proj-1");
    const blockedTask = tasks.find((t) => t.id === "os-e1.1");
    const openTask = tasks.find((t) => t.id === "os-e2.1");
    expect(blockedTask!.kanbanColumn).toBe("planning");
    expect(openTask!.kanbanColumn).toBe("ready");

    const readyTasks = await taskService.getReadyTasks("proj-1");
    expect(readyTasks.map((t) => t.id)).toContain("os-e2.1");
    expect(readyTasks.map((t) => t.id)).not.toContain("os-e1.1");
  });

  it("getTask: task epicId is set correctly from parent chain", async () => {
    mockTaskStoreState.listAll = [
      {
        id: "os-ep",
        title: "The Epic",
        status: "open",
        issue_type: "epic",
        dependencies: [],
      },
      {
        id: "os-ep.1",
        title: "Child Task",
        status: "open",
        issue_type: "task",
        dependencies: [],
      },
    ] as StoredTask[];

    const task = await taskService.getTask("proj-1", "os-ep.1");
    expect(task.epicId).toBe("os-ep");
  });

  it("computeKanbanColumn: task with open blocker (task-to-task dep, epic open) shows backlog", async () => {
    mockTaskStoreState.listAll = [
      { id: "os-a3f8", status: "open", issue_type: "epic", dependencies: [] },
      {
        id: "os-a3f8.1",
        title: "Task A",
        status: "open",
        issue_type: "task",
        dependencies: [],
      },
      {
        id: "os-a3f8.2",
        title: "Task B",
        status: "open",
        issue_type: "task",
        dependencies: [{ type: "blocks", depends_on_id: "os-a3f8.1" }],
      },
    ] as StoredTask[];

    const tasks = await taskService.listTasks("proj-1");
    const taskB = tasks.find((t) => t.id === "os-a3f8.2");
    expect(taskB).toBeDefined();
    expect(taskB!.kanbanColumn).toBe("backlog");
  });

  it("getReadyTasks returns only ready tasks (excludes tasks with open blockers)", async () => {
    mockTaskStoreState.listAll = [
      { id: "blocker-1", status: "closed", issue_type: "task", dependencies: [] },
      {
        id: "task-ready",
        title: "Ready Task",
        status: "open",
        issue_type: "task",
        dependencies: [{ type: "blocks", depends_on_id: "blocker-1" }],
      },
      { id: "blocker-2", status: "open", issue_type: "task", dependencies: [] },
      {
        id: "task-not-ready",
        title: "Not Ready",
        status: "open",
        issue_type: "task",
        dependencies: [{ type: "blocks", depends_on_id: "blocker-2" }],
      },
    ] as StoredTask[];

    const tasks = await taskService.getReadyTasks("proj-1");
    const ids = tasks.map((t) => t.id);
    expect(ids).toContain("task-ready");
    expect(ids).toContain("blocker-2");
    expect(ids).not.toContain("task-not-ready");
    expect(ids).not.toContain("blocker-1");
  });

  it("listTasks calls loadSessionsTestResultsOnlyGroupedByTaskId once (light session load, not full)", async () => {
    mockTaskStoreState.listAll = Array.from({ length: 10 }, (_, i) => ({
      id: `task-${i}`,
      title: `Task ${i}`,
      status: "open" as const,
      issue_type: "task" as const,
      dependencies: [],
    })) as StoredTask[];

    const loadSpy = vi.spyOn(
      SessionManager.prototype,
      "loadSessionsTestResultsOnlyGroupedByTaskId"
    );
    const listSpy = vi.spyOn(SessionManager.prototype, "listSessions");

    await taskService.listTasks("proj-1");

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).not.toHaveBeenCalled();

    loadSpy.mockRestore();
    listSpy.mockRestore();
  });

  it("listTasks enriches tasks with testResults from latest session", async () => {
    mockTaskStoreState.listAll = [
      {
        id: "task-with-session",
        title: "Task A",
        status: "open",
        issue_type: "task",
        dependencies: [],
      },
      {
        id: "task-no-session",
        title: "Task B",
        status: "open",
        issue_type: "task",
        dependencies: [],
      },
    ] as StoredTask[];

    const loadSpy = vi
      .spyOn(SessionManager.prototype, "loadSessionsTestResultsOnlyGroupedByTaskId")
      .mockResolvedValue(
        new Map([
          [
            "task-with-session",
            [
              { testResults: null },
              { testResults: { passed: 5, failed: 0, skipped: 1, total: 6, details: [] } },
            ],
          ],
        ])
      );

    const tasks = await taskService.listTasks("proj-1");

    expect(tasks.find((t) => t.id === "task-with-session")?.testResults).toEqual({
      passed: 5,
      failed: 0,
      skipped: 1,
      total: 6,
      details: [],
    });
    expect(tasks.find((t) => t.id === "task-no-session")?.testResults).toBeUndefined();

    loadSpy.mockRestore();
  });

  it("markDone closes task via task store", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(taskStore.close).mockResolvedValue(undefined as never);
    vi.mocked(taskStore.syncForPush).mockResolvedValue(undefined as never);

    const result = await taskService.markDone("proj-1", "task-1");
    expect(result.taskClosed).toBe(true);
  });

  it("markDone does not trigger deploy when last task of epic is closed and plan is in_review (no reviewedAt)", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    const epicId = "epic-1";
    const taskId = "epic-1.1";
    // show(): task is open so we proceed to close it
    vi.mocked(taskStore.show).mockResolvedValue({
      id: taskId,
      title: "Task",
      issue_type: "task",
      status: "open",
    } as StoredTask);
    // listAll() is called after close(); return task as closed so allClosed is true
    mockTaskStoreState.listAll = [
      { id: epicId, title: "Epic", issue_type: "epic", status: "open" } as StoredTask,
      { id: taskId, title: "Task", issue_type: "task", status: "closed" } as StoredTask,
    ];
    vi.mocked(taskStore.close).mockResolvedValue(undefined as never);
    vi.mocked(taskStore.planGetByEpicId).mockResolvedValue({
      plan_id: "plan-1",
      content: "",
      metadata: { reviewedAt: null },
      shipped_content: null,
      updated_at: "",
      current_version_number: 1,
      last_executed_version_number: null,
    });
    mockTriggerDeployForEvent.mockClear();

    const result = await taskService.markDone("proj-1", taskId);

    expect(result.taskClosed).toBe(true);
    expect(result.epicClosed).toBe(true);
    expect(mockTriggerDeployForEvent).not.toHaveBeenCalled();
  });

  it("markDone triggers deploy when last task of epic is closed and plan is complete (reviewedAt set)", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    const epicId = "epic-1";
    const taskId = "epic-1.1";
    vi.mocked(taskStore.show).mockResolvedValue({
      id: taskId,
      title: "Task",
      issue_type: "task",
      status: "open",
    } as StoredTask);
    mockTaskStoreState.listAll = [
      { id: epicId, title: "Epic", issue_type: "epic", status: "open" } as StoredTask,
      { id: taskId, title: "Task", issue_type: "task", status: "closed" } as StoredTask,
    ];
    vi.mocked(taskStore.close).mockResolvedValue(undefined as never);
    vi.mocked(taskStore.planGetByEpicId).mockResolvedValue({
      plan_id: "plan-1",
      content: "",
      metadata: { reviewedAt: "2025-03-09T12:00:00.000Z" },
      shipped_content: null,
      updated_at: "",
      current_version_number: 1,
      last_executed_version_number: null,
    });
    mockTriggerDeployForEvent.mockClear();

    const result = await taskService.markDone("proj-1", taskId);

    expect(result.taskClosed).toBe(true);
    expect(result.epicClosed).toBe(true);
    expect(mockTriggerDeployForEvent).toHaveBeenCalledWith("proj-1", "each_epic");
  });

  it("unblock updates task status via task store", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(taskStore.show).mockResolvedValue({
      id: "task-1",
      title: "Blocked Task",
      status: "blocked",
      issue_type: "task",
      dependencies: [],
    } as StoredTask);
    vi.mocked(taskStore.update).mockResolvedValue(undefined as never);
    vi.mocked(taskStore.syncForPush).mockResolvedValue(undefined as never);

    const result = await taskService.unblock("proj-1", "task-1");
    expect(result.taskUnblocked).toBe(true);
  });

  it("unblock performs full cleanup: stop agent, revert branch, delete active dir", async () => {
    const { taskStore } = await import("../services/task-store.service.js");

    vi.mocked(taskStore.show).mockResolvedValue({
      id: "task-1",
      title: "Blocked Task",
      status: "blocked",
      issue_type: "task",
      dependencies: [],
    } as StoredTask);
    vi.mocked(taskStore.update).mockResolvedValue(undefined as never);
    vi.mocked(taskStore.syncForPush).mockResolvedValue(undefined as never);

    const result = await taskService.unblock("proj-1", "task-1");

    expect(result.taskUnblocked).toBe(true);
    expect(mockOrchestrator.stopTaskAndFreeSlot).toHaveBeenCalledWith("proj-1", "task-1");
    expect(mockOrchestrator.nudge).toHaveBeenCalledWith("proj-1");
    expect(mockBranchManagerInstance.revertAndReturnToMain).toHaveBeenCalledWith(
      "/tmp/test-repo",
      "opensprint/task-1",
      "main"
    );
  });

  it("unblock nudges orchestrator so it processes the task promptly", async () => {
    const { taskStore } = await import("../services/task-store.service.js");

    vi.mocked(taskStore.show).mockResolvedValue({
      id: "task-1",
      title: "Blocked Task",
      status: "blocked",
      issue_type: "task",
      dependencies: [],
    } as StoredTask);
    vi.mocked(taskStore.update).mockResolvedValue(undefined as never);
    vi.mocked(taskStore.syncForPush).mockResolvedValue(undefined as never);
    mockOrchestrator.nudge.mockClear();

    const result = await taskService.unblock("proj-1", "task-1");

    expect(result.taskUnblocked).toBe(true);
    expect(mockOrchestrator.nudge).toHaveBeenCalledWith("proj-1");
  });

  it("unblock removes worktree when in worktree mode", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    const { ProjectService } = await import("../services/project.service.js");

    vi.mocked(ProjectService).mockImplementationOnce(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({
            id: "proj-1",
            repoPath: "/tmp/test-repo",
          }),
          getProjectByRepoPath: vi
            .fn()
            .mockResolvedValue({ id: "proj-1", repoPath: "/tmp/test-repo" }),
          getSettings: vi.fn().mockResolvedValue({ gitWorkingMode: "worktree" }),
        }) as never
    );

    mockBranchManagerInstance.listTaskWorktrees.mockResolvedValueOnce([
      { taskId: "task-1", worktreePath: "/tmp/opensprint-worktrees/task-1" },
    ]);

    vi.mocked(taskStore.show).mockResolvedValue({
      id: "task-1",
      title: "Blocked Task",
      status: "blocked",
      issue_type: "task",
      dependencies: [],
    } as StoredTask);
    vi.mocked(taskStore.update).mockResolvedValue(undefined as never);
    vi.mocked(taskStore.syncForPush).mockResolvedValue(undefined as never);

    const svc = new TaskService(
      new ProjectService(),
      taskStore,
      new FeedbackService(),
      new SessionManager(),
      new ContextAssembler(),
      new BranchManager(),
      mockOrchestrator
    );
    await svc.unblock("proj-1", "task-1");

    expect(mockBranchManagerInstance.removeTaskWorktree).toHaveBeenCalledWith(
      "/tmp/test-repo",
      "task-1",
      "/tmp/opensprint-worktrees/task-1"
    );
  });

  it("deleteTask deletes task via task store and nudges orchestrator", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(taskStore.delete).mockResolvedValue(undefined as never);
    mockOrchestrator.stopTaskAndFreeSlot.mockResolvedValue(undefined);

    const result = await taskService.deleteTask("proj-1", "task-1");

    expect(result.taskDeleted).toBe(true);
    expect(mockOrchestrator.stopTaskAndFreeSlot).toHaveBeenCalledWith("proj-1", "task-1");
    expect(taskStore.delete).toHaveBeenCalledWith("proj-1", "task-1");
    expect(mockOrchestrator.nudge).toHaveBeenCalledWith("proj-1");
  });

  describe("prepareTaskDirectory", () => {
    it("uses per-task branch when mergeStrategy is per_task or default", async () => {
      const projectService = new ProjectService();
      vi.mocked(projectService.getSettings).mockResolvedValue({
        gitWorkingMode: "branches",
        mergeStrategy: "per_task",
        worktreeBaseBranch: "main",
      } as never);
      const svc = new TaskService(
        projectService,
        taskStore,
        new FeedbackService(),
        new SessionManager(),
        new ContextAssembler(),
        new BranchManager(),
        mockOrchestrator
      );

      const dir = await svc.prepareTaskDirectory("proj-1", "task-1", { createBranch: true });
      expect(dir).toBe("/tmp/test-dir");
      expect(lastAssembleConfig.branch).toBe("opensprint/task-1");
      expect(mockBranchManagerInstance.createOrCheckoutBranch).toHaveBeenCalledWith(
        "/tmp/test-repo",
        "opensprint/task-1",
        expect.any(String)
      );
    });

    it("uses epic branch when mergeStrategy is per_epic and task belongs to epic", async () => {
      const epicId = "os-ep";
      const childTaskId = "os-ep.1";
      mockTaskStoreState.listAll = [
        {
          id: epicId,
          title: "Epic",
          description: "",
          issue_type: "epic",
          status: "open",
          priority: 0,
          assignee: null,
          labels: [],
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          dependencies: [],
        } as StoredTask,
        {
          id: childTaskId,
          title: "Child Task",
          description: "",
          issue_type: "task",
          status: "open",
          priority: 1,
          assignee: null,
          labels: [],
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          dependencies: [],
        } as StoredTask,
      ];

      const projectService = new ProjectService();
      vi.mocked(projectService.getSettings).mockResolvedValue({
        gitWorkingMode: "branches",
        mergeStrategy: "per_epic",
        worktreeBaseBranch: "main",
      } as never);
      const svc = new TaskService(
        projectService,
        taskStore,
        new FeedbackService(),
        new SessionManager(),
        new ContextAssembler(),
        new BranchManager(),
        mockOrchestrator
      );

      const dir = await svc.prepareTaskDirectory("proj-1", childTaskId, { createBranch: true });
      expect(dir).toBe("/tmp/test-dir");
      expect(lastAssembleConfig.branch).toBe(`opensprint/epic_${epicId}`);
      expect(mockBranchManagerInstance.createOrCheckoutBranch).toHaveBeenCalledWith(
        "/tmp/test-repo",
        `opensprint/epic_${epicId}`,
        expect.any(String)
      );
    });

    it("uses per-task branch when mergeStrategy is per_epic but task has no epic", async () => {
      mockTaskStoreState.listAll = [
        {
          id: "task-1",
          title: "Standalone Task",
          description: "",
          issue_type: "task",
          status: "open",
          priority: 1,
          assignee: null,
          labels: [],
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
          dependencies: [],
        } as StoredTask,
      ];

      const projectService = new ProjectService();
      vi.mocked(projectService.getSettings).mockResolvedValue({
        gitWorkingMode: "branches",
        mergeStrategy: "per_epic",
        worktreeBaseBranch: "main",
      } as never);
      const svc = new TaskService(
        projectService,
        taskStore,
        new FeedbackService(),
        new SessionManager(),
        new ContextAssembler(),
        new BranchManager(),
        mockOrchestrator
      );

      await svc.prepareTaskDirectory("proj-1", "task-1", { createBranch: true });
      expect(lastAssembleConfig.branch).toBe("opensprint/task-1");
    });
  });

  describe("updateTask", () => {
    it("adds human assignee to project teamMembers when not already in list", async () => {
      const projectService = new ProjectService();
      vi.mocked(projectService.getSettings).mockResolvedValue({
        gitWorkingMode: "worktree",
        enableHumanTeammates: true,
        teamMembers: [],
      } as never);
      vi.mocked(projectService.updateSettings).mockResolvedValue({} as never);

      const svc = new TaskService(
        projectService,
        taskStore,
        new FeedbackService(),
        new SessionManager(),
        new ContextAssembler(),
        new BranchManager(),
        mockOrchestrator
      );

      vi.mocked(taskStore.update).mockResolvedValue(undefined as never);

      await svc.updateTask("proj-1", "task-1", { assignee: "Alice" });

      expect(projectService.updateSettings).toHaveBeenCalledWith("proj-1", {
        teamMembers: [{ id: "alice", name: "Alice" }],
      });
      expect(taskStore.update).toHaveBeenCalledWith(
        "proj-1",
        "task-1",
        expect.objectContaining({ assignee: "Alice" })
      );
    });

    it("does not call updateSettings when human assignee is already in teamMembers", async () => {
      const projectService = new ProjectService();
      vi.mocked(projectService.getSettings).mockResolvedValue({
        gitWorkingMode: "worktree",
        enableHumanTeammates: true,
        teamMembers: [{ id: "alice", name: "Alice" }],
      } as never);
      vi.mocked(projectService.updateSettings).mockResolvedValue({} as never);

      const svc = new TaskService(
        projectService,
        taskStore,
        new FeedbackService(),
        new SessionManager(),
        new ContextAssembler(),
        new BranchManager(),
        mockOrchestrator
      );

      vi.mocked(taskStore.update).mockResolvedValue(undefined as never);

      await svc.updateTask("proj-1", "task-1", { assignee: "Alice" });

      expect(projectService.updateSettings).not.toHaveBeenCalled();
      expect(taskStore.update).toHaveBeenCalledWith(
        "proj-1",
        "task-1",
        expect.objectContaining({ assignee: "Alice" })
      );
    });

    it("rejects human assignee when enableHumanTeammates is false", async () => {
      const projectService = new ProjectService();
      vi.mocked(projectService.getSettings).mockResolvedValue({
        gitWorkingMode: "worktree",
        enableHumanTeammates: false,
        teamMembers: [],
      } as never);

      const svc = new TaskService(
        projectService,
        taskStore,
        new FeedbackService(),
        new SessionManager(),
        new ContextAssembler(),
        new BranchManager(),
        mockOrchestrator
      );

      vi.mocked(taskStore.update).mockClear();
      await expect(svc.updateTask("proj-1", "task-1", { assignee: "Alice" })).rejects.toMatchObject({
        statusCode: 400,
        code: "INVALID_INPUT",
        message: expect.stringMatching(/human teammates are disabled/i),
      });
      expect(taskStore.update).not.toHaveBeenCalled();
    });

    it("does not add agent assignee to teamMembers", async () => {
      const projectService = new ProjectService();
      vi.mocked(projectService.getSettings).mockResolvedValue({
        gitWorkingMode: "worktree",
        enableHumanTeammates: true,
        teamMembers: [],
      } as never);
      vi.mocked(projectService.updateSettings).mockResolvedValue({} as never);

      const svc = new TaskService(
        projectService,
        taskStore,
        new FeedbackService(),
        new SessionManager(),
        new ContextAssembler(),
        new BranchManager(),
        mockOrchestrator
      );

      vi.mocked(taskStore.update).mockResolvedValue(undefined as never);

      await svc.updateTask("proj-1", "task-1", { assignee: "Frodo" });

      expect(projectService.updateSettings).not.toHaveBeenCalled();
      expect(taskStore.update).toHaveBeenCalledWith(
        "proj-1",
        "task-1",
        expect.objectContaining({ assignee: "Frodo" })
      );
    });
  });

  describe("sourceFeedbackIds", () => {
    it("derives sourceFeedbackIds from discovered-from dep to feedback source task", async () => {
      mockTaskStoreState.listAll = [
        {
          id: "source-chore",
          title: "Feedback: Add dark mode",
          description: "Feedback ID: fb-123",
          status: "open",
          issue_type: "chore",
          dependencies: [],
        },
        {
          id: "task-impl",
          title: "Implement dark mode",
          description: "Add dark mode",
          status: "open",
          issue_type: "task",
          dependencies: [{ depends_on_id: "source-chore", type: "discovered-from" }],
        },
      ] as StoredTask[];

      const task = await taskService.getTask("proj-1", "task-impl");
      expect(task.sourceFeedbackIds).toEqual(["fb-123"]);
      expect(task.sourceFeedbackId).toBe("fb-123");
    });

    it("derives sourceFeedbackIds when task is feedback source itself (own description)", async () => {
      mockTaskStoreState.listAll = [
        {
          id: "source-chore",
          title: "Feedback: Fix login",
          description: "Feedback ID: fb-direct",
          status: "open",
          issue_type: "chore",
          dependencies: [],
        },
      ] as StoredTask[];

      const task = await taskService.getTask("proj-1", "source-chore");
      expect(task.sourceFeedbackIds).toEqual(["fb-direct"]);
      expect(task.sourceFeedbackId).toBe("fb-direct");
    });

    it("prefers extra.sourceFeedbackIds when present on stored task", async () => {
      mockTaskStoreState.listAll = [
        {
          id: "task-with-extra",
          title: "Task",
          description: "Some description",
          status: "open",
          issue_type: "task",
          dependencies: [],
          sourceFeedbackIds: ["fb-extra-1", "fb-extra-2"],
        },
      ] as StoredTask[];

      const task = await taskService.getTask("proj-1", "task-with-extra");
      expect(task.sourceFeedbackIds).toEqual(["fb-extra-1", "fb-extra-2"]);
      expect(task.sourceFeedbackId).toBe("fb-extra-1");
    });

    it("derives multiple sourceFeedbackIds from multiple discovered-from deps", async () => {
      mockTaskStoreState.listAll = [
        {
          id: "source-1",
          title: "Feedback 1",
          description: "Feedback ID: fb-one",
          status: "open",
          issue_type: "chore",
          dependencies: [],
        },
        {
          id: "source-2",
          title: "Feedback 2",
          description: "Feedback ID: fb-two",
          status: "open",
          issue_type: "chore",
          dependencies: [],
        },
        {
          id: "task-multi",
          title: "Task with multiple feedback",
          description: "Implementation",
          status: "open",
          issue_type: "task",
          dependencies: [
            { depends_on_id: "source-1", type: "discovered-from" },
            { depends_on_id: "source-2", type: "discovered-from" },
          ],
        },
      ] as StoredTask[];

      const task = await taskService.getTask("proj-1", "task-multi");
      expect(task.sourceFeedbackIds).toEqual(["fb-one", "fb-two"]);
      expect(task.sourceFeedbackId).toBe("fb-one");
    });

    it("legacy task without extra or discovered-from has no sourceFeedbackIds", async () => {
      mockTaskStoreState.listAll = [
        {
          id: "task-1",
          title: "Test Task",
          description: "Test description",
          status: "open",
          issue_type: "task",
          dependencies: [],
        },
      ] as StoredTask[];

      const task = await taskService.getTask("proj-1", "task-1");
      expect(task.sourceFeedbackIds).toBeUndefined();
      expect(task.sourceFeedbackId).toBeUndefined();
    });
  });
});
