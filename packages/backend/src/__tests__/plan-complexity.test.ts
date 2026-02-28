import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  getPlanComplexityForTask,
  getTaskComplexity,
  getComplexityForAgent,
  planComplexityToTask,
} from "../services/plan-complexity.js";
import {
  taskStore as taskStoreSingleton,
  type TaskStoreService,
} from "../services/task-store.service.js";

const TEST_PROJECT_ID = "test-project";

// Use in-memory DB so we don't touch ~/.opensprint/tasks.db (avoids ENOENT when other tests change HOME)
vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/task-store.service.js")>();
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const sharedDb = new SQL.Database();
  sharedDb.run(actual.SCHEMA_SQL);
  const store = new actual.TaskStoreService(sharedDb);
  await store.init();
  const reset = () => {
    sharedDb.run("DELETE FROM task_dependencies");
    sharedDb.run("DELETE FROM tasks");
    sharedDb.run("DELETE FROM plans");
  };
  return {
    ...actual,
    taskStore: store,
    _resetPlanComplexityDb: reset,
  };
});

describe("getPlanComplexityForTask", () => {
  let tempDir: string;
  let taskStore: TaskStoreService;

  beforeEach(async () => {
    const mod = (await import("../services/task-store.service.js")) as unknown as {
      _resetPlanComplexityDb?: () => void;
    };
    mod._resetPlanComplexityDb?.();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-complexity-"));
    taskStore = taskStoreSingleton;

    // Initialize git and task store
    const { execSync } = await import("child_process");
    execSync("git init", { cwd: tempDir });
    execSync("git config user.email test@test.com", { cwd: tempDir });
    execSync("git config user.name Test", { cwd: tempDir });
    await taskStore.init();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should return the complexity from the parent epic's plan metadata", async () => {
    const planId = `test-plan-${Date.now()}`;
    const epic = await taskStore.create(TEST_PROJECT_ID, "Test Epic", {
      type: "epic",
      priority: 1,
      description: planId,
    });

    await taskStore.planInsert(TEST_PROJECT_ID, planId, {
      epic_id: epic.id,
      content: "# Test Plan",
      metadata: JSON.stringify({
        planId,
        epicId: epic.id,
        shippedAt: null,
        complexity: "high",
      }),
    });

    const child = await taskStore.create(TEST_PROJECT_ID, "Child Task", {
      type: "task",
      priority: 1,
      description: "Implement something",
      parentId: epic.id,
    });

    const task = await taskStore.show(TEST_PROJECT_ID, child.id);
    const complexity = await getPlanComplexityForTask(TEST_PROJECT_ID, tempDir, task, taskStore);
    expect(complexity).toBe("high");
  });

  it("should return undefined when task has no parent", async () => {
    const standalone = await taskStore.create(TEST_PROJECT_ID, "Standalone Task", {
      type: "task",
      priority: 1,
      description: "No parent",
    });

    const task = await taskStore.show(TEST_PROJECT_ID, standalone.id);
    const complexity = await getPlanComplexityForTask(TEST_PROJECT_ID, tempDir, task, taskStore);
    expect(complexity).toBeUndefined();
  });

  it("should return undefined when parent has no plan metadata", async () => {
    const epic = await taskStore.create(TEST_PROJECT_ID, "Epic Without Plan", {
      type: "epic",
      priority: 1,
      description: "Just a description, not a plan path",
    });

    const child = await taskStore.create(TEST_PROJECT_ID, "Child Task", {
      type: "task",
      priority: 1,
      description: "Task under no-plan epic",
      parentId: epic.id,
    });

    const task = await taskStore.show(TEST_PROJECT_ID, child.id);
    const complexity = await getPlanComplexityForTask(TEST_PROJECT_ID, tempDir, task, taskStore);
    expect(complexity).toBeUndefined();
  });

  it("should return undefined when metadata has invalid complexity", async () => {
    const planId = `bad-plan-${Date.now()}`;
    const epic = await taskStore.create(TEST_PROJECT_ID, "Bad Complexity Epic", {
      type: "epic",
      priority: 1,
      description: planId,
    });

    await taskStore.planInsert(TEST_PROJECT_ID, planId, {
      epic_id: epic.id,
      content: "# Bad Plan",
      metadata: JSON.stringify({
        planId,
        epicId: epic.id,
        shippedAt: null,
        complexity: "extreme",
      }),
    });

    const child = await taskStore.create(TEST_PROJECT_ID, "Child Task", {
      type: "task",
      priority: 1,
      description: "Task",
      parentId: epic.id,
    });

    const task = await taskStore.show(TEST_PROJECT_ID, child.id);
    const complexity = await getPlanComplexityForTask(TEST_PROJECT_ID, tempDir, task, taskStore);
    expect(complexity).toBeUndefined();
  });
});

describe("planComplexityToTask", () => {
  it("maps low and medium to 3", () => {
    expect(planComplexityToTask("low")).toBe(3);
    expect(planComplexityToTask("medium")).toBe(3);
  });
  it("maps high and very_high to 7", () => {
    expect(planComplexityToTask("high")).toBe(7);
    expect(planComplexityToTask("very_high")).toBe(7);
  });
});

