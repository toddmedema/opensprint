import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { createApp } from "../app.js";
import { ProjectService } from "../services/project.service.js";
import { helpChatService } from "../routes/help.js";
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
  const { createTestPostgresClient } = await import("./test-db-helper.js");
  const dbResult = await createTestPostgresClient();
  if (!dbResult) {
    return { ...actual, taskStore: null, _postgresAvailable: false };
  }
  const store = new actual.TaskStoreService(dbResult.client);
  await store.init();
  return { ...actual, taskStore: store, _postgresAvailable: true };
});

const helpTaskStoreMod = await import("../services/task-store.service.js");
const helpPostgresOk =
  (helpTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

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

describe.skipIf(!helpPostgresOk)("Help chat API", () => {
  let app: ReturnType<typeof createApp>;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let repoPath: string;
  let originalHome: string | undefined;
  let originalOpenSprintHome: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockInvokePlanningAgent.mockResolvedValue({
      content: "I'd be happy to help! Based on the context, you have one project.",
    });

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-help-route-test-"));
    originalHome = process.env.HOME;
    originalOpenSprintHome = process.env.OPENSPRINT_HOME;
    process.env.HOME = tempDir;
    process.env.OPENSPRINT_HOME = tempDir;
    repoPath = path.join(tempDir, "my-project");

    app = createApp();
    projectService = new ProjectService();
    const project = await projectService.createProject({
      name: "Test Project",
      repoPath,
      simpleComplexityAgent: { type: "cursor", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;
    const db = await taskStore.getDb();
    await db.execute("DELETE FROM help_chat_histories");
    helpChatService.clearProjectListCacheForTesting();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (originalOpenSprintHome !== undefined) {
      process.env.OPENSPRINT_HOME = originalOpenSprintHome;
    } else {
      delete process.env.OPENSPRINT_HOME;
    }
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
    expect(res.body.data.message).toContain(
      "I'd be happy to help! Based on the context, you have one project."
    );
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
        systemPrompt: expect.stringMatching(
          /Project: Test Project[\s\S]*## Currently Running Agents/
        ),
      })
    );
  });

  it("POST /help/chat injects OpenSprint internal docs into system prompt", async () => {
    await request(app)
      .post(`${API_PREFIX}/help/chat`)
      .send({ message: "Why is only one coder active?", projectId });

    const systemPrompt = mockInvokePlanningAgent.mock.calls[0]![0].systemPrompt as string;
    expect(systemPrompt).toContain("OpenSprint Internal Documentation");
    expect(systemPrompt).toContain("TaskStoreService");
    expect(systemPrompt).toContain("ready()");
    expect(systemPrompt).toContain("maxConcurrentCoders");
    expect(systemPrompt).toContain("loop kicker");
    expect(systemPrompt).toContain("Watchdog");
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
    helpChatService.clearProjectListCacheForTesting();

    const res = await request(app).post(`${API_PREFIX}/help/chat`).send({ message: "Help me" });

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

  it("GET /help/chat/history returns empty when no history exists (homepage)", async () => {
    const res = await request(app).get(`${API_PREFIX}/help/chat/history`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ messages: [] });
  });

  it("GET /help/chat/history returns empty when no history exists (project)", async () => {
    const res = await request(app).get(`${API_PREFIX}/help/chat/history?projectId=${projectId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ messages: [] });
  });

  it("GET /help/chat/history returns MIGRATION_REQUIRED when legacy help.json exists", async () => {
    const legacyConversationsDir = path.join(repoPath, ".opensprint", "conversations");
    await fs.mkdir(legacyConversationsDir, { recursive: true });
    await fs.writeFile(
      path.join(legacyConversationsDir, "help.json"),
      JSON.stringify({ messages: [{ role: "assistant", content: "legacy" }] }),
      "utf-8"
    );

    const res = await request(app).get(`${API_PREFIX}/help/chat/history?projectId=${projectId}`);
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("MIGRATION_REQUIRED");
  });

  it("POST /help/chat persists messages; GET /help/chat/history returns them (project)", async () => {
    await request(app)
      .post(`${API_PREFIX}/help/chat`)
      .send({ message: "What is this project?", projectId });

    const res = await request(app).get(`${API_PREFIX}/help/chat/history?projectId=${projectId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.messages).toHaveLength(2);
    expect(res.body.data.messages[0]).toEqual({
      role: "user",
      content: "What is this project?",
    });
    expect(res.body.data.messages[1].role).toBe("assistant");
    expect(res.body.data.messages[1].content).toContain("I'd be happy to help!");
  });

  it("POST /help/chat persists messages; GET /help/chat/history returns them (homepage)", async () => {
    const postRes = await request(app)
      .post(`${API_PREFIX}/help/chat`)
      .send({ message: "What projects do I have?" });
    expect(postRes.status).toBe(200);

    const history = await helpChatService.getHistory(null);
    expect(history.messages).toHaveLength(2);
    expect(history.messages[0]).toEqual({
      role: "user",
      content: "What projects do I have?",
    });
    expect(history.messages[1].role).toBe("assistant");

    const res = await request(app).get(`${API_PREFIX}/help/chat/history`);
    expect(res.status).toBe(200);
    expect(res.body.data.messages).toHaveLength(2);
    expect(res.body.data.messages[0]).toEqual({
      role: "user",
      content: "What projects do I have?",
    });
    expect(res.body.data.messages[1].role).toBe("assistant");
  });

  it("GET /help/analytics returns byComplexity and totalTasks (project scope)", async () => {
    const t1 = await taskStore.create(projectId, "Task 1", { type: "task", complexity: 3 });
    const t2 = await taskStore.create(projectId, "Task 2", { type: "task", complexity: 5 });
    await taskStore.close(projectId, t1.id, "Done");
    await taskStore.close(projectId, t2.id, "Done");

    const res = await request(app).get(`${API_PREFIX}/help/analytics?projectId=${projectId}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.byComplexity).toHaveLength(10);
    expect(res.body.data.totalTasks).toBe(2);
    const b3 = res.body.data.byComplexity.find((b: { complexity: number }) => b.complexity === 3);
    const b5 = res.body.data.byComplexity.find((b: { complexity: number }) => b.complexity === 5);
    expect(b3?.taskCount).toBe(1);
    expect(b5?.taskCount).toBe(1);
    expect(b3?.avgCompletionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("GET /help/analytics returns global scope when projectId omitted", async () => {
    const res = await request(app).get(`${API_PREFIX}/help/analytics`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.byComplexity).toHaveLength(10);
    expect(res.body.data.totalTasks).toBeGreaterThanOrEqual(0);
  });

  it("GET /help/agent-log returns entries for project scope", async () => {
    await taskStore.runWrite(async (client) => {
      await client.execute(
        `INSERT INTO agent_stats (project_id, task_id, agent_id, role, model, attempt, started_at, completed_at, outcome, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          projectId,
          "os-abc.1",
          "cursor-cursor-composer-1.5",
          "coder",
          "claude-sonnet-4",
          1,
          "2025-03-01T10:00:00Z",
          "2025-03-01T10:01:30Z",
          "success",
          90000,
        ]
      );
    });

    const res = await request(app).get(`${API_PREFIX}/help/agent-log?projectId=${projectId}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      model: "claude-sonnet-4",
      role: "Coder",
      durationMs: 90000,
      endTime: "2025-03-01T10:01:30Z",
    });
    expect(res.body.data[0]).not.toHaveProperty("projectName");
  });

  it("GET /help/agent-log returns entries with project names for global scope", async () => {
    await taskStore.runWrite(async (client) => {
      await client.execute(
        `INSERT INTO agent_stats (project_id, task_id, agent_id, role, model, attempt, started_at, completed_at, outcome, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          projectId,
          "os-xyz.1",
          "claude-claude-sonnet-4",
          "reviewer",
          "claude-sonnet-4",
          1,
          "2025-03-01T11:00:00Z",
          "2025-03-01T11:02:00Z",
          "success",
          120000,
        ]
      );
    });

    const res = await request(app).get(`${API_PREFIX}/help/agent-log`);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(Array.isArray(res.body.data)).toBe(true);
    const entry = res.body.data.find((e: { role: string }) => e.role === "Reviewer");
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      model: "claude-sonnet-4",
      role: "Reviewer",
      durationMs: 120000,
      endTime: "2025-03-01T11:02:00Z",
      projectName: "Test Project",
    });
  });

  it("GET /help/agent-log shows provider + model label when session has agent_type/agent_model", async () => {
    await taskStore.runWrite(async (client) => {
      await client.execute(
        `INSERT INTO agent_stats (project_id, task_id, agent_id, role, model, attempt, started_at, completed_at, outcome, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          projectId,
          "os-label.1",
          "coder",
          "coder",
          "unknown",
          1,
          "2025-03-01T13:00:00Z",
          "2025-03-01T13:01:00Z",
          "success",
          60000,
        ]
      );
      await client.execute(
        `INSERT INTO agent_sessions (project_id, task_id, attempt, agent_type, agent_model, started_at, completed_at, status, output_log, git_branch)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          projectId,
          "os-label.1",
          1,
          "cursor",
          "Composer 1.5",
          "2025-03-01T13:00:00Z",
          "2025-03-01T13:01:00Z",
          "completed",
          "log",
          "main",
        ]
      );
    });

    const res = await request(app).get(`${API_PREFIX}/help/agent-log?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const labelEntry = res.body.data.find((e: { model: string }) => e.model === "Cursor Composer 1.5");
    expect(labelEntry).toBeDefined();
    expect(labelEntry?.model).toBe("Cursor Composer 1.5");
  });

  it("GET /help/agent-log shows Cursor Composer 1.5 when session has cursor type and empty model", async () => {
    await taskStore.runWrite(async (client) => {
      await client.execute(
        `INSERT INTO agent_stats (project_id, task_id, agent_id, role, model, attempt, started_at, completed_at, outcome, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          projectId,
          "os-cursor-default.1",
          "coder",
          "coder",
          "unknown",
          1,
          "2025-03-01T13:10:00Z",
          "2025-03-01T13:11:00Z",
          "success",
          60000,
        ]
      );
      await client.execute(
        `INSERT INTO agent_sessions (project_id, task_id, attempt, agent_type, agent_model, started_at, completed_at, status, output_log, git_branch)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          projectId,
          "os-cursor-default.1",
          1,
          "cursor",
          "",
          "2025-03-01T13:10:00Z",
          "2025-03-01T13:11:00Z",
          "completed",
          "",
          "main",
        ]
      );
    });

    const res = await request(app).get(`${API_PREFIX}/help/agent-log?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const entry = res.body.data.find(
      (e: { model: string; durationMs: number }) => e.durationMs === 60000 && e.model.includes("Cursor")
    );
    expect(entry).toBeDefined();
    expect(entry.model).toBe("Cursor Composer 1.5");
  });

  it("GET /help/agent-log shows Unknown when model missing and no session", async () => {
    await taskStore.runWrite(async (client) => {
      await client.execute(
        `INSERT INTO agent_stats (project_id, task_id, agent_id, role, model, attempt, started_at, completed_at, outcome, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          projectId,
          "os-unknown.1",
          "coder",
          "coder",
          "",
          1,
          "2025-03-01T14:00:00Z",
          "2025-03-01T14:00:30Z",
          "success",
          30000,
        ]
      );
    });

    const res = await request(app).get(`${API_PREFIX}/help/agent-log?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const unknownEntry = res.body.data.find((e: { durationMs: number }) => e.durationMs === 30000);
    expect(unknownEntry).toBeDefined();
    expect(unknownEntry?.model).toBe("Unknown");
  });

  it("GET /help/agent-log includes sessionId when agent_sessions has output_log", async () => {
    await taskStore.runWrite(async (client) => {
      await client.execute(
        `INSERT INTO agent_stats (project_id, task_id, agent_id, role, model, attempt, started_at, completed_at, outcome, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          projectId,
          "os-sess.1",
          "cursor-cursor-composer",
          "coder",
          "claude-sonnet-4",
          1,
          "2025-03-01T12:00:00Z",
          "2025-03-01T12:01:00Z",
          "success",
          60000,
        ]
      );
      await client.execute(
        `INSERT INTO agent_sessions (project_id, task_id, attempt, agent_type, agent_model, started_at, completed_at, status, output_log, git_branch)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          projectId,
          "os-sess.1",
          1,
          "coder",
          "claude-sonnet-4",
          "2025-03-01T12:00:00Z",
          "2025-03-01T12:01:00Z",
          "completed",
          "Agent output line 1\nAgent output line 2\n",
          "main",
        ]
      );
    });

    const logRes = await request(app).get(`${API_PREFIX}/help/agent-log?projectId=${projectId}`);
    expect(logRes.status).toBe(200);
    const entry = logRes.body.data.find(
      (e: { role: string; durationMs: number }) => e.role === "Coder" && e.durationMs === 60000
    );
    expect(entry).toBeDefined();
    expect(entry.sessionId).toBeDefined();
    expect(typeof entry.sessionId).toBe("number");

    const sessionRes = await request(app).get(`${API_PREFIX}/help/session-log/${entry.sessionId}`);
    expect(sessionRes.status).toBe(200);
    expect(sessionRes.body.data).toMatchObject({
      content: "Agent output line 1\nAgent output line 2\n",
    });
  });

  it("GET /help/session-log/:sessionId returns 400 for invalid session ID", async () => {
    const res = await request(app).get(`${API_PREFIX}/help/session-log/0`);
    expect(res.status).toBe(400);
  });

  it("GET /help/session-log/:sessionId returns 404 when session not found", async () => {
    const res = await request(app).get(`${API_PREFIX}/help/session-log/999999`);
    expect(res.status).toBe(404);
  });

  it("project and homepage help histories are stored separately", async () => {
    await request(app).post(`${API_PREFIX}/help/chat`).send({ message: "Homepage question" });
    await request(app)
      .post(`${API_PREFIX}/help/chat`)
      .send({ message: "Project question", projectId });

    const homepageHistory = await helpChatService.getHistory(null);
    const projectHistory = await helpChatService.getHistory(projectId);
    expect(homepageHistory.messages[0].content).toBe("Homepage question");
    expect(projectHistory.messages[0].content).toBe("Project question");

    const homepageRes = await request(app).get(`${API_PREFIX}/help/chat/history`);
    const projectRes = await request(app).get(
      `${API_PREFIX}/help/chat/history?projectId=${projectId}`
    );
    expect(homepageRes.body.data.messages[0].content).toBe("Homepage question");
    expect(projectRes.body.data.messages[0].content).toBe("Project question");
  });
});
