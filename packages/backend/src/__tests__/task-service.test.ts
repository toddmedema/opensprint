import { describe, it, expect, beforeEach, vi } from "vitest";
import { TaskService } from "../services/task.service.js";
import { ProjectService } from "../services/project.service.js";
import { taskStore } from "../services/task-store.service.js";
import { FeedbackService } from "../services/feedback.service.js";
import { SessionManager } from "../services/session-manager.js";
import { ContextAssembler } from "../services/context-assembler.js";
import { BranchManager } from "../services/branch-manager.js";
import type { StoredTask } from "../services/task-store.service.js";

const { mockTaskStoreState, mockBranchManagerInstance } = vi.hoisted(() => ({
  mockTaskStoreState: { listAll: [] as StoredTask[], readyCalls: 0 },
  mockBranchManagerInstance: {
    listTaskWorktrees: vi.fn().mockResolvedValue([]),
    removeTaskWorktree: vi.fn().mockResolvedValue(undefined),
    revertAndReturnToMain: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../services/task-store.service.js", async () => {
  const { createMockDbClient } = await import("./test-db-helper.js");
  const mockDb = createMockDbClient();
  return {
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
      create: vi.fn(),
      createMany: vi.fn(),
      addDependencies: vi.fn(),
      removeLabel: vi.fn(),
      getBlockersFromIssue: vi.fn().mockReturnValue([]),
      planGet: vi.fn(),
      planUpdateMetadata: vi.fn(),
      syncForPush: vi.fn(),
    },
    TaskStoreService: vi.fn(),
    SCHEMA_SQL: "",
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
  })),
}));

vi.mock("../services/orchestrator.service.js", () => ({
  orchestratorService: {
    stopTaskAndFreeSlot: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue({ activeTasks: [], queueDepth: 0 }),
  },
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
    assembleTaskDirectory: vi.fn().mockResolvedValue("/tmp/test-dir"),
  })),
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    rm: vi.fn().mockResolvedValue(undefined),
  };
});

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
    taskService = new TaskService(
      new ProjectService(),
      taskStore,
      new FeedbackService(),
      new SessionManager(),
      new ContextAssembler(),
      new BranchManager()
    );
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
    const { orchestratorService } = await import("../services/orchestrator.service.js");

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
    expect(orchestratorService.stopTaskAndFreeSlot).toHaveBeenCalledWith("proj-1", "task-1");
    expect(mockBranchManagerInstance.revertAndReturnToMain).toHaveBeenCalledWith(
      "/tmp/test-repo",
      "opensprint/task-1"
    );
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
          getProjectByRepoPath: vi.fn().mockResolvedValue({ id: "proj-1", repoPath: "/tmp/test-repo" }),
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
      new BranchManager()
    );
    await svc.unblock("proj-1", "task-1");

    expect(mockBranchManagerInstance.removeTaskWorktree).toHaveBeenCalledWith(
      "/tmp/test-repo",
      "task-1",
      "/tmp/opensprint-worktrees/task-1"
    );
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
