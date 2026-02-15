import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { BeadsService } from "../services/beads.service.js";
import { API_PREFIX } from "@opensprint/shared";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";

describe("Tasks REST - task-to-kanban-column mapping", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let projectId: string;
  let projectService: ProjectService;
  let beads: BeadsService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-task-route-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    projectService = new ProjectService();
    beads = new BeadsService();
    const repoPath = path.join(tempDir, "test-project");
    const project = await projectService.createProject({
      name: "Task Mapping Test",
      description: "For kanban column mapping tests",
      repoPath,
      planningAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      codingAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("GET /tasks maps beads state to kanban columns: planning, backlog, ready, done", { timeout: 20000 }, async () => {
    const app = createApp();

    // Create plan with tasks (epic + gate + 2 tasks; tasks block on gate)
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
    const gateTaskId = plan.metadata.gateTaskId;
    expect(gateTaskId).toBeDefined();

    // Before ship: tasks block on open gate -> planning
    const tasksBeforeRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
    expect(tasksBeforeRes.status).toBe(200);
    const tasksBefore = tasksBeforeRes.body.data ?? [];

    const taskA = tasksBefore.find((t: { title: string }) => t.title === "Task A");
    const taskB = tasksBefore.find((t: { title: string }) => t.title === "Task B");
    expect(taskA).toBeDefined();
    expect(taskB).toBeDefined();

    // Both block on gate (.0) which is open -> planning
    expect(taskA.kanbanColumn).toBe("planning");
    expect(taskB.kanbanColumn).toBe("planning");

    // Ship the plan: close gate directly (avoids PRD sync which invokes AI)
    const project = await projectService.getProject(projectId);
    await beads.close(project.repoPath, gateTaskId, "Plan shipped");
    // Update plan metadata so status is correct
    const plansDir = path.join(project.repoPath, ".opensprint", "plans");
    const metaPath = path.join(plansDir, `${plan.metadata.planId}.meta.json`);
    const meta = JSON.parse(await fs.readFile(metaPath, "utf-8"));
    meta.shippedAt = new Date().toISOString();
    await fs.writeFile(metaPath, JSON.stringify(meta));

    // After ship: Task A has no blockers (gate closed) -> ready; Task B blocks on A (open) -> backlog
    const tasksAfterRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
    expect(tasksAfterRes.status).toBe(200);
    const tasksAfter = tasksAfterRes.body.data ?? [];

    const taskAAfter = tasksAfter.find((t: { title: string }) => t.title === "Task A");
    const taskBAfter = tasksAfter.find((t: { title: string }) => t.title === "Task B");
    expect(taskAAfter.kanbanColumn).toBe("ready");
    expect(taskBAfter.kanbanColumn).toBe("backlog");

    // Close Task A -> done
    await beads.close(project.repoPath, taskAAfter.id, "Done");

    // Task B should now be ready (only blocker is done)
    const tasksFinalRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
    const tasksFinal = tasksFinalRes.body.data ?? [];
    const taskAFinal = tasksFinal.find((t: { id: string }) => t.id === taskAAfter.id);
    const taskBFinal = tasksFinal.find((t: { id: string }) => t.id === taskBAfter.id);
    expect(taskAFinal.kanbanColumn).toBe("done");
    expect(taskBFinal.kanbanColumn).toBe("ready");
  });

  it("POST /tasks/:taskId/prepare creates .opensprint/active/<task-id>/ with prompt, config, context", {
    timeout: 20000,
  }, async () => {
    const app = createApp();

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
    const gateTaskId = plan.metadata.gateTaskId;
    const project = await projectService.getProject(projectId);
    await beads.close(project.repoPath, gateTaskId, "Plan shipped");

    const tasksRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
    const tasks = tasksRes.body.data ?? [];
    const taskX = tasks.find((t: { title: string }) => t.title === "Task X");
    expect(taskX).toBeDefined();

    const prepareRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/build/tasks/${taskX.id}/prepare`)
      .set("Content-Type", "application/json")
      .send({ createBranch: false });

    expect(prepareRes.status).toBe(201);
    const { taskDir } = prepareRes.body.data;
    expect(taskDir).toContain(".opensprint/active");
    expect(taskDir).toContain(taskX.id);

    const promptPath = path.join(taskDir, "prompt.md");
    const configPath = path.join(taskDir, "config.json");
    const prdPath = path.join(taskDir, "context", "prd_excerpt.md");
    const planPath = path.join(taskDir, "context", "plan.md");

    const prompt = await fs.readFile(promptPath, "utf-8");
    expect(prompt).toContain("# Task: Task X");
    expect(prompt).toContain("Implement X");
    expect(prompt).toContain("context/plan.md");
    expect(prompt).toContain("context/prd_excerpt.md");

    const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
    expect(config.taskId).toBe(taskX.id);
    expect(config.phase).toBe("coding");
    expect(config.branch).toContain(taskX.id);

    await fs.access(prdPath);
    await fs.access(planPath);
  });
});
