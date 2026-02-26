import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import initSqlJs from "sql.js";
import { FeedbackService } from "../services/feedback.service.js";
import { ProjectService } from "../services/project.service.js";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";
import { feedbackStore } from "../services/feedback-store.service.js";
import type { Database } from "sql.js";

const mockInvoke = vi.fn();
vi.mock("../services/agent-client.js", () => ({
  AgentClient: vi.fn().mockImplementation(() => ({
    invoke: (opts: { prompt?: string }) => mockInvoke(opts),
  })),
}));

const mockRegister = vi.fn();
const mockUnregister = vi.fn();
vi.mock("../services/active-agents.service.js", () => ({
  activeAgentsService: {
    register: (...args: unknown[]) => mockRegister(...args),
    unregister: (...args: unknown[]) => mockUnregister(...args),
    list: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    async invokePlanningAgent(opts: {
      messages?: { role: string; content: string }[];
      tracking?: {
        id: string;
        projectId: string;
        phase: string;
        role: string;
        label: string;
        branchName?: string;
      };
      [key: string]: unknown;
    }) {
      const { tracking } = opts ?? {};
      if (tracking) {
        mockRegister(
          tracking.id,
          tracking.projectId,
          tracking.phase,
          tracking.role,
          tracking.label,
          new Date().toISOString(),
          tracking.branchName
        );
      }
      try {
        const normalized = {
          ...opts,
          prompt: opts?.messages?.[0]?.content ?? "",
        };
        return mockInvoke(normalized);
      } finally {
        if (tracking) mockUnregister(tracking.id);
      }
    },
  },
}));

const mockHilEvaluate = vi.fn().mockResolvedValue({ approved: false });
vi.mock("../services/hil-service.js", () => ({
  hilService: { evaluateDecision: (...args: unknown[]) => mockHilEvaluate(...args) },
}));

const mockSyncPrdFromScopeChange = vi.fn().mockResolvedValue(undefined);
const mockGetScopeChangeProposal = vi.fn().mockResolvedValue(null);
const mockApplyScopeChangeUpdates = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/chat.service.js", () => ({
  ChatService: vi.fn().mockImplementation(() => ({
    syncPrdFromScopeChangeFeedback: (...args: unknown[]) => mockSyncPrdFromScopeChange(...args),
    getScopeChangeProposal: (...args: unknown[]) => mockGetScopeChangeProposal(...args),
    applyScopeChangeUpdates: (...args: unknown[]) => mockApplyScopeChangeUpdates(...args),
  })),
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: vi.fn(),
}));

let taskStoreCreateCallCount = 0;
const mockTaskStoreCreate = vi.fn().mockImplementation(() => {
  taskStoreCreateCallCount += 1;
  // First call: feedback source task; subsequent: task creations
  const id =
    taskStoreCreateCallCount === 1
      ? "mock-feedback-source-1"
      : `mock-task-${taskStoreCreateCallCount - 1}`;
  return Promise.resolve({ id, title: "Mock", status: "open" });
});
const mockTaskStoreCreateWithRetry = vi
  .fn()
  .mockImplementation(
    (
      repoPath: string,
      title: string,
      options: unknown,
      _opts?: { fallbackToStandalone?: boolean }
    ) => mockTaskStoreCreate(repoPath, title, options)
  );
const mockTaskStoreAddDependency = vi.fn().mockResolvedValue(undefined);

let feedbackIdSequence: string[] = [];
vi.mock("../utils/feedback-id.js", () => ({
  generateShortFeedbackId: () => feedbackIdSequence.shift() ?? "xyz123",
}));

const mockTaskStoreListAll = vi.fn().mockResolvedValue([]);
const mockTaskStoreReady = vi.fn().mockResolvedValue([]);
let testDb: Database;
vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/task-store.service.js")>();
  const mockInstance = {
    init: vi.fn().mockImplementation(async () => {
      const SQL = await initSqlJs();
      testDb = new SQL.Database();
      testDb.run(mod.SCHEMA_SQL);
    }),
    getDb: vi.fn().mockImplementation(async () => testDb),
    runWrite: vi
      .fn()
      .mockImplementation(async (fn: (db: Database) => Promise<unknown>) => fn(testDb)),
    create: (...args: unknown[]) => mockTaskStoreCreate(...args),
    createWithRetry: (...args: unknown[]) => mockTaskStoreCreateWithRetry(...args),
    addDependency: (...args: unknown[]) => mockTaskStoreAddDependency(...args),
    listAll: (...args: unknown[]) => mockTaskStoreListAll(...args),
    list: vi.fn().mockResolvedValue([]),
    ready: (...args: unknown[]) => mockTaskStoreReady(...args),
    show: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue({}),
    closeMany: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteMany: vi.fn().mockResolvedValue(undefined),
    syncForPush: vi.fn().mockResolvedValue(undefined),
    planGetByEpicId: vi.fn().mockResolvedValue(null),
  };
  return {
    TaskStoreService: vi.fn().mockImplementation(() => mockInstance),
    taskStore: mockInstance,
  };
});

