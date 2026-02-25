import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { taskStore } from "../services/task-store.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG, OPENSPRINT_PATHS } from "@opensprint/shared";

// Stub for legacy beads.service path (module removed; task store used instead). No importOriginal — file is gone.
vi.mock("../services/beads.service.js", () => ({
  BeadsService: class StubBeadsService {
    async init(): Promise<void> {}
    async configSet(): Promise<void> {}
    async sync(): Promise<void> {}
    async export(): Promise<void> {}
    async ensureDaemon(): Promise<void> {}
  },
}));

// In-memory task store so chat tests don't share DB with plan-route/plan-complexity (avoids cross-test resets and 500s)
vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/task-store.service.js")>();
  const initSqlJs = (await import("sql.js")).default;
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(actual.SCHEMA_SQL);
  const store = new actual.TaskStoreService(db);
  await store.init();
  return { ...actual, taskStore: store };
});

const mockInvokePlanningAgent = vi.fn();
const mockRegister = vi.fn();
const mockUnregister = vi.fn();

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: async (options: Record<string, unknown>) => {
      const tracking = options.tracking as
        | { id: string; projectId: string; phase: string; role: string; label: string }
        | undefined;
      if (tracking) {
        mockRegister(
          tracking.id,
          tracking.projectId,
          tracking.phase,
          tracking.role as import("@opensprint/shared").AgentRole,
          tracking.label,
          new Date().toISOString()
        );
      }
      try {
        return await mockInvokePlanningAgent(options);
      } finally {
        if (tracking) {
          mockUnregister(tracking.id);
        }
      }
    },
  },
}));

vi.mock("../services/active-agents.service.js", () => ({
  activeAgentsService: {
    register: (...args: unknown[]) => mockRegister(...args),
    unregister: (...args: unknown[]) => mockUnregister(...args),
    list: vi.fn().mockReturnValue([]),
  },
}));

const mockBroadcastToProject = vi.fn();
vi.mock("../websocket/index.js", () => ({
  broadcastToProject: (...args: unknown[]) => mockBroadcastToProject(...args),
}));

