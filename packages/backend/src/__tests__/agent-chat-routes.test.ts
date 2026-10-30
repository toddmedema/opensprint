import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createTasksRouter } from "../routes/tasks.js";
import type { TaskService } from "../services/task.service.js";
import { API_PREFIX } from "@opensprint/shared";
import { errorHandler } from "../middleware/error-handler.js";
import { withLocalSessionAuth } from "./local-auth-test-helpers.js";

const mockGetHistory = vi.fn();
const mockSupportsChat = vi.fn();

vi.mock("../services/agent-chat.service.js", () => ({
  agentChatService: {
    getHistory: (...args: unknown[]) => mockGetHistory(...args),
    supportsChat: (...args: unknown[]) => mockSupportsChat(...args),
  },
}));

/**
 * Tasks router only — no `requireLocalSessionAuth` on this mini-app. Requests still use
 * `withLocalSessionAuth` so behavior matches production when the router is mounted behind
 * the real API gate (merge-gate / local-session parity).
 */
function buildApp() {
  const taskService = {} as unknown as TaskService;
  const app = express();
  app.use(express.json());
  app.use(`${API_PREFIX}/projects/:projectId/tasks`, createTasksRouter(taskService));
  app.use(errorHandler);
  return app;
}

describe("GET /tasks/:taskId/chat-history", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    app = buildApp();
  });

  it("returns messages in chronological order for a given attempt", async () => {
    const messages = [
      {
        id: "msg-1",
        timestamp: "2026-03-25T10:00:00Z",
        role: "user",
        content: "First",
        attempt: 1,
      },
      {
        id: "msg-2",
        timestamp: "2026-03-25T10:01:00Z",
        role: "assistant",
        content: "Second",
        attempt: 1,
      },
      {
        id: "msg-3",
        timestamp: "2026-03-25T10:02:00Z",
        role: "user",
        content: "Third",
        attempt: 1,
      },
    ];
    mockGetHistory.mockReturnValue(messages);
    mockSupportsChat.mockReturnValue({ supported: true, backend: "claude", reason: null });

    const res = await withLocalSessionAuth(
      request(app).get(`${API_PREFIX}/projects/proj-1/tasks/os-1234/chat-history?attempt=1`)
    );

    expect(res.status).toBe(200);
    expect(res.body.data.messages).toHaveLength(3);
    expect(res.body.data.messages.map((m: { id: string }) => m.id)).toEqual([
      "msg-1",
      "msg-2",
      "msg-3",
    ]);
    expect(res.body.data.attempt).toBe(1);
    expect(res.body.data.chatSupported).toBe(true);

    expect(mockGetHistory).toHaveBeenCalledWith("proj-1", "os-1234", 1);
  });

  it("defaults to the latest attempt when attempt is omitted", async () => {
    const allMessages = [
      {
        id: "msg-a1",
        timestamp: "2026-03-25T09:00:00Z",
        role: "user",
        content: "Attempt 1",
        attempt: 1,
      },
      {
        id: "msg-a2",
        timestamp: "2026-03-25T10:00:00Z",
        role: "user",
        content: "Attempt 2",
        attempt: 2,
      },
      {
        id: "msg-a3",
        timestamp: "2026-03-25T10:01:00Z",
        role: "assistant",
        content: "Reply attempt 2",
        attempt: 2,
      },
    ];
    mockGetHistory.mockReturnValue(allMessages);
    mockSupportsChat.mockReturnValue({ supported: true, backend: "openai", reason: null });

    const res = await withLocalSessionAuth(
      request(app).get(`${API_PREFIX}/projects/proj-1/tasks/os-5678/chat-history`)
    );

    expect(res.status).toBe(200);
    expect(res.body.data.attempt).toBe(2);
    expect(res.body.data.messages).toHaveLength(2);
    expect(res.body.data.messages.map((m: { id: string }) => m.id)).toEqual(["msg-a2", "msg-a3"]);

    expect(mockGetHistory).toHaveBeenCalledWith("proj-1", "os-5678");
  });

  it("returns attempt=1 and empty messages when no chat history exists", async () => {
    mockGetHistory.mockReturnValue([]);
    mockSupportsChat.mockReturnValue({
      supported: false,
      backend: null,
      reason: "No active agent found for this task.",
    });

    const res = await withLocalSessionAuth(
      request(app).get(`${API_PREFIX}/projects/proj-1/tasks/os-empty/chat-history`)
    );

    expect(res.status).toBe(200);
    expect(res.body.data.attempt).toBe(1);
    expect(res.body.data.messages).toEqual([]);
    expect(res.body.data.chatSupported).toBe(false);
  });

  it("returns chatSupported=false when agent backend is CLI", async () => {
    mockGetHistory.mockReturnValue([]);
    mockSupportsChat.mockReturnValue({
      supported: false,
      backend: "claude-cli",
      reason:
        "Chat is not available for CLI-based agent backends. Switch to API mode (Project Settings → Agent Config) to chat with running agents.",
    });

    const res = await withLocalSessionAuth(
      request(app).get(`${API_PREFIX}/projects/proj-1/tasks/os-cli/chat-history?attempt=1`)
    );

    expect(res.status).toBe(200);
    expect(res.body.data.chatSupported).toBe(false);
  });

  it("rejects invalid attempt (non-positive integer)", async () => {
    const res = await withLocalSessionAuth(
      request(app).get(`${API_PREFIX}/projects/proj-1/tasks/os-1234/chat-history?attempt=-1`)
    );

    expect(res.status).toBe(400);
  });
});

