import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG, OPENSPRINT_PATHS } from "@opensprint/shared";

const mockInvokePlanningAgent = vi.fn();
const mockRegister = vi.fn();
const mockUnregister = vi.fn();

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: (...args: unknown[]) => mockInvokePlanningAgent(...args),
  },
}));

vi.mock("../services/active-agents.service.js", () => ({
  activeAgentsService: {
    register: (...args: unknown[]) => mockRegister(...args),
    unregister: (...args: unknown[]) => mockUnregister(...args),
    list: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: vi.fn(),
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
      description: "A test project",
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

  it("GET /projects/:id/chat/history should return empty conversation when none exists", async () => {
    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/chat/history`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.context).toBe("sketch");
    expect(res.body.data.messages).toEqual([]);
  });

  it("GET /projects/:id/chat/history should accept context query param", async () => {
    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/chat/history?context=plan:auth-plan`);

    expect(res.status).toBe(200);
    expect(res.body.data.context).toBe("plan:auth-plan");
    expect(res.body.data.messages).toEqual([]);
  });

  it("GET /projects/:id/chat/history should accept spec as alias for sketch (backwards compatibility)", async () => {
    const res = await request(app).get(`${API_PREFIX}/projects/${projectId}/chat/history?context=spec`);

    expect(res.status).toBe(200);
    expect(res.body.data.context).toBe("sketch");
    expect(res.body.data.messages).toEqual([]);
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

    const prdRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/prd/executive_summary`);
    expect(prdRes.status).toBe(200);
    expect(prdRes.body.data.content).toContain(
      "OpenSprint is a web application that guides users through the full software development lifecycle using AI agents",
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

    const execRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/prd/executive_summary`);
    expect(execRes.body.data.content).toContain("task management app");

    const problemRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/prd/problem_statement`);
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

    const execRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/prd/executive_summary`);
    expect(execRes.body.data.content).toContain("Product A helps users do X");

    const problemRes = await request(app).get(`${API_PREFIX}/projects/${projectId}/prd/problem_statement`);
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
    const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/chat`).send({ message: "" });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_INPUT");
  });

  it("POST /projects/:id/chat should return 400 when message is missing", async () => {
    const res = await request(app).post(`${API_PREFIX}/projects/${projectId}/chat`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_INPUT");
  });

  it("conversation should be stored in .opensprint/conversations/", async () => {
    await request(app).post(`${API_PREFIX}/projects/${projectId}/chat`).send({ message: "Test message" });

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
        "Sketch chat",
        expect.any(String),
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
        "Plan chat",
        expect.any(String),
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
