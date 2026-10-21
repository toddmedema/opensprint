import { initAppDb, type AppDb } from "../db/app-db.js";
/**
 * Integration tests for agent chat (WebSocket) and open-editor (HTTP) flows.
 *
 * These tests spin real HTTP + WebSocket servers with injectable services
 * and use temporary filesystem fixtures. No real LLM keys are required;
 * ActiveAgentsService / AgentChatService are wired with in-memory state and
 * the open-editor collaborators are vi.mock'd with temp-dir fixtures.
 */
import * as crypto from "node:crypto";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "http";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { WebSocket } from "ws";
import express from "express";
import request from "supertest";
import { setupWebSocket, closeWebSocket, sendAgentChatResponse } from "../websocket/index.js";
import { VITEST_DEFAULT_LOCAL_SESSION_TOKEN } from "../services/local-session-auth.service.js";

const WS_AUTH = { headers: { Authorization: `Bearer ${VITEST_DEFAULT_LOCAL_SESSION_TOKEN}` } };
import { AgentChatService } from "../services/agent-chat.service.js";
import { ActiveAgentsService } from "../services/active-agents.service.js";
import { PendingMessageQueue } from "../services/agentic-loop.js";
import { createTasksRouter } from "../routes/tasks.js";
import type { TaskService } from "../services/task.service.js";
import { API_PREFIX } from "@opensprint/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { requireLocalSessionAuth } from "../middleware/require-local-session-auth.js";
import { withLocalSessionAuth } from "./local-auth-test-helpers.js";

// ---------------------------------------------------------------------------
// Mocks for open-editor dependencies (project service, orchestrator, etc.)
// ---------------------------------------------------------------------------

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getRepoPath: vi.fn(),
    getSettings: vi.fn(),
    listProjects: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("../services/branch-manager.js", () => ({
  BranchManager: vi.fn().mockImplementation(() => ({
    getWorktreePath: vi.fn(),
  })),
}));

vi.mock("../services/orchestrator.service.js", () => ({
  orchestratorService: {
    getStatus: vi.fn(),
    setSessionManager: vi.fn(),
    getActiveAgents: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../services/global-settings.service.js", () => ({
  getGlobalSettings: vi.fn(),
  getEffectiveDatabaseConfig: vi
    .fn()
    .mockResolvedValue({ source: "default", databaseUrl: "sqlite://:memory:" }),
  getDatabaseUrl: vi.fn().mockResolvedValue("sqlite://:memory:"),
}));

vi.mock("../services/hil-service.js", () => ({
  hilService: { respondToRequest: vi.fn() },
}));

const { ProjectService } = await import("../services/project.service.js");
const { BranchManager } = await import("../services/branch-manager.js");
const { orchestratorService } = await import("../services/orchestrator.service.js");
const { getGlobalSettings } = await import("../services/global-settings.service.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on("close", () => resolve());
  });
}

function collectEvents(
  ws: WebSocket,
  type: string,
  count: number,
  timeoutMs = 5_000
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const events: Record<string, unknown>[] = [];
    const timer = setTimeout(
      () =>
        reject(new Error(`Timed out waiting for ${count} ${type} event(s); got ${events.length}`)),
      timeoutMs
    );
    ws.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === type) {
        events.push(event);
        if (events.length >= count) {
          clearTimeout(timer);
          resolve(events);
        }
      }
    });
  });
}

function waitForEvent(
  ws: WebSocket,
  type: string,
  timeoutMs = 5_000
): Promise<Record<string, unknown>> {
  return collectEvents(ws, type, 1, timeoutMs).then((events) => events[0]);
}