describe("getTaskComplexity", () => {
  it("returns task own complexity when set (1-10)", () => {
    const task = { complexity: 7 } as { complexity?: number };
    expect(getTaskComplexity(task, "low")).toBe(7);
    expect(getTaskComplexity(task, undefined)).toBe(7);
  });
  it("infers from plan when task has no complexity", () => {
    const task = {} as { complexity?: number };
    expect(getTaskComplexity(task, "low")).toBe(3);
    expect(getTaskComplexity(task, "medium")).toBe(3);
    expect(getTaskComplexity(task, "high")).toBe(7);
    expect(getTaskComplexity(task, "very_high")).toBe(7);
  });
  it("returns undefined when neither task nor plan has valid complexity", () => {
    const task = {} as { complexity?: number };
    expect(getTaskComplexity(task, undefined)).toBeUndefined();
  });
});

describe("getComplexityForAgent", () => {
  let tempDir: string;
  let taskStore: TaskStoreService;

  beforeEach(async () => {
    const mod = (await import("../services/task-store.service.js")) as unknown as {
      _resetPlanComplexityDb?: () => void;
    };
    mod._resetPlanComplexityDb?.();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-complexity-agent-"));
    taskStore = taskStoreSingleton;

    const { execSync } = await import("child_process");
    execSync("git init", { cwd: tempDir });
    execSync("git config user.email test@test.com", { cwd: tempDir });
    execSync("git config user.name Test", { cwd: tempDir });
    await taskStore.init();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("uses max of task and epic complexity (task=simple, epic=complex → complex)", async () => {
    const planId = `plan-${Date.now()}`;
    const epic = await taskStore.create(TEST_PROJECT_ID, "Epic", {
      type: "epic",
      description: planId,
    });
    await taskStore.planInsert(TEST_PROJECT_ID, planId, {
      epic_id: epic.id,
      content: "# Plan",
      metadata: JSON.stringify({
        planId,
        epicId: epic.id,
        shippedAt: null,
        complexity: "high",
      }),
    });
    const child = await taskStore.create(TEST_PROJECT_ID, "Child", {
      type: "task",
      parentId: epic.id,
      complexity: 3,
    });
    const task = await taskStore.show(TEST_PROJECT_ID, child.id);
    const complexity = await getComplexityForAgent(TEST_PROJECT_ID, tempDir, task, taskStore);
    expect(complexity).toBe("high");
  });

  it("uses max of task and epic complexity (task=complex, epic=simple → complex)", async () => {
    const planId = `plan-${Date.now()}`;
    const epic = await taskStore.create(TEST_PROJECT_ID, "Epic", {
      type: "epic",
      description: planId,
    });
    await taskStore.planInsert(TEST_PROJECT_ID, planId, {
      epic_id: epic.id,
      content: "# Plan",
      metadata: JSON.stringify({
        planId,
        epicId: epic.id,
        shippedAt: null,
        complexity: "low",
      }),
    });
    const child = await taskStore.create(TEST_PROJECT_ID, "Child", {
      type: "task",
      parentId: epic.id,
      complexity: 7,
    });
    const task = await taskStore.show(TEST_PROJECT_ID, child.id);
    const complexity = await getComplexityForAgent(TEST_PROJECT_ID, tempDir, task, taskStore);
    expect(complexity).toBe("high");
  });

  it("uses low when both task and epic are simple", async () => {
    const planId = `plan-${Date.now()}`;
    const epic = await taskStore.create(TEST_PROJECT_ID, "Epic", {
      type: "epic",
      description: planId,
    });
    await taskStore.planInsert(TEST_PROJECT_ID, planId, {
      epic_id: epic.id,
      content: "# Plan",
      metadata: JSON.stringify({
        planId,
        epicId: epic.id,
        shippedAt: null,
        complexity: "low",
      }),
    });
    const child = await taskStore.create(TEST_PROJECT_ID, "Child", {
      type: "task",
      parentId: epic.id,
      complexity: 3,
    });
    const task = await taskStore.show(TEST_PROJECT_ID, child.id);
    const complexity = await getComplexityForAgent(TEST_PROJECT_ID, tempDir, task, taskStore);
    expect(complexity).toBe("low");
  });

  it("falls back to plan complexity when task has none", async () => {
    const planId = `plan-${Date.now()}`;
    const epic = await taskStore.create(TEST_PROJECT_ID, "Epic", {
      type: "epic",
      description: planId,
    });
    await taskStore.planInsert(TEST_PROJECT_ID, planId, {
      epic_id: epic.id,
      content: "# Plan",
      metadata: JSON.stringify({
        planId,
        epicId: epic.id,
        shippedAt: null,
        complexity: "very_high",
      }),
    });
    const child = await taskStore.create(TEST_PROJECT_ID, "Child", {
      type: "task",
      parentId: epic.id,
    });
    const task = await taskStore.show(TEST_PROJECT_ID, child.id);
    const complexity = await getComplexityForAgent(TEST_PROJECT_ID, tempDir, task, taskStore);
    expect(complexity).toBe("very_high");
  });
});
