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
    await beads.close(project.repoPath, gateTaskId, "Plan approved for build");
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

  it(
    "POST /tasks/:taskId/prepare creates .opensprint/active/<task-id>/ with prompt, config, context",
    {
      timeout: 20000,
    },
    async () => {
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
      await beads.close(project.repoPath, gateTaskId, "Plan approved for build");

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

  it("POST /tasks/:taskId/prepare with phase=review generates review prompt per PRD §12.3", {
    timeout: 20000,
  }, async () => {
    const app = createApp();

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
    const gateTaskId = plan.metadata.gateTaskId;
    const project = await projectService.getProject(projectId);
    await beads.close(project.repoPath, gateTaskId, "Plan shipped");

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
    expect(prompt).toContain("Review the implementation of this task against its specification and acceptance criteria");
    expect(prompt).toContain("The orchestrator has already committed them before invoking you");
    expect(prompt).toContain('Do NOT merge — the orchestrator will merge after you exit');
    expect(prompt).toContain('status "approved"');
    expect(prompt).toContain('status "rejected"');
    expect(prompt).toContain("provide specific, actionable feedback");

    const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
    expect(config.phase).toBe("review");
  });

  it("POST /tasks/:taskId/unblock sets beads status to open", { timeout: 20000 }, async () => {
    const app = createApp();

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
    const gateTaskId = plan.metadata.gateTaskId;
    const project = await projectService.getProject(projectId);
    await beads.close(project.repoPath, gateTaskId, "Plan approved");

    const tasksRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
    const tasks = tasksRes.body.data ?? [];
    const taskZ = tasks.find((t: { title: string }) => t.title === "Task Z");
    expect(taskZ).toBeDefined();

    await beads.update(project.repoPath, taskZ.id, { status: "blocked" });
    await beads.sync(project.repoPath);

    const tasksBlockedRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
    const taskBlocked = (tasksBlockedRes.body.data ?? []).find((t: { id: string }) => t.id === taskZ.id);
    expect(taskBlocked.kanbanColumn).toBe("blocked");

    const unblockRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/tasks/${taskZ.id}/unblock`)
      .set("Content-Type", "application/json")
      .send({});

    expect(unblockRes.status).toBe(200);
    expect(unblockRes.body.data.taskUnblocked).toBe(true);

    const tasksAfterRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
    const taskAfter = (tasksAfterRes.body.data ?? []).find((t: { id: string }) => t.id === taskZ.id);
    expect(taskAfter.kanbanColumn).not.toBe("blocked");
  });

  it("POST /tasks/:taskId/unblock accepts resetAttempts option", { timeout: 20000 }, async () => {
    const app = createApp();

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
    const gateTaskId = plan.metadata.gateTaskId;
    const project = await projectService.getProject(projectId);
    await beads.close(project.repoPath, gateTaskId, "Plan approved");

    const tasksRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks`);
    const tasks = tasksRes.body.data ?? [];
    const taskW = tasks.find((t: { title: string }) => t.title === "Task W");
    expect(taskW).toBeDefined();

    await beads.update(project.repoPath, taskW.id, { status: "blocked" });
    await beads.sync(project.repoPath);

    const unblockRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/tasks/${taskW.id}/unblock`)
      .set("Content-Type", "application/json")
      .send({ resetAttempts: true });

    expect(unblockRes.status).toBe(200);
    expect(unblockRes.body.data.taskUnblocked).toBe(true);
  });

  it("GET /tasks/:taskId returns sourceFeedbackId when task has discovered-from dep to feedback source bead", {
    timeout: 20000,
  }, async () => {
    const app = createApp();
    const project = await projectService.getProject(projectId);
    const repoPath = project.repoPath;

    // Create feedback source bead (chore with "Feedback ID: xxx" in description)
    const sourceBead = await beads.create(repoPath, "Feedback: Add dark mode", {
      type: "chore",
      priority: 4,
      description: "Feedback ID: fb-test-source",
    });
    expect(sourceBead.id).toBeDefined();

    // Create child task
    const childBead = await beads.create(repoPath, "Implement dark mode", {
      type: "task",
      priority: 2,
      description: "Add dark mode support to the app",
    });
    expect(childBead.id).toBeDefined();

    // Add discovered-from dependency: child -> feedback source
    await beads.addDependency(repoPath, childBead.id, sourceBead.id, "discovered-from");

    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks/${childBead.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.sourceFeedbackId).toBe("fb-test-source");
  });

  it("GET /tasks/:taskId returns sourceFeedbackId when task is the feedback source bead itself", {
    timeout: 20000,
  }, async () => {
    const app = createApp();
    const project = await projectService.getProject(projectId);
    const repoPath = project.repoPath;

    // Create feedback source bead (task IS the source - description is "Feedback ID: xxx")
    const sourceBead = await beads.create(repoPath, "Feedback: Fix login bug", {
      type: "chore",
      priority: 4,
      description: "Feedback ID: fb-direct-source",
    });

    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/tasks/${sourceBead.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.sourceFeedbackId).toBe("fb-direct-source");
  });
});