function setupOpenEditorMocks(opts: {
  tmpDir: string;
  gitWorkingMode?: "worktree" | "branches";
  activeTasks?: Array<{ taskId: string; worktreePath?: string | null; [k: string]: unknown }>;
  branchWorktreePath?: string;
  preferredEditor?: "vscode" | "cursor" | "auto";
}) {
  const defaults = {
    gitWorkingMode: "worktree" as const,
    activeTasks: [
      {
        taskId: "os-1234",
        phase: "coding",
        startedAt: new Date().toISOString(),
        state: "running",
        worktreePath: opts.tmpDir,
      },
    ],
    branchWorktreePath: opts.tmpDir,
    preferredEditor: "auto" as const,
    ...opts,
  };

  const projInstance = {
    getRepoPath: vi.fn().mockResolvedValue(opts.tmpDir),
    getSettings: vi.fn().mockResolvedValue({ gitWorkingMode: defaults.gitWorkingMode }),
    listProjects: vi.fn().mockResolvedValue([]),
  };
  vi.mocked(ProjectService).mockImplementation(() => projInstance as never);

  const branchInstance = {
    getWorktreePath: vi.fn().mockReturnValue(defaults.branchWorktreePath),
  };
  vi.mocked(BranchManager).mockImplementation(() => branchInstance as never);

  vi.mocked(orchestratorService.getStatus).mockResolvedValue({
    activeTasks: defaults.activeTasks as never,
    queueDepth: 0,
    totalDone: 0,
    totalFailed: 0,
  });

  vi.mocked(getGlobalSettings).mockResolvedValue({
    preferredEditor: defaults.preferredEditor,
  });

  return { projInstance, branchInstance };
}

// ---------------------------------------------------------------------------
// Agent Chat — WebSocket integration
// ---------------------------------------------------------------------------

