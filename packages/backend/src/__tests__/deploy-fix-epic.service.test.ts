import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createFixEpicFromTestOutput } from "../services/deploy-fix-epic.service.js";
import { ProjectService } from "../services/project.service.js";
import { TaskStoreService } from "../services/task-store.service.js";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";

const {
  mockInvoke,
  mockTaskStoreCreate,
  mockTaskStoreCreateWithRetry,
  mockTaskStoreUpdate,
  mockTaskStoreAddDependency,
  mockTaskStoreClose,
  mockTaskStoreReady,
  mockTaskStoreInit,
  mockTaskStoreListAll,
  mockPlanInsert,
} = vi.hoisted(() => {
  const mockInvoke = vi.fn().mockResolvedValue({
    content: JSON.stringify({
      status: "success",
      tasks: [
        {
          index: 0,
          title: "Fix auth test",
          description: "Fix failing auth test",
          priority: 1,
          depends_on: [],
        },
        {
          index: 1,
          title: "Fix API test",
          description: "Fix API endpoint test",
          priority: 1,
          depends_on: [0],
        },
      ],
    }),
  });
  const mockTaskStoreCreate = vi.fn();
  const mockTaskStoreCreateWithRetry = vi.fn();
  const mockTaskStoreUpdate = vi.fn();
  const mockTaskStoreAddDependency = vi.fn();
  const mockTaskStoreClose = vi.fn();
  const mockTaskStoreReady = vi.fn();
  const mockTaskStoreInit = vi.fn().mockResolvedValue(undefined);
  const mockTaskStoreListAll = vi.fn().mockResolvedValue([]);
  const mockPlanInsert = vi.fn().mockResolvedValue(undefined);
  return {
    mockInvoke,
    mockTaskStoreCreate,
    mockTaskStoreCreateWithRetry,
    mockTaskStoreUpdate,
    mockTaskStoreAddDependency,
    mockTaskStoreClose,
    mockTaskStoreReady,
    mockTaskStoreInit,
    mockTaskStoreListAll,
    mockPlanInsert,
  };
});

vi.mock("../services/agent-client.js", () => ({
  AgentClient: vi.fn().mockImplementation(() => ({ invoke: mockInvoke })),
}));

vi.mock("../services/task-store.service.js", () => {
  const mockInstance = {
    init: mockTaskStoreInit,
    listAll: mockTaskStoreListAll,
    create: mockTaskStoreCreate,
    createWithRetry: mockTaskStoreCreateWithRetry,
    update: mockTaskStoreUpdate,
    addDependency: mockTaskStoreAddDependency,
    close: mockTaskStoreClose,
    ready: mockTaskStoreReady,
    planInsert: mockPlanInsert,
    syncForPush: vi.fn().mockResolvedValue(undefined),
  };
  return {
    TaskStoreService: vi.fn().mockImplementation(() => mockInstance),
    taskStore: mockInstance,
  };
});

