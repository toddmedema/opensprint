import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { TaskStoreService } from "../services/task-store.service.js";
import { API_PREFIX } from "@opensprint/shared";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";

vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/task-store.service.js")>();
  const { createTestPostgresClient } = await import("./test-db-helper.js");
  const dbResult = await createTestPostgresClient();
  if (!dbResult) {
    return {
      ...actual,
      TaskStoreService: class {
        constructor() {
          throw new Error("Postgres required for task-route tests (TEST_DATABASE_URL)");
        }
      },
      taskStore: null as unknown as TaskStoreService,
      _resetSharedDb: () => {},
      _postgresAvailable: false,
    };
  }
  const { client } = dbResult;
  const store = new actual.TaskStoreService(client);
  await store.init();
  const resetSharedDb = async () => {
    await client.execute("DELETE FROM task_dependencies");
    await client.execute("DELETE FROM tasks");
    await client.execute("DELETE FROM plans");
  };
  return {
    ...actual,
    TaskStoreService: class extends actual.TaskStoreService {
      constructor() {
        super(client);
      }
    },
    taskStore: store,
    _resetSharedDb: resetSharedDb,
    _postgresAvailable: true,
  };
});

const taskStoreMod = await import("../services/task-store.service.js");
const postgresAvailable = (taskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

describe.skipIf(!postgresAvailable)("Tasks REST - task-to-kanban-column mapping", () => {
  let app: ReturnType<typeof createApp>;
  let tempDir: string;
  let originalHome: string | undefined;
  let projectId: string;
  let projectService: ProjectService;
  let taskStore: TaskStoreService;

  beforeEach(async () => {
    const mod = (await import("../services/task-store.service.js")) as unknown as {
      _resetSharedDb?: () => void | Promise<void>;
      taskStore: TaskStoreService;
    };
    await mod._resetSharedDb?.();

    app = createApp();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-task-route-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    projectService = new ProjectService();
    taskStore = mod.taskStore;
    const repoPath = path.join(tempDir, "test-project");
    const project = await projectService.createProject({
      name: "Task Mapping Test",
      repoPath,
      simpleComplexityAgent: { type: "cursor", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore ENOTEMPTY and similar on some systems when removing .git
    }
  });

  it(
    "GET /tasks maps task store state to kanban columns: planning, backlog, ready, done",
    { timeout: 20000 },
    async () => {
      // Create plan with tasks (epic blocked + 2 tasks)
      const planRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send({
          title: "Kanban Test Feature",
          content: "# Kanban Test\n\n## Overview\n\nTest mapping.",
          complexity: "low",
          tasks: [
            { title: "Task A", description: "First task", priority: 0, dependsOn: [] },
            { title: "Task B", description: "Second task", priority: 1, dependsOn: ["Task A"] },
          ],
        });

      expect(planRes.status).toBe(201);
      const plan = planRes.body.data;
      const epicId = plan.metadata.epicId;
      expect(epicId).toBeDefined();

      // Before Execute!: epic blocked -> tasks show planning
      const tasksBeforeRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
      expect(tasksBeforeRes.status).toBe(200);
      const tasksBefore = tasksBeforeRes.body.data ?? [];

      const taskA = tasksBefore.find((t: { title: string }) => t.title === "Task A");
      const taskB = tasksBefore.find((t: { title: string }) => t.title === "Task B");
      expect(taskA).toBeDefined();
      expect(taskB).toBeDefined();

      // Epic blocked -> planning
      expect(taskA.kanbanColumn).toBe("planning");
      expect(taskB.kanbanColumn).toBe("planning");

      // Execute!: unblock epic (avoids PRD sync which invokes AI)
      const _project = await projectService.getProject(projectId);
      await taskStore.update(projectId, epicId, { status: "open" });

      const row = await taskStore.planGet(projectId, plan.metadata.planId);
      expect(row).not.toBeNull();
      await taskStore.planUpdateMetadata(projectId, plan.metadata.planId, {
        ...row!.metadata,
        shippedAt: new Date().toISOString(),
      });

      // After ship: epic open; Task A has no blockers -> ready; Task B blocks on A (open) -> backlog
      const tasksAfterRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
      expect(tasksAfterRes.status).toBe(200);
      const tasksAfter = tasksAfterRes.body.data ?? [];

      const taskAAfter = tasksAfter.find((t: { title: string }) => t.title === "Task A");
      const taskBAfter = tasksAfter.find((t: { title: string }) => t.title === "Task B");
      expect(taskAAfter.kanbanColumn).toBe("ready");
      expect(taskBAfter.kanbanColumn).toBe("backlog");

      // Close Task A -> done
      await taskStore.close(projectId, taskAAfter.id, "Done");

      // Task B should now be ready (only blocker is done)
      const tasksFinalRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
      const tasksFinal = tasksFinalRes.body.data ?? [];
      const taskAFinal = tasksFinal.find((t: { id: string }) => t.id === taskAAfter.id);
      const taskBFinal = tasksFinal.find((t: { id: string }) => t.id === taskBAfter.id);
      expect(taskAFinal.kanbanColumn).toBe("done");
      expect(taskBFinal.kanbanColumn).toBe("ready");
    }
  );

  it("GET /tasks with limit and offset returns paginated { items, total }", async () => {
    const planRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/plans`)
      .send({
        title: "Pagination Test",
        content: "# Pagination\n\nTest.",
        complexity: "low",
        tasks: [
          { title: "Task 1", description: "", priority: 0, dependsOn: [] },
          { title: "Task 2", description: "", priority: 1, dependsOn: [] },
        ],
      });
    expect(planRes.status).toBe(201);
    const plan = planRes.body.data;
    const epicId = plan.metadata.epicId;
    await taskStore.update(projectId, epicId, { status: "open" });

    const res = await request(app).get(
      `${API_PREFIX}/projects/${projectId}/tasks?limit=1&offset=0`
    );
    expect(res.status).toBe(200);
    const body = res.body.data;
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("total");
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });

  it(
    "GET /tasks/ready excludes tasks in blocked epic (epic-blocked model)",
    { timeout: 20000 },
    async () => {
      const planRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send({
          title: "Ready Exclude Test",
          content: "# Ready Exclude\n\nTest.",
          complexity: "low",
          tasks: [
            { title: "Task R1", description: "First", priority: 0, dependsOn: [] },
            { title: "Task R2", description: "Second", priority: 1, dependsOn: ["Task R1"] },
          ],
        });

      expect(planRes.status).toBe(201);
      const plan = planRes.body.data;
      const epicId = plan.metadata.epicId;

      // Epic blocked: GET /tasks/ready should return empty (no tasks ready)
      const readyBeforeRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/tasks/ready`
      );
      expect(readyBeforeRes.status).toBe(200);
      const readyBefore = readyBeforeRes.body.data ?? [];
      const planTaskIds = (await taskStore.listAll(projectId))
        .filter(
          (i: { id: string; issue_type?: string; type?: string }) =>
            i.id.startsWith(epicId + ".") && (i.issue_type ?? i.type) !== "epic"
        )
        .map((i: { id: string }) => i.id);
      for (const tid of planTaskIds) {
        expect(readyBefore.map((t: { id: string }) => t.id)).not.toContain(tid);
      }

      // Unblock epic: GET /tasks/ready should include Task R1 (no blockers)
      const _project = await projectService.getProject(projectId);
      await taskStore.update(projectId, epicId, { status: "open" });
      const row = await taskStore.planGet(projectId, plan.metadata.planId);
      expect(row).not.toBeNull();
      await taskStore.planUpdateMetadata(projectId, plan.metadata.planId, {
        ...row!.metadata,
        shippedAt: new Date().toISOString(),
      });

      const readyAfterRes = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/tasks/ready`
      );
      expect(readyAfterRes.status).toBe(200);
      const readyAfter = readyAfterRes.body.data ?? [];
      const taskR1 = (await taskStore.listAll(projectId)).find(
        (i: { title: string }) => i.title === "Task R1"
      );
      expect(taskR1).toBeDefined();
      expect(readyAfter.map((t: { id: string }) => t.id)).toContain(taskR1!.id);
    }
  );

  it(
    "POST /tasks/:taskId/prepare creates .opensprint/active/<task-id>/ with prompt, config, context",
    {
      timeout: 20000,
    },
    async () => {
      // Create plan with tasks
      const planRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send({
          title: "Prepare Test Feature",
          content: `# Prepare Test

## Overview
Test task directory creation.

## Acceptance Criteria
- Task directory created
- prompt.md contains task spec

## Technical Approach
- Use ContextAssembler
`,
          complexity: "low",
          tasks: [{ title: "Task X", description: "Implement X", priority: 0, dependsOn: [] }],
        });

      expect(planRes.status).toBe(201);
      const plan = planRes.body.data;
      const epicId = plan.metadata.epicId;
      const _project = await projectService.getProject(projectId);
      await taskStore.update(projectId, epicId, { status: "open" });

      const tasksRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
      const tasks = tasksRes.body.data ?? [];
      const taskX = tasks.find((t: { title: string }) => t.title === "Task X");
      expect(taskX).toBeDefined();

      const prepareRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/execute/tasks/${taskX.id}/prepare`)
        .set("Content-Type", "application/json")
        .send({ createBranch: false });

      expect(prepareRes.status).toBe(201);
      const { taskDir } = prepareRes.body.data;
      expect(taskDir).toContain(".opensprint/active");
      expect(taskDir).toContain(taskX.id);

      const promptPath = path.join(taskDir, "prompt.md");
      const configPath = path.join(taskDir, "config.json");
      const specPath = path.join(taskDir, "context", "spec.md");
      const planPath = path.join(taskDir, "context", "plan.md");

      const prompt = await fs.readFile(promptPath, "utf-8");
      expect(prompt).toContain("# Task: Task X");
      expect(prompt).toContain("Implement X");
      expect(prompt).toContain("context/plan.md");
      expect(prompt).toContain("context/spec.md");

      const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(config.taskId).toBe(taskX.id);
      expect(config.phase).toBe("coding");
      expect(config.branch).toContain(taskX.id);

      await fs.access(specPath);
      await fs.access(planPath);
    }
  );

  it(
    "POST /tasks/:taskId/prepare with phase=review generates review prompt per PRD §12.3",
    {
      timeout: 20000,
    },
    async () => {
      const planRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/plans`)
        .send({
          title: "Review Prompt Test",
          content: `# Review Test

## Overview
Test review prompt generation.

## Acceptance Criteria
- Review prompt matches PRD §12.3
- Do NOT merge instruction present

## Technical Approach
- Use ContextAssembler with phase review
`,
          complexity: "low",
          tasks: [{ title: "Task Y", description: "Implement Y", priority: 0, dependsOn: [] }],
        });

      expect(planRes.status).toBe(201);
      const plan = planRes.body.data;
      const epicId = plan.metadata.epicId;
      const _project = await projectService.getProject(projectId);
      await taskStore.update(projectId, epicId, { status: "open" });

      const tasksRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
      const tasks = tasksRes.body.data ?? [];
      const taskY = tasks.find((t: { title: string }) => t.title === "Task Y");
      expect(taskY).toBeDefined();

      const prepareRes = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/execute/tasks/${taskY.id}/prepare`)
        .set("Content-Type", "application/json")
        .send({ phase: "review", createBranch: false });

      expect(prepareRes.status).toBe(201);
      const { taskDir } = prepareRes.body.data;
      const promptPath = path.join(taskDir, "prompt.md");
      const configPath = path.join(taskDir, "config.json");

      const prompt = await fs.readFile(promptPath, "utf-8");
      expect(prompt).toContain("# Review Task: Task Y");
      expect(prompt).toContain("You are reviewing the implementation of a task");
      expect(prompt).toContain("The orchestrator has already committed them before invoking you");
      expect(prompt).toMatch(/do NOT merge.*orchestrator will merge after you exit/i);
      expect(prompt).toMatch(/"status":\s*"approved"/);
      expect(prompt).toMatch(/"status":\s*"rejected"/);

      const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(config.phase).toBe("review");
    }
  );

  it("POST /tasks/:taskId/unblock sets task status to open", { timeout: 20000 }, async () => {
    const planRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/plans`)
      .send({
        title: "Unblock Test Feature",
        content: "# Unblock Test\n\n## Overview\n\nTest unblock.",
        complexity: "low",
        tasks: [{ title: "Task Z", description: "Implement Z", priority: 0, dependsOn: [] }],
      });

    expect(planRes.status).toBe(201);
    const plan = planRes.body.data;
    const epicId = plan.metadata.epicId;
    const _project = await projectService.getProject(projectId);
    await taskStore.update(projectId, epicId, { status: "open" });

    const tasksRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
    const tasks = tasksRes.body.data ?? [];
    const taskZ = tasks.find((t: { title: string }) => t.title === "Task Z");
    expect(taskZ).toBeDefined();

    await taskStore.update(projectId, taskZ.id, { status: "blocked" });

    const tasksBlockedRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
    const taskBlocked = (tasksBlockedRes.body.data ?? []).find(
      (t: { id: string }) => t.id === taskZ.id
    );
    expect(taskBlocked.kanbanColumn).toBe("blocked");

    const unblockRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/tasks/${taskZ.id}/unblock`)
      .set("Content-Type", "application/json")
      .send({});

    expect(unblockRes.status).toBe(200);
    expect(unblockRes.body.data.taskUnblocked).toBe(true);

    const tasksAfterRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
    const taskAfter = (tasksAfterRes.body.data ?? []).find(
      (t: { id: string }) => t.id === taskZ.id
    );
    expect(taskAfter.kanbanColumn).not.toBe("blocked");
  });

  it("POST /tasks/:taskId/unblock accepts resetAttempts option", { timeout: 20000 }, async () => {
    const planRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/plans`)
      .send({
        title: "Unblock Reset Test",
        content: "# Unblock Reset\n\n## Overview\n\nTest resetAttempts.",
        complexity: "low",
        tasks: [{ title: "Task W", description: "Implement W", priority: 0, dependsOn: [] }],
      });

    expect(planRes.status).toBe(201);
    const plan = planRes.body.data;
    const epicId = plan.metadata.epicId;
    const _project = await projectService.getProject(projectId);
    await taskStore.update(projectId, epicId, { status: "open" });

    const tasksRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
    const tasks = tasksRes.body.data ?? [];
    const taskW = tasks.find((t: { title: string }) => t.title === "Task W");
    expect(taskW).toBeDefined();

    await taskStore.update(projectId, taskW.id, { status: "blocked" });

    const unblockRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/tasks/${taskW.id}/unblock`)
      .set("Content-Type", "application/json")
      .send({ resetAttempts: true });

    expect(unblockRes.status).toBe(200);
    expect(unblockRes.body.data.taskUnblocked).toBe(true);
  });

  it(
    "GET /tasks/:taskId returns sourceFeedbackIds when task has discovered-from dep to feedback source task",
    {
      timeout: 20000,
    },
    async () => {
      const _project = await projectService.getProject(projectId);
      const _repoPath = _project.repoPath;

      // Create feedback source task (chore with "Feedback ID: xxx" in description)
      const sourceTask = await taskStore.create(projectId, "Feedback: Add dark mode", {
        type: "chore",
        priority: 4,
        description: "Feedback ID: fb-test-source",
      });
      expect(sourceTask.id).toBeDefined();

      // Create child task
      const childTask = await taskStore.create(projectId, "Implement dark mode", {
        type: "task",
        priority: 2,
        description: "Add dark mode support to the app",
      });
      expect(childTask.id).toBeDefined();

      // Add discovered-from dependency: child -> feedback source
      await taskStore.addDependency(projectId, childTask.id, sourceTask.id, "discovered-from");

      const res = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/tasks/${childTask.id}`
      );
      expect(res.status).toBe(200);
      expect(res.body.data.sourceFeedbackIds).toEqual(["fb-test-source"]);
      expect(res.body.data.sourceFeedbackId).toBe("fb-test-source");
    }
  );

  it(
    "GET /tasks/:taskId returns sourceFeedbackIds when task is the feedback source task itself",
    {
      timeout: 20000,
    },
    async () => {
      const _project = await projectService.getProject(projectId);
      const _repoPath = _project.repoPath;

      // Create feedback source task (task IS the source - description is "Feedback ID: xxx")
      const sourceTask = await taskStore.create(projectId, "Feedback: Fix login bug", {
        type: "chore",
        priority: 4,
        description: "Feedback ID: fb-direct-source",
      });

      const res = await request(app).get(
        `${API_PREFIX}/projects/${projectId}/tasks/${sourceTask.id}`
      );
      expect(res.status).toBe(200);
      expect(res.body.data.sourceFeedbackIds).toEqual(["fb-direct-source"]);
      expect(res.body.data.sourceFeedbackId).toBe("fb-direct-source");
    }
  );

  it(
    "GET /tasks/:taskId includes Server-Timing header for regression detection",
    {
      timeout: 20000,
    },
    async () => {
      const _project = await projectService.getProject(projectId);
      const _repoPath = _project.repoPath;

      const task = await taskStore.create(projectId, "Server-Timing Test Task", {
        type: "task",
        priority: 1,
        description: "Test task for Server-Timing header",
      });

      const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks/${task.id}`);
      expect(res.status).toBe(200);
      const serverTiming = res.headers["server-timing"];
      expect(serverTiming).toBeDefined();
      expect(serverTiming).toMatch(/task-detail;dur=\d+;desc="Task detail load"/);
    }
  );

  it("PATCH /tasks/:taskId updates task priority", async () => {
    const _project = await projectService.getProject(projectId);
    const _repoPath = _project.repoPath;

    const task = await taskStore.create(projectId, "Priority Update Test Task", {
      type: "task",
      priority: 2,
      description: "Task to test priority update",
    });

    const res = await request(app)
      .patch(`${API_PREFIX}/projects/${projectId}/tasks/${task.id}`)
      .set("Content-Type", "application/json")
      .send({ priority: 0 });

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBe(task.id);
    expect(res.body.data.priority).toBe(0);

    const showAfter = await taskStore.show(projectId, task.id);
    expect((showAfter as { priority?: number }).priority).toBe(0);
  });

  it("PATCH /tasks/:taskId returns 400 when priority is invalid", async () => {
    const _project = await projectService.getProject(projectId);
    const _repoPath = _project.repoPath;

    const task = await taskStore.create(projectId, "Invalid Priority Test", {
      type: "task",
      priority: 2,
    });

    const res = await request(app)
      .patch(`${API_PREFIX}/projects/${projectId}/tasks/${task.id}`)
      .set("Content-Type", "application/json")
      .send({ priority: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/0–4/i);
  });

  it("PATCH /tasks/:taskId updates task complexity", async () => {
    const _project = await projectService.getProject(projectId);

    const task = await taskStore.create(projectId, "Complexity Update Test Task", {
      type: "task",
      priority: 1,
    });

    const res = await request(app)
      .patch(`${API_PREFIX}/projects/${projectId}/tasks/${task.id}`)
      .set("Content-Type", "application/json")
      .send({ complexity: 7 });

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBe(task.id);
    expect(res.body.data.complexity).toBe(7);

    const showAfter = await taskStore.show(projectId, task.id);
    expect((showAfter as { complexity?: number }).complexity).toBe(7);
  });

  it("PATCH /tasks/:taskId updates both priority and complexity", async () => {
    const _project = await projectService.getProject(projectId);

    const task = await taskStore.create(projectId, "Both Update Test Task", {
      type: "task",
      priority: 2,
      complexity: 3,
    });

    const res = await request(app)
      .patch(`${API_PREFIX}/projects/${projectId}/tasks/${task.id}`)
      .set("Content-Type", "application/json")
      .send({ priority: 0, complexity: 4 });

    expect(res.status).toBe(200);
    expect(res.body.data.priority).toBe(0);
    expect(res.body.data.complexity).toBe(4);
  });

  it("PATCH /tasks/:taskId returns 400 when complexity is invalid", async () => {
    const _project = await projectService.getProject(projectId);
    const task = await taskStore.create(projectId, "Task", { type: "task", priority: 1 });

    const res = await request(app)
      .patch(`${API_PREFIX}/projects/${projectId}/tasks/${task.id}`)
      .set("Content-Type", "application/json")
      .send({ complexity: 11 });

    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/1–10/i);
  });

  it("PATCH /tasks/:taskId returns 400 when neither priority nor complexity provided", async () => {
    const _project = await projectService.getProject(projectId);
    const task = await taskStore.create(projectId, "Task", { type: "task", priority: 1 });

    const res = await request(app)
      .patch(`${API_PREFIX}/projects/${projectId}/tasks/${task.id}`)
      .set("Content-Type", "application/json")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/priority or complexity/i);
  });

  it("GET /tasks/:taskId returns complexity when task has it", async () => {
    const _project = await projectService.getProject(projectId);
    const task = await taskStore.create(projectId, "Task with complexity", {
      type: "task",
      priority: 1,
      complexity: 5,
    });

    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks/${task.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.complexity).toBe(5);
  });

  it("POST /tasks/:taskId/dependencies adds dependency and returns 204", async () => {
    const parentTask = await taskStore.create(projectId, "Parent Task", {
      type: "task",
      priority: 1,
    });
    const childTask = await taskStore.create(projectId, "Child Task", {
      type: "task",
      priority: 1,
    });

    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/tasks/${childTask.id}/dependencies`)
      .set("Content-Type", "application/json")
      .send({ parentTaskId: parentTask.id, type: "blocks" });

    expect(res.status).toBe(204);

    const childAfter = await taskStore.show(projectId, childTask.id);
    const deps = (childAfter as { dependencies?: Array<{ depends_on_id: string; type: string }> })
      .dependencies ?? [];
    expect(deps.some((d) => d.depends_on_id === parentTask.id && d.type === "blocks")).toBe(true);
  });

  it("POST /tasks/:taskId/dependencies returns 400 when parentTaskId missing", async () => {
    const task = await taskStore.create(projectId, "Task", { type: "task", priority: 1 });

    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/tasks/${task.id}/dependencies`)
      .set("Content-Type", "application/json")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/parentTaskId/i);
  });
});