describe("GET /tasks/:taskId/chat-support", () => {
  let app: express.Express;

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    app = buildApp();
  });

  it("returns supported=true for API backend (claude)", async () => {
    mockSupportsChat.mockReturnValue({ supported: true, backend: "claude", reason: null });

    const res = await withLocalSessionAuth(
      request(app).get(`${API_PREFIX}/projects/proj-1/tasks/os-api/chat-support`)
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      supported: true,
      backend: "claude",
      reason: null,
    });
    expect(mockSupportsChat).toHaveBeenCalledWith("os-api", "proj-1");
  });

  it("returns supported=false for CLI backend with exact instructional reason", async () => {
    const expectedReason =
      "Chat is not available for CLI-based agent backends. Switch to API mode (Project Settings → Agent Config) to chat with running agents.";

    mockSupportsChat.mockReturnValue({
      supported: false,
      backend: "claude-cli",
      reason: expectedReason,
    });

    const res = await withLocalSessionAuth(
      request(app).get(`${API_PREFIX}/projects/proj-1/tasks/os-cli-task/chat-support`)
    );

    expect(res.status).toBe(200);
    expect(res.body.data.supported).toBe(false);
    expect(res.body.data.backend).toBe("claude-cli");
    expect(res.body.data.reason).toBe(expectedReason);
  });

  it("returns supported=false for cursor CLI backend with exact instructional reason", async () => {
    const expectedReason =
      "Chat is not available for CLI-based agent backends. Switch to API mode (Project Settings → Agent Config) to chat with running agents.";

    mockSupportsChat.mockReturnValue({
      supported: false,
      backend: "cursor",
      reason: expectedReason,
    });

    const res = await withLocalSessionAuth(
      request(app).get(`${API_PREFIX}/projects/proj-1/tasks/os-cursor-task/chat-support`)
    );

    expect(res.status).toBe(200);
    expect(res.body.data.supported).toBe(false);
    expect(res.body.data.backend).toBe("cursor");
    expect(res.body.data.reason).toBe(expectedReason);
  });

  it("returns supported=false with null backend when no agent is active", async () => {
    mockSupportsChat.mockReturnValue({
      supported: false,
      backend: null,
      reason: "No active agent found for this task.",
    });

    const res = await withLocalSessionAuth(
      request(app).get(`${API_PREFIX}/projects/proj-1/tasks/os-no-agent/chat-support`)
    );

    expect(res.status).toBe(200);
    expect(res.body.data.supported).toBe(false);
    expect(res.body.data.backend).toBeNull();
    expect(res.body.data.reason).toBe("No active agent found for this task.");
  });

  it.each(["claude", "openai", "google", "lmstudio", "ollama"] as const)(
    "returns supported=true for %s API backend",
    async (backend) => {
      mockSupportsChat.mockReturnValue({ supported: true, backend, reason: null });

      const res = await withLocalSessionAuth(
        request(app).get(`${API_PREFIX}/projects/proj-1/tasks/os-chat-api-${backend}/chat-support`)
      );

      expect(res.status).toBe(200);
      expect(res.body.data.supported).toBe(true);
      expect(res.body.data.backend).toBe(backend);
      expect(res.body.data.reason).toBeNull();
      expect(mockSupportsChat).toHaveBeenCalledWith(`os-chat-api-${backend}`, "proj-1");
    }
  );
});