describe("agent-chat integration (WebSocket)", () => {
  let server: HttpServer;
  let port: number;
  let activeAgents: ActiveAgentsService;
  let chatSvc: AgentChatService;
  let chatBasePath: string;
  let chatDb: AppDb;

  beforeEach(async () => {
    chatBasePath = await fs.mkdtemp(path.join(os.tmpdir(), "chat-integ-"));
    activeAgents = new ActiveAgentsService();
    chatDb = await initAppDb("sqlite://:memory:");
    chatSvc = new AgentChatService(activeAgents, chatBasePath, {
      runWrite: (fn) => chatDb.runWrite(fn),
      runRead: (fn) => chatDb.runRead!(fn),
    });

    server = createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    setupWebSocket(server, { agentChatService: chatSvc });
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });

  afterEach(async () => {
    closeWebSocket();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((r) => setTimeout(r, 50));
    await chatDb.close();
    await fs.rm(chatBasePath, { recursive: true, force: true }).catch(() => {});
  });

  it("WS client sends agent.chat.send → receives agent.chat.received, then server pushes agent.chat.response", async () => {
    const queue = new PendingMessageQueue();
    activeAgents.registerChannel("task-api", queue, "openai", { projectId: "proj-integ" });

    const ws = new WebSocket(`ws://localhost:${port}/ws/projects/proj-integ`, WS_AUTH);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    const receivedPromise = waitForEvent(ws, "agent.chat.received");
    ws.send(
      JSON.stringify({
        type: "agent.chat.send",
        clientMessageId: crypto.randomUUID(),
        taskId: "task-api",
        message: "Describe the bug",
      })
    );

    const received = await receivedPromise;
    expect(received.type).toBe("agent.chat.received");
    expect(received.taskId).toBe("task-api");
    expect(received.messageId).toBeTruthy();
    expect(received.timestamp).toBeTruthy();

    // Message was delivered to the pending queue
    expect(queue.size).toBe(1);
    const drained = queue.drain();
    expect(drained[0].message).toBe("Describe the bug");

    // Simulate the agentic loop responding
    const responsePromise = waitForEvent(ws, "agent.chat.response");
    sendAgentChatResponse(
      "proj-integ",
      "task-api",
      received.messageId as string,
      "I found the issue in line 42."
    );
    const response = await responsePromise;
    expect(response.type).toBe("agent.chat.response");
    expect(response.taskId).toBe("task-api");
    expect(response.messageId).toBe(received.messageId);
    expect(response.content).toBe("I found the issue in line 42.");

    // Chat log persisted on disk
    const history = await chatSvc.getHistory("proj-integ", "task-api");
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe("Describe the bug");

    ws.close();
    await waitForClose(ws);
  });

  it("CLI backend returns agent.chat.unsupported", async () => {
    const queue = new PendingMessageQueue();
    activeAgents.registerChannel("task-cli", queue, "claude-cli", { projectId: "proj-cli" });

    const ws = new WebSocket(`ws://localhost:${port}/ws/projects/proj-cli`, WS_AUTH);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    const unsupportedPromise = waitForEvent(ws, "agent.chat.unsupported");
    ws.send(
      JSON.stringify({
        type: "agent.chat.send",
        clientMessageId: crypto.randomUUID(),
        taskId: "task-cli",
        message: "hello",
      })
    );

    const unsupported = await unsupportedPromise;
    expect(unsupported.type).toBe("agent.chat.unsupported");
    expect(unsupported.taskId).toBe("task-cli");
    expect(unsupported.reason).toMatch(/CLI-based agent backends/);

    // Queue should not have received the message
    expect(queue.size).toBe(0);

    ws.close();
    await waitForClose(ws);
  });

  it("cursor CLI backend returns agent.chat.unsupported", async () => {
    const queue = new PendingMessageQueue();
    activeAgents.registerChannel("task-cursor", queue, "cursor", { projectId: "proj-cursor" });

    const ws = new WebSocket(`ws://localhost:${port}/ws/projects/proj-cursor`, WS_AUTH);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    const unsupportedPromise = waitForEvent(ws, "agent.chat.unsupported");
    ws.send(
      JSON.stringify({
        type: "agent.chat.send",
        clientMessageId: crypto.randomUUID(),
        taskId: "task-cursor",
        message: "hey",
      })
    );

    const unsupported = await unsupportedPromise;
    expect(unsupported.type).toBe("agent.chat.unsupported");
    expect(unsupported.taskId).toBe("task-cursor");
    expect(unsupported.reason).toMatch(/CLI-based/);

    ws.close();
    await waitForClose(ws);
  });

  it("returns unsupported when no agent is active for the task", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/projects/proj-ghost`, WS_AUTH);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    const unsupportedPromise = waitForEvent(ws, "agent.chat.unsupported");
    ws.send(
      JSON.stringify({
        type: "agent.chat.send",
        clientMessageId: crypto.randomUUID(),
        taskId: "task-ghost",
        message: "anyone?",
      })
    );

    const unsupported = await unsupportedPromise;
    expect(unsupported.type).toBe("agent.chat.unsupported");
    expect(unsupported.taskId).toBe("task-ghost");
    expect(unsupported.reason).toMatch(/no active agent/i);

    ws.close();
    await waitForClose(ws);
  });

  it("multiple messages queue and persist in order", async () => {
    const queue = new PendingMessageQueue();
    activeAgents.registerChannel("task-multi", queue, "google", { projectId: "proj-multi" });

    const ws = new WebSocket(`ws://localhost:${port}/ws/projects/proj-multi`, WS_AUTH);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    const receivedPromise = collectEvents(ws, "agent.chat.received", 3);

    ws.send(
      JSON.stringify({
        type: "agent.chat.send",
        clientMessageId: crypto.randomUUID(),
        taskId: "task-multi",
        message: "First",
      })
    );
    ws.send(
      JSON.stringify({
        type: "agent.chat.send",
        clientMessageId: crypto.randomUUID(),
        taskId: "task-multi",
        message: "Second",
      })
    );
    ws.send(
      JSON.stringify({
        type: "agent.chat.send",
        clientMessageId: crypto.randomUUID(),
        taskId: "task-multi",
        message: "Third",
      })
    );

    const received = await receivedPromise;
    expect(received).toHaveLength(3);

    const drained = queue.drain();
    expect(drained.map((d) => d.message)).toEqual(["First", "Second", "Third"]);

    const history = await chatSvc.getHistory("proj-multi", "task-multi");
    expect(history).toHaveLength(3);
    expect(history.map((m) => m.content)).toEqual(["First", "Second", "Third"]);

    ws.close();
    await waitForClose(ws);
  });

  it("full round-trip: send → received → assistant response persisted → chat.response broadcast", async () => {
    const queue = new PendingMessageQueue();
    activeAgents.registerChannel("task-round", queue, "claude", { projectId: "proj-round" });

    const ws = new WebSocket(`ws://localhost:${port}/ws/projects/proj-round`, WS_AUTH);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));

    // User sends chat
    const receivedPromise = waitForEvent(ws, "agent.chat.received");
    ws.send(
      JSON.stringify({
        type: "agent.chat.send",
        clientMessageId: crypto.randomUUID(),
        taskId: "task-round",
        message: "Fix tests",
      })
    );
    const _received = await receivedPromise;

    // Simulate assistant responding and persisting
    const assistantMsg = await chatSvc.appendAssistantMessage(
      "task-round",
      "Tests fixed.",
      1,
      "proj-round"
    );

    // Server pushes the response event
    const responsePromise = waitForEvent(ws, "agent.chat.response");
    sendAgentChatResponse("proj-round", "task-round", assistantMsg.id, assistantMsg.content);
    const response = await responsePromise;

    expect(response.content).toBe("Tests fixed.");
    expect(response.messageId).toBe(assistantMsg.id);

    // Full history on disk: user + assistant
    const history = await chatSvc.getHistory("proj-round", "task-round");
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe("Fix tests");
    expect(history[1].role).toBe("assistant");
    expect(history[1].content).toBe("Tests fixed.");

    ws.close();
    await waitForClose(ws);
  });
});

