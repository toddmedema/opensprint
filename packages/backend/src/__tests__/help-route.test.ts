import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { taskStore } from "../services/task-store.service.js";
import { API_PREFIX, DEFAULT_HIL_CONFIG } from "@opensprint/shared";

vi.mock("../services/beads.service.js", () => ({
  BeadsService: class StubBeadsService {
    async init(): Promise<void> {}
    async configSet(): Promise<void> {}
    async sync(): Promise<void> {}
    async export(): Promise<void> {}
    async ensureDaemon(): Promise<void> {}
  },
}));

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

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: async (options: Record<string, unknown>) => {
      return mockInvokePlanningAgent(options);
    },
  },
}));

vi.mock("../services/active-agents.service.js", () => ({
  activeAgentsService: {
    list: vi.fn().mockReturnValue([]),
    listEntries: vi.fn().mockReturnValue([]),
  },
}));

const mockBroadcastToProject = vi.fn();
vi.mock("../websocket/index.js", () => ({
  broadcastToProject: (...args: unknown[]) => mockBroadcastToProject(...args),
}));

describe("Help chat API", () => {
  let app: ReturnType<typeof createApp>;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let repoPath: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInvokePlanningAgent.mockResolvedValue({
      content: "I'd be happy to help! Based on the context, you have one project.",
    });

    app = createApp();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-help-route-test-"));
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
      // Ignore
    }
  });

  it("POST /help/chat (homepage) accepts message and returns agent response", async () => {
    const res = await request(app)
      .post(`${API_PREFIX}/help/chat`)
      .send({ message: "What projects do I have?" });

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.message).toBeDefined();
    expect(res.body.data.message).toContain("I'd be happy to help! Based on the context, you have one project.");
  });

  it("POST /help/chat (project view) accepts projectId and returns agent response", async () => {
    const res = await request(app)
      .post(`${API_PREFIX}/help/chat`)
      .send({ message: "What is in this project?", projectId });

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.message).toBeDefined();
    expect(mockInvokePlanningAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "What is in this project?" }),
        ]),
        systemPrompt: expect.stringMatching(/Project: Test Project[\s\S]*## Currently Running Agents/),
      })
    );
  });

  it("POST /help/chat returns 400 when message is empty", async () => {
    const res = await request(app).post(`${API_PREFIX}/help/chat`).send({ message: "" });
    expect(res.status).toBe(400);
  });

  it("POST /help/chat returns 400 when message is missing", async () => {
    const res = await request(app).post(`${API_PREFIX}/help/chat`).send({});
    expect(res.status).toBe(400);
  });

  it("POST /help/chat (homepage) returns 400 when no projects exist", async () => {
    const projectsPath = path.join(tempDir, ".opensprint", "projects.json");
    await fs.mkdir(path.dirname(projectsPath), { recursive: true });
    await fs.writeFile(projectsPath, JSON.stringify({ projects: [] }), "utf-8");

    const res = await request(app)
      .post(`${API_PREFIX}/help/chat`)
      .send({ message: "Help me" });

    expect(res.status).toBe(400);
    expect(res.body.error?.message).toContain("No projects exist");
  });

  it("POST /help/chat accepts optional messages for multi-turn context", async () => {
    const res = await request(app)
      .post(`${API_PREFIX}/help/chat`)
      .send({
        message: "Tell me more",
        projectId,
        messages: [
          { role: "user", content: "What plans exist?" },
          { role: "assistant", content: "You have no plans yet." },
        ],
      });

    expect(res.status).toBe(200);
    expect(mockInvokePlanningAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          { role: "user", content: "What plans exist?" },
          { role: "assistant", content: "You have no plans yet." },
          { role: "user", content: "Tell me more" },
        ],
      })
    );
  });

});