describe("deploy-fix-epic service", () => {
  let tempDir: string;
  let projectId: string;
  let projectService: ProjectService;
  let originalHome: string | undefined;

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    mockTaskStoreCreate.mockClear();
    mockTaskStoreCreateWithRetry.mockClear();
    mockTaskStoreUpdate.mockClear();
    mockTaskStoreAddDependency.mockClear();
    mockTaskStoreClose.mockClear();
    mockPlanInsert.mockClear();
    mockTaskStoreCreate.mockImplementation(
      (_repo: string, _title: string, opts?: { type?: string; parentId?: string }) => {
        const id = opts?.parentId
          ? `${opts.parentId}.${Math.floor(Math.random() * 1000)}`
          : `epic-${Date.now()}`;
        return Promise.resolve({ id });
      }
    );
    mockTaskStoreCreateWithRetry.mockImplementation(
      (repo: string, title: string, opts?: { type?: string; parentId?: string }) =>
        mockTaskStoreCreate(repo, title, opts)
    );
    mockTaskStoreUpdate.mockResolvedValue(undefined);
    mockTaskStoreAddDependency.mockResolvedValue(undefined);
    mockTaskStoreClose.mockResolvedValue(undefined);
    mockTaskStoreReady.mockResolvedValue([
      { id: "fix-1", title: "Fix auth test", status: "ready" },
    ]);

    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        status: "success",
        tasks: [
          {
            index: 0,
            title: "Fix auth test",
            description: "Fix failing auth test",
            priority: 1,
            depends_on: [],
          },
          {
            index: 1,
            title: "Fix API test",
            description: "Fix API endpoint test",
            priority: 1,
            depends_on: [0],
          },
        ],
      }),
    });
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "deploy-fix-epic-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    projectService = new ProjectService();

    const repoPath = path.join(tempDir, "proj");
    await fs.mkdir(repoPath, { recursive: true });
    await fs.writeFile(
      path.join(repoPath, "package.json"),
      JSON.stringify({ name: "test", scripts: { test: "echo ok" } })
    );

    const project = await projectService.createProject({
      name: "Fix Epic Test",
      repoPath,
      simpleComplexityAgent: { type: "custom", model: null, cliCommand: "echo" },
      complexComplexityAgent: { type: "custom", model: null, cliCommand: "echo" },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;
  });

  it("returns null when agent returns failed status", async () => {
    mockInvoke.mockResolvedValueOnce({
      content: JSON.stringify({ status: "failed", tasks: [] }),
    });

    const project = await projectService.getProject(projectId);
    const result = await createFixEpicFromTestOutput(
      projectId,
      project.repoPath,
      "FAIL  src/auth.test.ts"
    );

    expect(result).toBeNull();
  });

  it("returns null when create fails for epic", async () => {
    mockTaskStoreCreate.mockResolvedValueOnce(null);

    const project = await projectService.getProject(projectId);
    const result = await createFixEpicFromTestOutput(
      projectId,
      project.repoPath,
      "FAIL  src/auth.test.ts"
    );

    expect(result).toBeNull();
  });

  it("returns null when createWithRetry fails for a fix task", async () => {
    mockTaskStoreCreateWithRetry
      .mockResolvedValueOnce({ id: "task-1" })
      .mockResolvedValueOnce(null);

    const project = await projectService.getProject(projectId);
    const result = await createFixEpicFromTestOutput(
      projectId,
      project.repoPath,
      "FAIL  src/auth.test.ts"
    );

    expect(result).toBeNull();
  });

  it("creates fix epic and tasks when agent returns valid tasks", async () => {
    const project = await projectService.getProject(projectId);
    const result = await createFixEpicFromTestOutput(
      projectId,
      project.repoPath,
      "FAIL  src/auth.test.ts\n  Expected: true\n  Received: false"
    );

    expect(result).not.toBeNull();
    expect(result!.epicId).toBeDefined();
    expect(result!.taskCount).toBe(2);

    expect(mockTaskStoreCreate).toHaveBeenCalledWith(
      projectId,
      "Fix: pre-deploy test failures",
      expect.objectContaining({ type: "epic" })
    );
    expect(mockTaskStoreUpdate).toHaveBeenCalledWith(
      projectId,
      expect.any(String),
      expect.objectContaining({ status: "open" })
    );
    expect(mockTaskStoreCreateWithRetry).toHaveBeenCalledTimes(2);
    const createWithRetryCalls = mockTaskStoreCreateWithRetry.mock.calls;
    expect(createWithRetryCalls[0][1]).toBe("Fix auth test");
    expect(createWithRetryCalls[1][1]).toBe("Fix API test");
    expect(mockTaskStoreClose).not.toHaveBeenCalled();

    // planInsert called without gate_task_id (deploy fix epics have no gate)
    expect(mockPlanInsert).toHaveBeenCalledTimes(1);
    const planInsertCall = mockPlanInsert.mock.calls[0];
    expect(planInsertCall[0]).toBe(projectId);
    expect(planInsertCall[2]).toMatchObject({
      epic_id: expect.any(String),
      content: expect.any(String),
      metadata: expect.any(String),
    });
    expect(planInsertCall[2]).not.toHaveProperty("gate_task_id");

    const taskStore = new TaskStoreService();
    const ready = await taskStore.ready(projectId);
    expect(ready.length).toBeGreaterThan(0);
  });

  it("deploy fix epic: epic status open, no gate task, planInsert without gate_task_id", async () => {
    const project = await projectService.getProject(projectId);
    await createFixEpicFromTestOutput(projectId, project.repoPath, "FAIL  src/auth.test.ts");

    // Epic created with status "open" (auto-approved, no gate)
    const updateCalls = mockTaskStoreUpdate.mock.calls;
    const statusOpenCall = updateCalls.find((c) => c[2]?.status === "open");
    expect(statusOpenCall).toBeDefined();

    // No gate: close never called
    expect(mockTaskStoreClose).not.toHaveBeenCalled();

    // planInsert without gate_task_id
    expect(mockPlanInsert).toHaveBeenCalledTimes(1);
    const planData = mockPlanInsert.mock.calls[0][2];
    expect(planData).not.toHaveProperty("gate_task_id");
    expect(planData).not.toHaveProperty("re_execute_gate_task_id");
  });
});