// ---------------------------------------------------------------------------
// Open-Editor — HTTP integration with temp filesystem
// ---------------------------------------------------------------------------

describe("open-editor integration (HTTP)", () => {
  let tmpDir: string;
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "open-editor-integ-"));

    const taskService = {} as unknown as TaskService;
    app = express();
    app.use(express.json());
    app.use(API_PREFIX, requireLocalSessionAuth);
    app.use(`${API_PREFIX}/projects/:projectId/tasks`, createTasksRouter(taskService));
    app.use(errorHandler);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("happy path: returns worktree path and editor when task is executing and path exists", async () => {
    setupOpenEditorMocks({
      tmpDir,
      activeTasks: [
        {
          taskId: "os-1234",
          worktreePath: tmpDir,
          phase: "coding",
          startedAt: new Date().toISOString(),
          state: "running",
        },
      ],
    });

    const res = await withLocalSessionAuth(
      request(app).post(`${API_PREFIX}/projects/proj-1/tasks/os-1234/open-editor`)
    );

    expect(res.status).toBe(200);
    expect(res.body.data.worktreePath).toBe(tmpDir);
    expect(res.body.data.opened).toBe(true);
    expect(["vscode", "cursor", "none"]).toContain(res.body.data.editor);
  });

  it("404: worktree path does not exist on disk", async () => {
    const nonexistent = path.join(tmpDir, "does-not-exist");
    setupOpenEditorMocks({
      tmpDir,
      activeTasks: [
        {
          taskId: "os-404",
          worktreePath: nonexistent,
          phase: "coding",
          startedAt: new Date().toISOString(),
          state: "running",
        },
      ],
    });

    const res = await withLocalSessionAuth(
      request(app).post(`${API_PREFIX}/projects/proj-1/tasks/os-404/open-editor`)
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("WORKTREE_NOT_FOUND");
    expect(res.body.error.message).toMatch(/does not exist/i);
  });

  it("409: task is not currently executing", async () => {
    setupOpenEditorMocks({
      tmpDir,
      activeTasks: [],
    });

    const res = await withLocalSessionAuth(
      request(app).post(`${API_PREFIX}/projects/proj-1/tasks/os-idle/open-editor`)
    );

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("TASK_NOT_EXECUTING");
    expect(res.body.error.message).toMatch(/not currently executing/i);
  });

  it("branches mode: returns repo root even when activeEntry has different worktreePath", async () => {
    setupOpenEditorMocks({
      tmpDir,
      gitWorkingMode: "branches",
      activeTasks: [
        {
          taskId: "os-branch",
          worktreePath: "/some/other/path",
          phase: "coding",
          startedAt: new Date().toISOString(),
          state: "running",
        },
      ],
    });

    const res = await withLocalSessionAuth(
      request(app).post(`${API_PREFIX}/projects/proj-1/tasks/os-branch/open-editor`)
    );

    expect(res.status).toBe(200);
    expect(res.body.data.worktreePath).toBe(tmpDir);
    expect(res.body.data.opened).toBe(true);
  });

  it("falls back to BranchManager.getWorktreePath when activeEntry has null worktreePath", async () => {
    const { branchInstance } = setupOpenEditorMocks({
      tmpDir,
      gitWorkingMode: "worktree",
      activeTasks: [
        {
          taskId: "os-fallback",
          worktreePath: null,
          phase: "coding",
          startedAt: new Date().toISOString(),
          state: "running",
        },
      ],
      branchWorktreePath: tmpDir,
    });

    const res = await withLocalSessionAuth(
      request(app).post(`${API_PREFIX}/projects/proj-1/tasks/os-fallback/open-editor`)
    );

    expect(res.status).toBe(200);
    expect(res.body.data.worktreePath).toBe(tmpDir);
    expect(branchInstance.getWorktreePath).toHaveBeenCalledWith("os-fallback", tmpDir);
  });
});