describe("FeedbackService", () => {
  let feedbackService: FeedbackService;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockTaskStoreListAll.mockResolvedValue([]);
    mockTaskStoreReady.mockResolvedValue([]);
    feedbackIdSequence = [];
    mockHilEvaluate.mockResolvedValue({ approved: false });
    mockSyncPrdFromScopeChange.mockResolvedValue(undefined);
    taskStoreCreateCallCount = 0;
    feedbackService = new FeedbackService();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-feedback-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    const project = await projectService.createProject({
      name: "Test Project",
      repoPath: path.join(tempDir, "my-project"),
      simpleComplexityAgent: { type: "cursor", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;

    const { taskStore } = await import("../services/task-store.service.js");
    await taskStore.init();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should list feedback items with createdTaskIds for Build tab navigation", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    const db = await taskStore.getDb();
    db.run(
      `INSERT INTO feedback (id, project_id, text, category, mapped_plan_id, created_task_ids, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "fb-1",
        projectId,
        "Login button doesn't work",
        "bug",
        "auth-plan",
        JSON.stringify(["bd-a3f8.5", "bd-a3f8.6"]),
        "pending",
        new Date().toISOString(),
      ]
    );

    const items = await feedbackService.listFeedback(projectId);

    expect(items).toHaveLength(1);
    expect(items[0].createdTaskIds).toEqual(["bd-a3f8.5", "bd-a3f8.6"]);
    expect(items[0].mappedPlanId).toBe("auth-plan");
    expect(items[0].id).toBe("fb-1");
  });

  it("should return empty createdTaskIds for pending feedback", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    const db = await taskStore.getDb();
    db.run(
      `INSERT INTO feedback (id, project_id, text, category, mapped_plan_id, created_task_ids, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "fb-2",
        projectId,
        "Add dark mode",
        "feature",
        null,
        "[]",
        "pending",
        new Date().toISOString(),
      ]
    );

    const items = await feedbackService.listFeedback(projectId);

    expect(items).toHaveLength(1);
    expect(items[0].createdTaskIds).toEqual([]);
    expect(items[0].status).toBe("pending");
  });

  it("should not enqueue pending feedback that already has linked tasks (retryPendingCategorizations)", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    const db = await taskStore.getDb();
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO feedback (id, project_id, text, category, mapped_plan_id, created_task_ids, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["pending-no-tasks", projectId, "Not yet analyzed", "bug", null, "[]", "pending", now]
    );
    db.run(
      `INSERT INTO feedback (id, project_id, text, category, mapped_plan_id, created_task_ids, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "pending-with-tasks",
        projectId,
        "Already analyzed",
        "bug",
        null,
        JSON.stringify(["os-xyz.1"]),
        "pending",
        now,
      ]
    );

    const enqueued = await feedbackService.retryPendingCategorizations(projectId);

    expect(enqueued).toBe(1);
    const pendingIds = await feedbackService.listPendingFeedbackIds(projectId);
    expect(pendingIds).toContain("pending-no-tasks");
    expect(pendingIds).not.toContain("pending-with-tasks");
  });

  it("should create reply with parent_id and depth when parent exists", async () => {
    feedbackIdSequence = ["parent1", "child01"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mappedPlanId: null,
        task_titles: ["Fix reply"],
      }),
    });

    const parent = await feedbackService.submitFeedback(projectId, { text: "Original bug" });
    expect(parent.parent_id).toBeNull();
    expect(parent.depth).toBe(0);

    const reply = await feedbackService.submitFeedback(projectId, {
      text: "Same issue on mobile",
      parent_id: parent.id,
    });

    expect(reply.parent_id).toBe(parent.id);
    expect(reply.depth).toBe(1);
  });

  it("should throw 404 when parent_id references non-existent feedback", async () => {
    await expect(
      feedbackService.submitFeedback(projectId, {
        text: "Reply to missing parent",
        parent_id: "nonexistent",
      })
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "FEEDBACK_NOT_FOUND",
    });
  });

  it("should pass parent context to categorization agent for replies", async () => {
    feedbackIdSequence = ["parent2", "child02"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mappedPlanId: "auth-plan",
        task_titles: ["Fix on mobile too"],
      }),
    });

    const parent = await feedbackService.submitFeedback(projectId, {
      text: "Login broken on desktop",
    });

    const child = await feedbackService.submitFeedback(projectId, {
      text: "Same on mobile",
      parent_id: parent.id,
    });

    await feedbackService.processFeedbackWithAnalyst(projectId, parent.id);
    await feedbackService.processFeedbackWithAnalyst(projectId, child.id);

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    const replyPrompt = mockInvoke.mock.calls[1][0]?.prompt ?? "";
    expect(replyPrompt).toContain("Parent feedback (this is a reply)");
    expect(replyPrompt).toContain("Login broken on desktop");
    expect(replyPrompt).toContain("Parent category:");
    expect(replyPrompt).toContain("Same on mobile");
  });

  it("should set complexity to complex for tasks created from reply feedback (proposed_tasks path)", async () => {
    feedbackIdSequence = ["parent3", "child03"];
    mockInvoke
      .mockResolvedValueOnce({
        content: JSON.stringify({
          category: "bug",
          mappedPlanId: null,
          proposed_tasks: [{ index: 0, title: "Fix desktop", description: "Fix", priority: 0, depends_on: [], complexity: "simple" }],
        }),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          category: "bug",
          mappedPlanId: null,
          proposed_tasks: [{ index: 0, title: "Fix mobile too", description: "Same fix", priority: 0, depends_on: [], complexity: "simple" }],
        }),
      });

    const parent = await feedbackService.submitFeedback(projectId, { text: "Login broken on desktop" });
    const reply = await feedbackService.submitFeedback(projectId, {
      text: "Same on mobile",
      parent_id: parent.id,
    });

    await feedbackService.processFeedbackWithAnalyst(projectId, parent.id);
    await feedbackService.processFeedbackWithAnalyst(projectId, reply.id);

    const createCalls = mockTaskStoreCreateWithRetry.mock.calls;
    const replyTaskCall = createCalls.find((c) => c[1] === "Fix mobile too");
    expect(replyTaskCall).toBeDefined();
    expect((replyTaskCall![2] as { complexity?: string }).complexity).toBe("complex");
  });

  it("should set complexity to complex for tasks created from reply feedback (task_titles legacy path)", async () => {
    feedbackIdSequence = ["parent4", "child04"];
    mockInvoke
      .mockResolvedValueOnce({
        content: JSON.stringify({
          category: "bug",
          mappedPlanId: null,
          task_titles: ["Fix desktop"],
        }),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          category: "bug",
          mappedPlanId: null,
          proposed_tasks: [],
          task_titles: ["Fix mobile too"],
        }),
      });

    const parent = await feedbackService.submitFeedback(projectId, { text: "Login broken" });
    const reply = await feedbackService.submitFeedback(projectId, {
      text: "Same on mobile",
      parent_id: parent.id,
    });

    await feedbackService.processFeedbackWithAnalyst(projectId, parent.id);
    await feedbackService.processFeedbackWithAnalyst(projectId, reply.id);

    const createCalls = mockTaskStoreCreateWithRetry.mock.calls;
    const replyTaskCall = createCalls.find((c) => c[1] === "Fix mobile too");
    expect(replyTaskCall).toBeDefined();
    expect((replyTaskCall![2] as { complexity?: string }).complexity).toBe("complex");
  });

  it("should assign short 6-char alphanumeric feedback IDs", async () => {
    feedbackIdSequence = ["a1b2c3"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mappedPlanId: null,
        task_titles: ["Fix something"],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Something broke",
    });

    expect(item.id).toMatch(/^[a-z0-9]{6}$/);
    expect(item.id).toHaveLength(6);
  });

  it("should store userPriority when priority is provided (0-4)", async () => {
    feedbackIdSequence = ["prio01"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mappedPlanId: null,
        task_titles: ["Fix critical bug"],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Critical bug in auth",
      priority: 0,
    });

    expect(item.userPriority).toBe(0);

    const stored = await feedbackService.getFeedback(projectId, item.id);
    expect(stored.userPriority).toBe(0);
  });

  it("should omit userPriority when priority is not provided", async () => {
    feedbackIdSequence = ["noprio"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mappedPlanId: null,
        task_titles: ["Fix something"],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Normal feedback",
    });

    expect(item.userPriority).toBeUndefined();
  });

  it("should apply userPriority override to ALL created tasks (ignoring AI-suggested)", async () => {
    feedbackIdSequence = ["prioov"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mappedPlanId: null,
        proposed_tasks: [
          { index: 0, title: "Task A", description: "A", priority: 1, depends_on: [] },
          { index: 1, title: "Task B", description: "B", priority: 2, depends_on: [0] },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Feature with user priority",
      priority: 3,
    });

    expect(item.userPriority).toBe(3);

    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.userPriority).toBe(3);

    const taskCreateCalls = mockTaskStoreCreate.mock.calls.filter((c) => c[2]?.type === "feature");
    expect(taskCreateCalls).toHaveLength(2);
    expect(taskCreateCalls[0][2]).toMatchObject({ type: "feature", priority: 3 });
    expect(taskCreateCalls[1][2]).toMatchObject({ type: "feature", priority: 3 });
  });

  it("should use AI-suggested priority when userPriority is null/undefined", async () => {
    feedbackIdSequence = ["ainopr"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mappedPlanId: null,
        proposed_tasks: [
          { index: 0, title: "Task X", description: "X", priority: 1, depends_on: [] },
          { index: 1, title: "Task Y", description: "Y", priority: 2, depends_on: [0] },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Feature without user priority",
    });

    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const taskCreateCalls = mockTaskStoreCreate.mock.calls.filter((c) => c[2]?.type === "feature");
    expect(taskCreateCalls).toHaveLength(2);
    expect(taskCreateCalls[0][2]).toMatchObject({ type: "feature", priority: 1 });
    expect(taskCreateCalls[1][2]).toMatchObject({ type: "feature", priority: 2 });
  });

  it("should persist userPriority in feedback store", async () => {
    feedbackIdSequence = ["pers01"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mappedPlanId: null,
        task_titles: ["Fix bug"],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Critical bug",
      priority: 0,
    });

    const stored = await feedbackService.getFeedback(projectId, item.id);
    expect(stored.userPriority).toBe(0);
  });

  it("should retry with new ID on collision", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    const db = await taskStore.getDb();
    const existingId = "aaaaaa";
    db.run(
      `INSERT INTO feedback (id, project_id, text, category, mapped_plan_id, created_task_ids, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [existingId, projectId, "Existing", "bug", null, "[]", "pending", new Date().toISOString()]
    );

    feedbackIdSequence = [existingId, "bbbbbb"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mappedPlanId: null,
        task_titles: ["Fix collision"],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "New feedback",
    });

    expect(item.id).toBe("bbbbbb");
    const existing = await feedbackService.getFeedback(projectId, existingId);
    expect(existing.text).toBe("Existing");
  });

  it("should categorize feedback via planning agent with PRD and plans context", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mapped_plan_id: "auth-plan",
        proposed_tasks: [
          { index: 0, title: "Add dark mode toggle", description: "", priority: 1, depends_on: [] },
          {
            index: 1,
            title: "Implement theme persistence",
            description: "",
            priority: 1,
            depends_on: [0],
          },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Users want dark mode",
    });

    expect(item.status).toBe("pending");
    expect(item.id).toBeDefined();

    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.status).toBe("pending");
    expect(updated.category).toBe("feature");
    expect(updated.mappedPlanId).toBe("auth-plan");
    expect(updated.proposedTasks).toHaveLength(2);
    expect(updated.taskTitles).toEqual(["Add dark mode toggle", "Implement theme persistence"]);
    // TaskStoreService.create is mocked — feedback source task + 2 tasks
    expect(updated.createdTaskIds).toEqual(["mock-task-1", "mock-task-2"]);
    expect(updated.feedbackSourceTaskId).toBe("mock-feedback-source-1");

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const prompt = mockInvoke.mock.calls[0][0]?.prompt ?? "";
    expect(prompt).toContain("# PRD");
    expect(prompt).toContain("# Plans");
    expect(prompt).toContain("# Existing OPEN/READY tasks");
    expect(prompt).toContain("Users want dark mode");

    const { broadcastToProject } = await import("../websocket/index.js");
    expect(broadcastToProject).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({
        type: "feedback.updated",
        feedbackId: updated.id,
        item: expect.objectContaining({
          id: updated.id,
          status: "pending",
          category: "feature",
        }),
      })
    );
  });

  it("should link to existing tasks when Analyst returns link_to_existing_task_ids", async () => {
    const existingTask = {
      id: "os-abc.1",
      title: "Add dark mode",
      description: "Implement dark mode",
      issue_type: "task",
      status: "open",
    };
    mockTaskStoreReady.mockResolvedValue([existingTask]);
    const { taskStore } = await import("../services/task-store.service.js");
    (taskStore.show as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...existingTask,
      sourceFeedbackIds: [],
    });
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mapped_plan_id: null,
        link_to_existing_task_ids: ["os-abc.1"],
        proposed_tasks: [],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Same as dark mode task - just add it",
    });

    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.createdTaskIds).toEqual(["os-abc.1"]);
    expect(updated.feedbackSourceTaskId).toBeDefined();
    expect(mockTaskStoreCreateWithRetry).not.toHaveBeenCalled();
    expect(mockTaskStoreCreate).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/^Feedback: /),
      expect.objectContaining({ type: "chore" })
    );
    expect(mockTaskStoreAddDependency).toHaveBeenCalledWith(
      projectId,
      "os-abc.1",
      updated.feedbackSourceTaskId,
      "discovered-from"
    );
    expect(taskStore.update).toHaveBeenCalledWith(
      projectId,
      "os-abc.1",
      expect.objectContaining({ extra: { sourceFeedbackIds: [item.id] } })
    );
  });

  it("should merge into existing task when Analyst returns similar_existing_task_id", async () => {
    const existingTask = {
      id: "os-xyz.2",
      title: "Fix login",
      description: "Fix login flow",
      issue_type: "bug",
      status: "open",
    };
    mockTaskStoreReady.mockResolvedValue([existingTask]);
    const { taskStore } = await import("../services/task-store.service.js");
    (taskStore.show as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...existingTask,
      sourceFeedbackIds: [],
    });
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mapped_plan_id: null,
        similar_existing_task_id: "os-xyz.2",
        proposed_tasks: [],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Login is broken on mobile too",
    });

    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.createdTaskIds).toEqual(["os-xyz.2"]);
    expect(mockTaskStoreCreateWithRetry).not.toHaveBeenCalled();
    expect(mockTaskStoreCreate).not.toHaveBeenCalled();
    const updateCall = (taskStore.update as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(updateCall[0]).toBe(projectId);
    expect(updateCall[1]).toBe("os-xyz.2");
    expect(updateCall[2]).toMatchObject({
      extra: { sourceFeedbackIds: [item.id] },
      description: expect.stringContaining("Login is broken on mobile too"),
    });
  });

  it("should fall through to create when similar_existing_task_id is invalid", async () => {
    mockTaskStoreReady.mockResolvedValue([]);
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mapped_plan_id: null,
        similar_existing_task_id: "os-nonexistent",
        proposed_tasks: [{ index: 0, title: "Fix bug", description: "", priority: 0, depends_on: [] }],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Bug with invalid similar task",
    });

    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.createdTaskIds).toHaveLength(1);
    expect(mockTaskStoreCreateWithRetry).toHaveBeenCalled();
  });

  it("should re-enqueue when link_to_existing_task_ids contains invalid task ID", async () => {
    mockTaskStoreReady.mockResolvedValue([]);
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mapped_plan_id: null,
        link_to_existing_task_ids: ["os-nonexistent"],
        proposed_tasks: [],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Link to non-existent task",
    });

    const enqueueSpy = vi.spyOn(feedbackService, "enqueueForCategorization");

    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    expect(enqueueSpy).toHaveBeenCalledWith(projectId, item.id);
    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.createdTaskIds).toEqual([]);
  });

  it("should create tasks when similar_existing_task_id is null (no link)", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mapped_plan_id: null,
        similar_existing_task_id: null,
        proposed_tasks: [{ index: 0, title: "Fix bug", description: "", priority: 0, depends_on: [] }],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, { text: "Bug report" });
    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.createdTaskIds).toHaveLength(1);
    expect(updated.createdTaskIds[0]).toBeDefined();
  });

  it("should parse full PRD 12.3.4 format: proposed_tasks, mapped_epic_id, is_scope_change", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mapped_plan_id: "auth-plan",
        mapped_epic_id: "bd-auth-123",
        is_scope_change: false,
        proposed_tasks: [
          {
            index: 0,
            title: "Add theme toggle",
            description: "Add dark/light toggle to settings",
            priority: 1,
            depends_on: [],
          },
          {
            index: 1,
            title: "Persist theme",
            description: "Save preference to localStorage",
            priority: 2,
            depends_on: [0],
          },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Users want dark mode",
    });

    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.category).toBe("feature");
    expect(updated.mappedPlanId).toBe("auth-plan");
    expect(updated.mappedEpicId).toBe("bd-auth-123");
    expect(updated.isScopeChange).toBe(false);
    expect(updated.proposedTasks).toHaveLength(2);
    expect(updated.proposedTasks![0]).toMatchObject({
      index: 0,
      title: "Add theme toggle",
      description: "Add dark/light toggle to settings",
      priority: 1,
      depends_on: [],
    });
    expect(updated.proposedTasks![1].depends_on).toEqual([0]);
    expect(updated.taskTitles).toEqual(["Add theme toggle", "Persist theme"]);

    // Task store create should be called with description and priority for proposed_tasks
    const taskCreateCalls = mockTaskStoreCreate.mock.calls.filter((c) => c[2]?.type === "feature");
    expect(taskCreateCalls).toHaveLength(2);
    expect(taskCreateCalls[0][2]).toMatchObject({
      type: "feature",
      priority: 1,
      description: "Add dark/light toggle to settings",
    });
    expect(taskCreateCalls[1][2]).toMatchObject({
      type: "feature",
      priority: 2,
      description: "Save preference to localStorage",
    });

    // Inter-task blocks dependency (task 1 depends_on task 0) + 2 discovered-from
    expect(mockTaskStoreAddDependency).toHaveBeenCalledTimes(3);
  });

  it("accepts camelCase proposedTasks with dependsOn, task_title, task_description from Planner", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mapped_plan_id: "auth-plan",
        mapped_epic_id: "bd-auth-123",
        is_scope_change: false,
        proposedTasks: [
          {
            index: 0,
            task_title: "Setup auth",
            task_description: "Create auth module",
            task_priority: 0,
            dependsOn: [],
          },
          {
            index: 1,
            task_title: "Add login",
            task_description: "Login endpoint",
            task_priority: 1,
            dependsOn: [0],
          },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Add authentication",
    });

    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.proposedTasks).toHaveLength(2);
    expect(updated.proposedTasks![0]).toMatchObject({
      index: 0,
      title: "Setup auth",
      description: "Create auth module",
      priority: 0,
      depends_on: [],
    });
    expect(updated.proposedTasks![1]).toMatchObject({
      index: 1,
      title: "Add login",
      description: "Login endpoint",
      priority: 1,
      depends_on: [0],
    });
  });

  it("should set sourceFeedbackIds in extra when creating tasks from feedback", async () => {
    feedbackIdSequence = ["srcfb1"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mapped_plan_id: null,
        proposed_tasks: [
          { index: 0, title: "Task A", description: "A", priority: 1, depends_on: [] },
          { index: 1, title: "Task B", description: "B", priority: 2, depends_on: [0] },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, { text: "Add feature" });
    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const createCalls = mockTaskStoreCreateWithRetry.mock.calls.filter(
      (c) => c[2] && (c[2] as { type?: string }).type === "feature"
    );
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0][2]).toMatchObject({ extra: { sourceFeedbackIds: [item.id] } });
    expect(createCalls[1][2]).toMatchObject({ extra: { sourceFeedbackIds: [item.id] } });
  });

  it("should create exactly one task when proposed_tasks has one item (no feedback source chore)", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mapped_plan_id: null,
        proposed_tasks: [
          {
            index: 0,
            title: "Fix validation",
            description: "Fix form validation",
            priority: 0,
            depends_on: [],
          },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Form validation broken",
    });
    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.createdTaskIds).toHaveLength(1);
    // No feedback source chore when single proposed task — only createWithRetry, no create for chore
    const choreCreates = mockTaskStoreCreate.mock.calls.filter(
      (c) => c[2] && (c[2] as { type?: string }).type === "chore"
    );
    expect(choreCreates).toHaveLength(0);
    expect(mockTaskStoreCreateWithRetry).toHaveBeenCalledTimes(1);
  });

  it("should not create duplicate tasks when processFeedbackWithAnalyst is invoked twice (idempotency)", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mapped_plan_id: null,
        proposed_tasks: [
          { index: 0, title: "Task One", description: "First", priority: 1, depends_on: [] },
          { index: 1, title: "Task Two", description: "Second", priority: 2, depends_on: [0] },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, { text: "Add feature" });
    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const taskCreateCountAfterFirst = mockTaskStoreCreateWithRetry.mock.calls.length;
    expect(taskCreateCountAfterFirst).toBe(2);

    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const taskCreateCountAfterSecond = mockTaskStoreCreateWithRetry.mock.calls.length;
    expect(taskCreateCountAfterSecond).toBe(taskCreateCountAfterFirst);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.createdTaskIds).toHaveLength(2);
  });

  it("should skip Analyst when feedback already has at least one linked task", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    const db = await taskStore.getDb();
    const feedbackId = "already-linked";
    db.run(
      `INSERT INTO feedback (id, project_id, text, category, mapped_plan_id, created_task_ids, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        feedbackId,
        projectId,
        "Already analyzed",
        "bug",
        null,
        JSON.stringify(["os-abc.1"]),
        "pending",
        new Date().toISOString(),
      ]
    );
    mockInvoke.mockClear();

    await feedbackService.processFeedbackWithAnalyst(projectId, feedbackId);

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("should not log when skipping Analyst for feedback that already has linked tasks", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    const db = await taskStore.getDb();
    const feedbackId = "already-linked-no-log";
    db.run(
      `INSERT INTO feedback (id, project_id, text, category, mapped_plan_id, created_task_ids, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        feedbackId,
        projectId,
        "Already analyzed",
        "bug",
        null,
        JSON.stringify(["os-abc.1"]),
        "pending",
        new Date().toISOString(),
      ]
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await feedbackService.processFeedbackWithAnalyst(projectId, feedbackId);

    const skipLogCalls = logSpy.mock.calls.filter(
      (args) =>
        args[0]?.includes?.("Skipping Analyst") && args[0]?.includes?.("linked tasks")
    );
    expect(skipLogCalls).toHaveLength(0);
    logSpy.mockRestore();
  });

  it("should deduplicate proposed tasks when Analyst returns duplicate titles", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mapped_plan_id: null,
        proposed_tasks: [
          { index: 0, title: "Fix login bug", description: "Fix", priority: 0, depends_on: [] },
          {
            index: 1,
            title: "Fix login bug",
            description: "Duplicate",
            priority: 0,
            depends_on: [],
          },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, { text: "Login broken" });
    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.createdTaskIds).toHaveLength(1);
    expect(updated.proposedTasks).toHaveLength(1);
    expect(updated.proposedTasks![0].title).toBe("Fix login bug");

    const taskCreateCalls = mockTaskStoreCreateWithRetry.mock.calls.filter(
      (c) => c[2] && (c[2] as { type?: string }).type === "bug"
    );
    expect(taskCreateCalls).toHaveLength(1);
  });

  it("should deduplicate task_titles when Analyst returns duplicate titles (legacy path)", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mapped_plan_id: null,
        task_titles: ["Add dark mode", "Add dark mode", "Add dark mode"],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, { text: "Dark mode please" });
    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.createdTaskIds).toHaveLength(1);

    const taskCreateCalls = mockTaskStoreCreateWithRetry.mock.calls.filter(
      (c) => c[2] && (c[2] as { type?: string }).type === "feature"
    );
    expect(taskCreateCalls).toHaveLength(1);
  });

  it("should not create duplicate tasks when processFeedbackWithAnalyst is invoked twice (idempotency)", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mapped_plan_id: null,
        proposed_tasks: [
          { index: 0, title: "Task One", description: "First", priority: 1, depends_on: [] },
          { index: 1, title: "Task Two", description: "Second", priority: 2, depends_on: [0] },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, { text: "Add feature" });
    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const taskCreateCountAfterFirst = mockTaskStoreCreateWithRetry.mock.calls.length;
    expect(taskCreateCountAfterFirst).toBe(2);

    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const taskCreateCountAfterSecond = mockTaskStoreCreateWithRetry.mock.calls.length;
    expect(taskCreateCountAfterSecond).toBe(taskCreateCountAfterFirst);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.createdTaskIds).toHaveLength(2);
  });

  it("should deduplicate proposed tasks when Analyst returns duplicate titles", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mapped_plan_id: null,
        proposed_tasks: [
          { index: 0, title: "Fix login bug", description: "Fix", priority: 0, depends_on: [] },
          {
            index: 1,
            title: "Fix login bug",
            description: "Duplicate",
            priority: 0,
            depends_on: [],
          },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, { text: "Login broken" });
    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.createdTaskIds).toHaveLength(1);
    expect(updated.proposedTasks).toHaveLength(1);
    expect(updated.proposedTasks![0].title).toBe("Fix login bug");

    const taskCreateCalls = mockTaskStoreCreateWithRetry.mock.calls.filter(
      (c) => c[2] && (c[2] as { type?: string }).type === "bug"
    );
    expect(taskCreateCalls).toHaveLength(1);
  });

  it("should deduplicate task_titles when Analyst returns duplicate titles (legacy path)", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mapped_plan_id: null,
        task_titles: ["Add dark mode", "Add dark mode", "Add dark mode"],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, { text: "Dark mode please" });
    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.createdTaskIds).toHaveLength(1);

    const taskCreateCalls = mockTaskStoreCreateWithRetry.mock.calls.filter(
      (c) => c[2] && (c[2] as { type?: string }).type === "feature"
    );
    expect(taskCreateCalls).toHaveLength(1);
  });

  it("should create at least one task when AI returns empty proposed_tasks and task_titles (UX categorized)", async () => {
    // Prompt allows "propose_tasks: [] with a generic title" for vague feedback; if model returns task_titles: [] too we must still create a task
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "ux",
        mapped_plan_id: "some-plan",
        mapped_epic_id: "bd-epic-1",
        is_scope_change: false,
        proposed_tasks: [],
        task_titles: [],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Hovering over the upload image button should show the tooltip 'Attach image(s)'",
    });

    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.status).toBe("pending");
    expect(updated.category).toBe("ux");
    expect(updated.createdTaskIds.length).toBeGreaterThanOrEqual(1);
    expect(updated.createdTaskIds[0]).toBeDefined();
    // Fallback uses feedback text as title (truncated to 80 chars)
    expect(updated.taskTitles).toEqual([
      "Hovering over the upload image button should show the tooltip 'Attach image(s)'",
    ]);
  });

  it("should trigger HIL when is_scope_change is true even if category is not scope", async () => {
    feedbackIdSequence = ["xyz123"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mapped_plan_id: null,
        mapped_epic_id: null,
        is_scope_change: true,
        proposed_tasks: [
          {
            index: 0,
            title: "Add mobile platform",
            description: "...",
            priority: 1,
            depends_on: [],
          },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "We need a native mobile app",
    });

    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    expect(mockGetScopeChangeProposal).toHaveBeenCalledWith(
      projectId,
      "We need a native mobile app"
    );
    expect(mockHilEvaluate).toHaveBeenCalledTimes(1);
  });

  it("should fallback to bug and first plan when agent returns invalid JSON", async () => {
    mockInvoke.mockResolvedValue({ content: "This is not valid JSON at all" });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Something broke",
    });

    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.status).toBe("pending");
    expect(updated.category).toBe("bug");
    expect(updated.taskTitles).toEqual(["Something broke"]);
  });

  it("should fallback to bug when agent throws", async () => {
    mockInvoke.mockRejectedValue(new Error("Agent timeout"));

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Random feedback",
    });

    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.status).toBe("pending");
    expect(updated.category).toBe("bug");
    expect(updated.taskTitles).toEqual(["Random feedback"]);
  });

  it("should create bug-type task when category is bug", async () => {
    feedbackIdSequence = ["xyz123"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mapped_plan_id: null,
        proposed_tasks: [
          { index: 0, title: "Fix login button", description: "", priority: 0, depends_on: [] },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, { text: "Login broken" });
    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const createCalls = mockTaskStoreCreate.mock.calls;
    const bugCreateCall = createCalls.find((c) => c[2]?.type === "bug");
    expect(bugCreateCall).toBeDefined();
    expect(bugCreateCall![2]).toMatchObject({ type: "bug" });
  });

  it("should create feature-type task when category is feature", async () => {
    feedbackIdSequence = ["xyz123"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mapped_plan_id: null,
        proposed_tasks: [
          { index: 0, title: "Add dark mode", description: "", priority: 1, depends_on: [] },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, { text: "Need dark mode" });
    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const createCalls = mockTaskStoreCreate.mock.calls;
    // First call: feedback source (chore); second: task
    const taskCreateCall = createCalls.find((c) => c[2]?.type === "feature");
    expect(taskCreateCall).toBeDefined();
    expect(taskCreateCall![2]).toMatchObject({ type: "feature" });
  });

  it("should handle null from createWithRetry (exclude from createdIds)", async () => {
    feedbackIdSequence = ["xyz123"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mapped_plan_id: null,
        proposed_tasks: [
          { index: 0, title: "Task A", description: "", priority: 0, depends_on: [] },
          { index: 1, title: "Task B", description: "", priority: 0, depends_on: [0] },
        ],
      }),
    });
    let callCount = 0;
    mockTaskStoreCreateWithRetry.mockImplementation((...args: unknown[]) => {
      callCount++;
      if (callCount === 2) return Promise.resolve(null);
      return mockTaskStoreCreate(...(args as [string, string, unknown]));
    });

    const item = await feedbackService.submitFeedback(projectId, { text: "Bug report" });
    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.createdTaskIds).toHaveLength(1);
  });

  it("should call createWithRetry with fallbackToStandalone: true for task creation", async () => {
    feedbackIdSequence = ["xyz123"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mapped_plan_id: null,
        proposed_tasks: [
          { index: 0, title: "Task A", description: "", priority: 1, depends_on: [] },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, { text: "Add feature" });
    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const createWithRetryCalls = mockTaskStoreCreateWithRetry.mock.calls;
    expect(createWithRetryCalls.length).toBeGreaterThanOrEqual(1);
    const taskCreateCall = createWithRetryCalls.find(
      (c) => c[1] === "Task A" && (c[2] as { type?: string })?.type === "feature"
    );
    expect(taskCreateCall).toBeDefined();
    expect(taskCreateCall![3]).toEqual({ fallbackToStandalone: true });
  });

  it("should add discovered-from dependency from each task to feedback source task", async () => {
    feedbackIdSequence = ["xyz123"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mapped_plan_id: null,
        proposed_tasks: [
          { index: 0, title: "Task A", description: "", priority: 1, depends_on: [] },
          { index: 1, title: "Task B", description: "", priority: 1, depends_on: [0] },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, { text: "Add feature" });
    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    // 2 discovered-from (each task → feedback source) + 1 blocks (task B → task A)
    expect(mockTaskStoreAddDependency).toHaveBeenCalledTimes(3);
    expect(mockTaskStoreAddDependency).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      "mock-task-1",
      "mock-feedback-source-1",
      "discovered-from"
    );
    expect(mockTaskStoreAddDependency).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      "mock-task-2",
      "mock-feedback-source-1",
      "discovered-from"
    );
  });

  it("should store image attachments when provided", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mappedPlanId: null,
        task_titles: ["Fix screenshot bug"],
      }),
    });

    const base64Image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const item = await feedbackService.submitFeedback(projectId, {
      text: "Bug with screenshot",
      images: [`data:image/png;base64,${base64Image}`],
    });

    expect(item.id).toBeDefined();
    expect(item.text).toBe("Bug with screenshot");

    const stored = await feedbackService.getFeedback(projectId, item.id);
    expect(stored.images).toBeDefined();
    expect(stored.images).toHaveLength(1);
    expect(stored.images![0]).toContain("data:image/png;base64,");
  });

  it("should create feedback source task (chore) for provenance", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "ux",
        mappedPlanId: null,
        task_titles: ["Improve button layout"],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, { text: "Buttons are cramped" });
    await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

    const createCalls = mockTaskStoreCreate.mock.calls;
    const feedbackSourceCall = createCalls[0];
    expect(feedbackSourceCall[1]).toMatch(/^Feedback: /);
    expect(feedbackSourceCall[2]).toMatchObject({ type: "chore", priority: 4 });
  });

  describe("Scope change feedback (category=scope) with HIL", () => {
    it("should call getScopeChangeProposal and HIL evaluateDecision when category is scope", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          category: "scope",
          mappedPlanId: null,
          task_titles: ["Update PRD for new requirements"],
        }),
      });

      const item = await feedbackService.submitFeedback(projectId, {
        text: "We need to add a mobile app as a new platform",
      });

      await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

      expect(mockGetScopeChangeProposal).toHaveBeenCalledWith(
        projectId,
        "We need to add a mobile app as a new platform"
      );
      expect(mockHilEvaluate).toHaveBeenCalledTimes(1);
      const hilCall = mockHilEvaluate.mock.calls[0];
      expect(hilCall[0]).toBe(projectId);
      expect(hilCall[1]).toBe("scopeChanges");
      expect(hilCall[2]).toContain(
        "A user submitted feedback that was categorized as a scope change"
      );
      expect(hilCall[2]).toContain(
        "Please review the proposed PRD updates below and approve or reject"
      );
      expect(hilCall[2]).toContain("We need to add a mobile app as a new platform");
      expect(hilCall[3]).toHaveLength(2);
      expect(hilCall[3][0]).toMatchObject({
        id: "approve",
        label: "Approve",
        description: "Apply the proposed PRD updates",
      });
      expect(hilCall[3][1]).toMatchObject({
        id: "reject",
        label: "Reject",
        description: "Skip updates and do not modify the PRD",
      });
    });

    it("should pass scopeChangeMetadata to HIL when getScopeChangeProposal returns proposal", async () => {
      const proposal = {
        summary: "• feature_list: Add mobile app",
        prdUpdates: [
          { section: "feature_list", content: "New content", changeLogEntry: "Add mobile app" },
        ],
      };
      mockGetScopeChangeProposal.mockResolvedValue(proposal);
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          category: "scope",
          mappedPlanId: null,
          task_titles: ["Update PRD"],
        }),
      });
      mockHilEvaluate.mockResolvedValue({ approved: true });

      const item = await feedbackService.submitFeedback(projectId, {
        text: "Add mobile app",
      });

      await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

      expect(mockHilEvaluate).toHaveBeenCalledWith(
        projectId,
        "scopeChanges",
        expect.stringContaining("Add mobile app"),
        expect.arrayContaining([
          expect.objectContaining({ id: "approve", label: "Approve" }),
          expect.objectContaining({ id: "reject", label: "Reject" }),
        ]),
        true,
        {
          scopeChangeSummary: "• feature_list: Add mobile app",
          scopeChangeProposedUpdates: [
            { section: "feature_list", changeLogEntry: "Add mobile app" },
          ],
        }
      );
      expect(mockApplyScopeChangeUpdates).toHaveBeenCalledWith(
        projectId,
        proposal.prdUpdates,
        expect.stringContaining("Add mobile app")
      );
    });

    it("should not call syncPrdFromScopeChangeFeedback when HIL rejects", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          category: "scope",
          mappedPlanId: null,
          task_titles: ["Update PRD"],
        }),
      });
      mockHilEvaluate.mockResolvedValue({ approved: false });

      const item = await feedbackService.submitFeedback(projectId, {
        text: "Add mobile support - fundamental scope change",
      });

      await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

      expect(mockSyncPrdFromScopeChange).not.toHaveBeenCalled();
      expect(mockTaskStoreCreate).not.toHaveBeenCalled();
    });

    it("should truncate long feedback in scope change HIL description", async () => {
      const longFeedback = "A".repeat(250);
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          category: "scope",
          mappedPlanId: null,
          task_titles: ["Update PRD"],
        }),
      });

      const item = await feedbackService.submitFeedback(projectId, { text: longFeedback });

      await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

      const hilDesc = mockHilEvaluate.mock.calls[0][2];
      expect(hilDesc).toContain("A".repeat(200) + "…");
      expect(hilDesc).not.toContain("A".repeat(250));
    });

    it("should call syncPrdFromScopeChangeFeedback and create tasks when HIL approves", async () => {
      mockGetScopeChangeProposal.mockResolvedValue(null);
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          category: "scope",
          mappedPlanId: null,
          task_titles: ["Update PRD for mobile platform", "Add mobile architecture section"],
        }),
      });
      mockHilEvaluate.mockResolvedValue({ approved: true });

      const item = await feedbackService.submitFeedback(projectId, {
        text: "Add mobile app as a new platform - scope change",
      });

      await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

      expect(mockSyncPrdFromScopeChange).toHaveBeenCalledTimes(1);
      expect(mockSyncPrdFromScopeChange).toHaveBeenCalledWith(
        projectId,
        "Add mobile app as a new platform - scope change"
      );
      expect(mockTaskStoreCreate).toHaveBeenCalled();
    });
  });

  describe("Evaluate phase agent registry", () => {
    it("should register and unregister Feedback categorization agent on success", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          category: "feature",
          mappedPlanId: null,
          task_titles: ["Add feature"],
        }),
      });

      const item = await feedbackService.submitFeedback(projectId, { text: "Add feature" });
      await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockRegister).toHaveBeenCalledWith(
        expect.stringMatching(/^feedback-categorize-.*-/),
        projectId,
        "eval",
        "analyst",
        "Feedback categorization",
        expect.any(String),
        undefined
      );
      expect(mockUnregister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledWith(mockRegister.mock.calls[0][0]);
    });

    it("should unregister even when agent invocation throws", async () => {
      mockInvoke.mockRejectedValue(new Error("Agent timeout"));

      const item = await feedbackService.submitFeedback(projectId, { text: "Random feedback" });
      await feedbackService.processFeedbackWithAnalyst(projectId, item.id);

      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledWith(mockRegister.mock.calls[0][0]);
    });
  });

  describe("checkAutoResolveOnTaskDone (PRD §10.2)", () => {
    it("should auto-resolve feedback when all created tasks are closed and setting enabled", async () => {
      const storePath = path.join(tempDir, ".opensprint", "settings.json");
      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        { settings: { deployment?: { autoResolveFeedbackOnTaskCompletion?: boolean } } }
      >;
      const entry = store[projectId];
      if (entry?.settings) {
        entry.settings.deployment = entry.settings.deployment ?? {};
        entry.settings.deployment.autoResolveFeedbackOnTaskCompletion = true;
        await fs.writeFile(storePath, JSON.stringify(store), "utf-8");
      }

      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-auto-1",
          text: "Bug in login",
          category: "bug",
          mappedPlanId: "plan-1",
          createdTaskIds: ["task-1", "task-2"],
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        null
      );

      mockTaskStoreListAll.mockResolvedValue([
        { id: "task-1", status: "closed" },
        { id: "task-2", status: "closed" },
      ]);

      await feedbackService.checkAutoResolveOnTaskDone(projectId, "task-1");

      const stored = await feedbackService.getFeedback(projectId, "fb-auto-1");
      expect(stored.status).toBe("resolved");
    });

    it("should not resolve when autoResolveFeedbackOnTaskCompletion is false", async () => {
      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-auto-2",
          text: "Bug",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: ["task-1"],
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        null
      );

      mockTaskStoreListAll.mockResolvedValue([{ id: "task-1", status: "closed" }]);

      await feedbackService.checkAutoResolveOnTaskDone(projectId, "task-1");

      const stored = await feedbackService.getFeedback(projectId, "fb-auto-2");
      expect(stored.status).toBe("pending");
    });

    it("should not resolve when not all created tasks are closed", async () => {
      const storePath = path.join(tempDir, ".opensprint", "settings.json");
      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        { settings: { deployment?: { autoResolveFeedbackOnTaskCompletion?: boolean } } }
      >;
      const entry = store[projectId];
      if (entry?.settings) {
        entry.settings.deployment = entry.settings.deployment ?? {};
        entry.settings.deployment.autoResolveFeedbackOnTaskCompletion = true;
        await fs.writeFile(storePath, JSON.stringify(store), "utf-8");
      }

      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-auto-3",
          text: "Bug",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: ["task-1", "task-2"],
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        null
      );

      mockTaskStoreListAll.mockResolvedValue([
        { id: "task-1", status: "closed" },
        { id: "task-2", status: "open" },
      ]);

      await feedbackService.checkAutoResolveOnTaskDone(projectId, "task-1");

      const stored = await feedbackService.getFeedback(projectId, "fb-auto-3");
      expect(stored.status).toBe("pending");
    });
  });

  describe("cancelFeedback", () => {
    it("should set status to cancelled and delete associated tasks", async () => {
      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-cancel-1",
          text: "Cancel me",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: ["task-a", "task-b"],
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        null
      );

      const { taskStore } = await import("../services/task-store.service.js");
      const { broadcastToProject } = await import("../websocket/index.js");

      const result = await feedbackService.cancelFeedback(projectId, "fb-cancel-1");

      expect(result.status).toBe("cancelled");
      const stored = await feedbackService.getFeedback(projectId, "fb-cancel-1");
      expect(stored.status).toBe("cancelled");

      expect(taskStore.deleteMany).toHaveBeenCalledWith(projectId, ["task-a", "task-b"]);

      expect(broadcastToProject).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          type: "feedback.resolved",
          feedbackId: "fb-cancel-1",
          item: expect.objectContaining({
            id: "fb-cancel-1",
            status: "cancelled",
          }),
        })
      );
    });

    it("should return item unchanged when already resolved", async () => {
      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-cancel-2",
          text: "Already resolved",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "resolved",
          createdAt: new Date().toISOString(),
        },
        null
      );

      const { taskStore } = await import("../services/task-store.service.js");
      const result = await feedbackService.cancelFeedback(projectId, "fb-cancel-2");

      expect(result.status).toBe("resolved");
      expect(taskStore.deleteMany).not.toHaveBeenCalled();
    });

    it("should not call deleteMany when feedback has no linked tasks", async () => {
      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-cancel-3",
          text: "No tasks",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        null
      );

      const { taskStore } = await import("../services/task-store.service.js");
      const result = await feedbackService.cancelFeedback(projectId, "fb-cancel-3");

      expect(result.status).toBe("cancelled");
      expect(taskStore.deleteMany).not.toHaveBeenCalled();
    });

    it("should delete feedbackSourceTaskId when present", async () => {
      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-cancel-4",
          text: "Cancel with source task",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: ["task-x"],
          feedbackSourceTaskId: "chore-feedback-source",
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        null
      );

      const { taskStore } = await import("../services/task-store.service.js");
      const result = await feedbackService.cancelFeedback(projectId, "fb-cancel-4");

      expect(result.status).toBe("cancelled");
      expect(taskStore.deleteMany).toHaveBeenCalledWith(projectId, [
        "task-x",
        "chore-feedback-source",
      ]);
    });
  });

  describe("resolveFeedback cascade (parent → children)", () => {
    it("should cascade resolve single-level children when parent is resolved", async () => {
      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-parent-1",
          text: "Parent bug",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        null
      );
      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-child-1",
          text: "Child reply",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: new Date().toISOString(),
          parent_id: "fb-parent-1",
          depth: 1,
        },
        null
      );

      const { broadcastToProject } = await import("../websocket/index.js");

      const result = await feedbackService.resolveFeedback(projectId, "fb-parent-1");

      expect(result.status).toBe("resolved");
      const storedParent = await feedbackService.getFeedback(projectId, "fb-parent-1");
      const storedChild = await feedbackService.getFeedback(projectId, "fb-child-1");
      expect(storedParent.status).toBe("resolved");
      expect(storedChild.status).toBe("resolved");

      // Broadcasts include full item so frontend can update in place without refetch
      expect(broadcastToProject).toHaveBeenCalledWith(
        projectId,
        expect.objectContaining({
          type: "feedback.resolved",
          feedbackId: "fb-parent-1",
          item: expect.objectContaining({
            id: "fb-parent-1",
            status: "resolved",
          }),
        })
      );
      const childCalls = (broadcastToProject as ReturnType<typeof vi.fn>).mock.calls.filter(
        (call: unknown[]) => (call[1] as { feedbackId?: string }).feedbackId === "fb-child-1"
      );
      expect(childCalls.length).toBe(1);
      expect((childCalls[0][1] as { item: { id: string; status: string } }).item).toMatchObject({
        id: "fb-child-1",
        status: "resolved",
      });
    });

    it("should cascade resolve recursively (grandchildren)", async () => {
      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-parent-2",
          text: "Parent",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        null
      );
      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-child-2",
          text: "Child",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: new Date().toISOString(),
          parent_id: "fb-parent-2",
          depth: 1,
        },
        null
      );
      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-grandchild-2",
          text: "Grandchild",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: new Date().toISOString(),
          parent_id: "fb-child-2",
          depth: 2,
        },
        null
      );

      await feedbackService.resolveFeedback(projectId, "fb-parent-2");

      const storedParent = await feedbackService.getFeedback(projectId, "fb-parent-2");
      const storedChild = await feedbackService.getFeedback(projectId, "fb-child-2");
      const storedGrandchild = await feedbackService.getFeedback(projectId, "fb-grandchild-2");
      expect(storedParent.status).toBe("resolved");
      expect(storedChild.status).toBe("resolved");
      expect(storedGrandchild.status).toBe("resolved");
    });

    it("should leave already-resolved children as resolved (no-op)", async () => {
      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-parent-3",
          text: "Parent",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        null
      );
      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-child-3",
          text: "Already resolved child",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "resolved",
          createdAt: new Date().toISOString(),
          parent_id: "fb-parent-3",
          depth: 1,
        },
        null
      );

      await feedbackService.resolveFeedback(projectId, "fb-parent-3");

      const storedChild = await feedbackService.getFeedback(projectId, "fb-child-3");
      expect(storedChild.status).toBe("resolved");
    });

    it("should NOT resolve parent or siblings when resolving a child independently", async () => {
      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-parent-4",
          text: "Parent",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: new Date().toISOString(),
        },
        null
      );
      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-child-4a",
          text: "Child 1",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: new Date().toISOString(),
          parent_id: "fb-parent-4",
          depth: 1,
        },
        null
      );
      await feedbackStore.insertFeedback(
        projectId,
        {
          id: "fb-child-4b",
          text: "Child 2",
          category: "bug",
          mappedPlanId: null,
          createdTaskIds: [],
          status: "pending",
          createdAt: new Date().toISOString(),
          parent_id: "fb-parent-4",
          depth: 1,
        },
        null
      );

      await feedbackService.resolveFeedback(projectId, "fb-child-4a");

      const storedParent = await feedbackService.getFeedback(projectId, "fb-parent-4");
      const storedChild1 = await feedbackService.getFeedback(projectId, "fb-child-4a");
      const storedChild2 = await feedbackService.getFeedback(projectId, "fb-child-4b");
      expect(storedParent.status).toBe("pending");
      expect(storedChild1.status).toBe("resolved");
      expect(storedChild2.status).toBe("pending");
    });
  });
});