describe("Chat REST API", () => {
  let app: ReturnType<typeof createApp>;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let repoPath: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInvokePlanningAgent.mockResolvedValue({
      content: "I'd be happy to help you design your product. What are your main goals?",
    });

    app = createApp();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-chat-route-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    repoPath = path.join(tempDir, "my-project");

    const project = await projectService.createProject({
      name: "Test Project",
      repoPath,
      lowComplexityAgent: { type: "cursor", model: "claude-sonnet-4", cliCommand: null },
      highComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
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

  it("GET /projects/:id/chat/history should return empty conversation when none exists", async () => {
    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/chat/history`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.context).toBe("sketch");
    expect(res.body.data.messages).toEqual([]);
  });

  it("GET /projects/:id/chat/history should accept context query param", async () => {
    const res = await request(app).get(
      `${API_PREFIX}/projects/${projectId}/chat/history?context=plan:auth-plan`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.context).toBe("plan:auth-plan");
    expect(res.body.data.messages).toEqual([]);
  });

  it("Plan chat with PLAN_UPDATE only shows 'Plan updated' in response and history", async () => {
    await taskStore.planInsert(projectId, "auth-plan", {
      epic_id: "os-auth",
      content: "# Auth Plan\n\nOriginal content.",
      metadata: JSON.stringify({
        planId: "auth-plan",
        epicId: "os-auth",
        shippedAt: null,
        complexity: "medium",
      }),
    });

    const planUpdateResponse = `[PLAN_UPDATE]
# Auth Plan

## Overview
Updated auth flow with OAuth support.

## Acceptance Criteria
- User can sign in with Google
[/PLAN_UPDATE]`;

    mockInvokePlanningAgent.mockResolvedValue({ content: planUpdateResponse });

    const sendRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/chat`)
      .send({ message: "Add OAuth support", context: "plan:auth-plan" });

    expect(sendRes.status).toBe(200);
    expect(sendRes.body.data.message).toBe("Plan updated");

    const historyRes = await request(app).get(
      `${API_PREFIX}/projects/${projectId}/chat/history?context=plan:auth-plan`
    );

    expect(historyRes.status).toBe(200);
    expect(historyRes.body.data.messages).toHaveLength(2);
    expect(historyRes.body.data.messages[1].role).toBe("assistant");
    expect(historyRes.body.data.messages[1].content).toBe("Plan updated");
  });

  it("Plan chat with PLAN_UPDATE plus text shows only the text in chat", async () => {
    await taskStore.planInsert(projectId, "auth-plan", {
      epic_id: "os-auth",
      content: "# Auth Plan\n\nOriginal.",
      metadata: JSON.stringify({
        planId: "auth-plan",
        epicId: "os-auth",
        shippedAt: null,
        complexity: "medium",
      }),
    });

    mockInvokePlanningAgent.mockResolvedValue({
      content: `I've updated the plan with OAuth support. Here are the key changes:

[PLAN_UPDATE]
# Auth Plan

## Overview
OAuth support added.
[/PLAN_UPDATE]

Let me know if you want to refine further.`,
    });

    const sendRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/chat`)
      .send({ message: "Add OAuth", context: "plan:auth-plan" });

    expect(sendRes.status).toBe(200);
    expect(sendRes.body.data.message).toContain("I've updated the plan");
    expect(sendRes.body.data.message).toContain("Let me know if you want");
    expect(sendRes.body.data.message).not.toContain("[PLAN_UPDATE]");
    expect(sendRes.body.data.message).not.toContain("OAuth support added");
  });

  it("Plan chat messages persist and are returned by GET history", async () => {
    mockInvokePlanningAgent.mockResolvedValue({
      content: "I can help refine this plan. What would you like to change?",
    });

    const sendRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/chat`)
      .send({ message: "Add more detail to the auth section", context: "plan:auth-plan" });

    expect(sendRes.status).toBe(200);
    expect(sendRes.body.data.message).toBeDefined();

    const historyRes = await request(app).get(
      `${API_PREFIX}/projects/${projectId}/chat/history?context=plan:auth-plan`
    );

    expect(historyRes.status).toBe(200);
    expect(historyRes.body.data.context).toBe("plan:auth-plan");
    expect(historyRes.body.data.messages).toHaveLength(2);
    expect(historyRes.body.data.messages[0].role).toBe("user");
    expect(historyRes.body.data.messages[0].content).toBe("Add more detail to the auth section");
    expect(historyRes.body.data.messages[1].role).toBe("assistant");
    expect(historyRes.body.data.messages[1].content).toContain("I can help refine");
  });

  it("POST /projects/:id/chat should send message and return agent response", async () => {
    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/chat`)
      .send({ message: "I want to build a todo app" });

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.message).toBeDefined();
    expect(typeof res.body.data.message).toBe("string");
  });

  it("POST /projects/:id/chat passes body.images to invokePlanningAgent when present", async () => {
    const images = ["data:image/png;base64,abc123"];
    await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/chat`)
      .send({ message: "Describe this screenshot", context: "sketch", images });

    expect(mockInvokePlanningAgent).toHaveBeenCalledTimes(1);
    const options = mockInvokePlanningAgent.mock.calls[0][0];
    expect(options.images).toEqual(images);
  });

  it("POST /chat should parse PRD_UPDATE blocks from agent response and apply to PRD", async () => {
    const agentResponseWithPrdUpdate = `Here's my suggested executive summary for your product.

[PRD_UPDATE:executive_summary]
## Executive Summary

OpenSprint is a web application that guides users through the full software development lifecycle using AI agents.
[/PRD_UPDATE]

Let me know if you'd like to refine this further.`;

    mockInvokePlanningAgent.mockResolvedValue({ content: agentResponseWithPrdUpdate });

    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/chat`)
      .send({ message: "Help me write an executive summary", context: "sketch" });

    expect(res.status).toBe(200);
    expect(res.body.data.message).not.toContain("[PRD_UPDATE:");
    expect(res.body.data.message).not.toContain("[/PRD_UPDATE]");
    expect(res.body.data.message).toContain("Here's my suggested executive summary");
    expect(res.body.data.prdChanges).toBeDefined();
    expect(res.body.data.prdChanges).toHaveLength(1);
    expect(res.body.data.prdChanges[0].section).toBe("executive_summary");

    const prdRes = await request(app).get(
      `${API_PREFIX}/projects/${projectId}/prd/executive_summary`
    );
    expect(prdRes.status).toBe(200);
    expect(prdRes.body.data.content).toContain(
      "OpenSprint is a web application that guides users through the full software development lifecycle using AI agents"
    );

    // Verify prd.updated broadcast so UI can refresh via WebSocket
    expect(mockBroadcastToProject).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({ type: "prd.updated", section: "executive_summary" })
    );

    // Verify PRD persisted to storage (.opensprint/prd.json)
    const prdPath = path.join(repoPath, OPENSPRINT_PATHS.prd);
    const prdOnDisk = JSON.parse(await fs.readFile(prdPath, "utf-8"));
    expect(prdOnDisk.sections.executive_summary.content).toContain(
      "OpenSprint is a web application that guides users through the full software development lifecycle using AI agents"
    );
  });

  it("POST /chat empty-state: first message generates AI initial PRD with multiple sections", async () => {
    const agentResponse = `I've created an initial PRD for your todo app.

[PRD_UPDATE:executive_summary]
A task management app that helps users organize and track their work.
[/PRD_UPDATE]

[PRD_UPDATE:problem_statement]
Users struggle to keep track of tasks across multiple projects.
[/PRD_UPDATE]

[PRD_UPDATE:feature_list]
- Task creation and editing
- Project organization
- Due date reminders
[/PRD_UPDATE]

Let me know if you'd like to expand any section.`;

    mockInvokePlanningAgent.mockResolvedValue({ content: agentResponse });

    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/chat`)
      .send({ message: "I want to build a todo app", context: "sketch" });

    expect(res.status).toBe(200);
    expect(res.body.data.prdChanges).toHaveLength(3);
    const sections = res.body.data.prdChanges.map((c: { section: string }) => c.section);
    expect(sections).toContain("executive_summary");
    expect(sections).toContain("problem_statement");
    expect(sections).toContain("feature_list");

    const execRes = await request(app).get(
      `${API_PREFIX}/projects/${projectId}/prd/executive_summary`
    );
    expect(execRes.body.data.content).toContain("task management app");

    const problemRes = await request(app).get(
      `${API_PREFIX}/projects/${projectId}/prd/problem_statement`
    );
    expect(problemRes.body.data.content).toContain("keep track of tasks");
  });

  it("POST /chat should handle multiple PRD_UPDATE blocks in one response", async () => {
    const agentResponse = `I've updated two sections for you.

[PRD_UPDATE:executive_summary]
## Executive Summary

Product A helps users do X.
[/PRD_UPDATE]

[PRD_UPDATE:problem_statement]
## Problem Statement

Users currently face Y.
[/PRD_UPDATE]

Hope that helps!`;

    mockInvokePlanningAgent.mockResolvedValue({ content: agentResponse });

    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/chat`)
      .send({ message: "Update both sections", context: "sketch" });

    expect(res.status).toBe(200);
    expect(res.body.data.prdChanges).toHaveLength(2);
    const sections = res.body.data.prdChanges.map((c: { section: string }) => c.section);
    expect(sections).toContain("executive_summary");
    expect(sections).toContain("problem_statement");

    const execRes = await request(app).get(
      `${API_PREFIX}/projects/${projectId}/prd/executive_summary`
    );
    expect(execRes.body.data.content).toContain("Product A helps users do X");

    const problemRes = await request(app).get(
      `${API_PREFIX}/projects/${projectId}/prd/problem_statement`
    );
    expect(problemRes.body.data.content).toContain("Users currently face Y");
  });

  it("POST /chat should return message without prdChanges when agent response has no PRD_UPDATE blocks", async () => {
    mockInvokePlanningAgent.mockResolvedValue({
      content: "That's a great question! Could you tell me more about your target users?",
    });

    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/chat`)
      .send({ message: "What should I include?", context: "sketch" });

    expect(res.status).toBe(200);
    expect(res.body.data.prdChanges).toBeUndefined();
    expect(res.body.data.message).toContain("That's a great question!");
  });

  it("POST /chat applies PRD_UPDATE and creates prd.json when file was missing (e.g. adopted repo)", async () => {
    const prdPath = path.join(repoPath, OPENSPRINT_PATHS.prd);
    await fs.unlink(prdPath);

    mockInvokePlanningAgent.mockResolvedValue({
      content: `Here are some sections for your marketing site.

[PRD_UPDATE:api_contracts]
No APIs. The marketing site does not call the OpenSprint backend.
[/PRD_UPDATE]

[PRD_UPDATE:executive_summary]
A simple marketing site for OpenSprint.
[/PRD_UPDATE]`,
    });

    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/chat`)
      .send({ message: "Sketch it", context: "sketch" });

    expect(res.status).toBe(200);
    expect(res.body.data.prdChanges).toHaveLength(2);

    const prdRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/prd`);
    expect(prdRes.status).toBe(200);
    expect(prdRes.body.data.sections.api_contracts.content).toContain("No APIs");
    expect(prdRes.body.data.sections.executive_summary.content).toContain("marketing site");
  });

  it("POST /projects/:id/chat should persist conversation; GET history returns it", async () => {
    const postRes = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/chat`)
      .send({ message: "Hello, help me design my product" });

    expect(postRes.status).toBe(200);

    const getRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/chat/history`);

    expect(getRes.status).toBe(200);
    expect(getRes.body.data.messages).toHaveLength(2);
    expect(getRes.body.data.messages[0].role).toBe("user");
    expect(getRes.body.data.messages[0].content).toBe("Hello, help me design my product");
    expect(getRes.body.data.messages[1].role).toBe("assistant");
    expect(getRes.body.data.messages[1].content).toBeDefined();
  });

  it("POST /projects/:id/chat should return 400 when message is empty", async () => {
    const res = await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/chat`)
      .send({ message: "" });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_INPUT");
  });

  it("POST /projects/:id/chat should return 400 when message is missing", async () => {
    const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/chat`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_INPUT");
  });

  it("conversation should be stored in .opensprint/conversations/", async () => {
    await request(app)
      .post(`${API_PREFIX}/projects/${projectId}/chat`)
      .send({ message: "Test message" });

    const convDir = path.join(repoPath, OPENSPRINT_PATHS.conversations);
    const files = await fs.readdir(convDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith(".json"))).toBe(true);

    const jsonFile = files.find((f) => f.endsWith(".json"));
    const content = await fs.readFile(path.join(convDir, jsonFile!), "utf-8");
    const conv = JSON.parse(content);
    expect(conv.id).toBeDefined();
    expect(conv.context).toBe("sketch");
    expect(conv.messages).toHaveLength(2);
  });

  describe("Design phase agent registry", () => {
    it("should register and unregister Sketch chat agent when context is sketch", async () => {
      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/chat`)
        .send({ message: "Help me design my product", context: "sketch" });

      expect(res.status).toBe(200);
      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockRegister).toHaveBeenCalledWith(
        expect.stringMatching(/^design-chat-.*-/),
        projectId,
        "sketch",
        "dreamer",
        "Sketch chat",
        expect.any(String)
      );
      expect(mockUnregister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledWith(mockRegister.mock.calls[0][0]);
    });

    it("should register and unregister Plan chat agent when context is plan", async () => {
      mockInvokePlanningAgent.mockResolvedValue({
        content: "I can help refine this plan. What would you like to change?",
      });

      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/chat`)
        .send({ message: "Refine the acceptance criteria", context: "plan:auth-plan" });

      expect(res.status).toBe(200);
      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockRegister).toHaveBeenCalledWith(
        expect.stringMatching(/^plan-chat-.*auth-plan.*-/),
        projectId,
        "plan",
        "dreamer",
        "Plan chat",
        expect.any(String)
      );
      expect(mockUnregister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledWith(mockRegister.mock.calls[0][0]);
    });

    it("should unregister even when agent invocation throws", async () => {
      mockInvokePlanningAgent.mockRejectedValueOnce(new Error("Agent unavailable"));

      const res = await request(app)
        .post(`${API_PREFIX}/projects/${projectId}/chat`)
        .send({ message: "Help me", context: "sketch" });

      expect(res.status).toBe(200);
      expect(res.body.data.message).toContain("unable to connect");
      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledWith(mockRegister.mock.calls[0][0]);
    });
  });
});
