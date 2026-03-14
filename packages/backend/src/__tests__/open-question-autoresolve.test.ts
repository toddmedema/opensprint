import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Notification } from "../services/notification.service.js";

const mocks = vi.hoisted(() => ({
  mockGetSettings: vi.fn(),
  mockGetRepoPath: vi.fn(),
  mockGetPrd: vi.fn(),
  mockInvokePlanningAgent: vi.fn(),
  mockResolve: vi.fn(),
  mockTaskStoreUpdate: vi.fn(),
  mockSendMessage: vi.fn(),
  mockRecategorizeFeedback: vi.fn(),
  mockGetCombinedInstructions: vi.fn(),
  mockBroadcastToProject: vi.fn(),
}));

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getSettings: mocks.mockGetSettings,
    getRepoPath: mocks.mockGetRepoPath,
  })),
}));

vi.mock("../services/prd.service.js", () => ({
  PrdService: vi.fn().mockImplementation(() => ({
    getPrd: mocks.mockGetPrd,
  })),
}));

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: mocks.mockInvokePlanningAgent,
  },
}));

vi.mock("../services/notification.service.js", () => ({
  notificationService: {
    resolve: mocks.mockResolve,
  },
}));

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    update: mocks.mockTaskStoreUpdate,
  },
}));

vi.mock("../services/chat.service.js", () => ({
  ChatService: vi.fn().mockImplementation(() => ({
    sendMessage: mocks.mockSendMessage,
  })),
}));

vi.mock("../services/feedback.service.js", () => ({
  FeedbackService: vi.fn().mockImplementation(() => ({
    recategorizeFeedback: mocks.mockRecategorizeFeedback,
  })),
}));

vi.mock("../services/agent-instructions.service.js", () => ({
  getCombinedInstructions: mocks.mockGetCombinedInstructions,
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: mocks.mockBroadcastToProject,
}));

import { maybeAutoRespond } from "../services/open-question-autoresolve.service.js";

function openQuestionNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "oq-abc12345",
    projectId: "proj-1",
    source: "execute",
    sourceId: "task-1",
    questions: [{ id: "q1", text: "Which database?", createdAt: new Date().toISOString() }],
    status: "open",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
    kind: "open_question",
    ...overrides,
  };
}

describe("open-question-autoresolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.mockGetCombinedInstructions.mockResolvedValue("");
    mocks.mockGetRepoPath.mockResolvedValue("/tmp/repo");
  });

  it("does nothing when notification kind is not open_question", async () => {
    const notification = openQuestionNotification({ kind: "api_blocked" });
    await maybeAutoRespond("proj-1", notification);
    expect(mocks.mockGetSettings).not.toHaveBeenCalled();
    expect(mocks.mockInvokePlanningAgent).not.toHaveBeenCalled();
  });

  it("does nothing when aiAutonomyLevel is not full", async () => {
    mocks.mockGetSettings.mockResolvedValue({ aiAutonomyLevel: "confirm_all" });
    const notification = openQuestionNotification();
    await maybeAutoRespond("proj-1", notification);
    expect(mocks.mockGetSettings).toHaveBeenCalledWith("proj-1");
    expect(mocks.mockInvokePlanningAgent).not.toHaveBeenCalled();
  });

  it("does nothing when notification has no question text", async () => {
    mocks.mockGetSettings.mockResolvedValue({ aiAutonomyLevel: "full" });
    const notification = openQuestionNotification({
      questions: [{ id: "q1", text: "", createdAt: new Date().toISOString() }],
    });
    await maybeAutoRespond("proj-1", notification);
    expect(mocks.mockGetPrd).not.toHaveBeenCalled();
    expect(mocks.mockInvokePlanningAgent).not.toHaveBeenCalled();
  });

  it("does not apply answer when Dreamer returns empty content", async () => {
    mocks.mockGetSettings.mockResolvedValue({ aiAutonomyLevel: "full" });
    mocks.mockGetPrd.mockResolvedValue({ sections: {} });
    mocks.mockInvokePlanningAgent.mockResolvedValue({ content: "" });
    const notification = openQuestionNotification();
    await maybeAutoRespond("proj-1", notification);
    expect(mocks.mockInvokePlanningAgent).toHaveBeenCalled();
    expect(mocks.mockSendMessage).not.toHaveBeenCalled();
    expect(mocks.mockResolve).not.toHaveBeenCalled();
  });

  it("invokes Dreamer and applies answer for execute source when full autonomy", async () => {
    mocks.mockGetSettings.mockResolvedValue({ aiAutonomyLevel: "full" });
    mocks.mockGetPrd.mockResolvedValue({
      sections: { executive_summary: { content: "Build a volunteer app." } },
    });
    mocks.mockInvokePlanningAgent.mockResolvedValue({ content: "Use PostgreSQL for the backend." });
    mocks.mockSendMessage.mockResolvedValue({ message: "OK" });
    mocks.mockResolve.mockResolvedValue({ status: "resolved" });
    mocks.mockTaskStoreUpdate.mockResolvedValue({});

    const notification = openQuestionNotification({
      source: "execute",
      sourceId: "task-1",
    });
    await maybeAutoRespond("proj-1", notification);

    expect(mocks.mockInvokePlanningAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        role: "dreamer",
        tracking: expect.objectContaining({
          projectId: "proj-1",
          phase: "execute",
          role: "dreamer",
          label: "Open-question auto-response",
        }),
      })
    );
    expect(mocks.mockSendMessage).toHaveBeenCalledWith("proj-1", {
      message: "Use PostgreSQL for the backend.",
      context: "execute:task-1",
    });
    expect(mocks.mockResolve).toHaveBeenCalledWith("proj-1", notification.id);
    expect(mocks.mockTaskStoreUpdate).toHaveBeenCalledWith("proj-1", "task-1", {
      status: "open",
      block_reason: null,
    });
    expect(mocks.mockBroadcastToProject).toHaveBeenCalledWith("proj-1", {
      type: "notification.resolved",
      notificationId: notification.id,
      projectId: "proj-1",
      source: "execute",
      sourceId: "task-1",
    });
  });

  it("invokes Dreamer and applies answer for plan source when full autonomy", async () => {
    mocks.mockGetSettings.mockResolvedValue({ aiAutonomyLevel: "full" });
    mocks.mockGetPrd.mockResolvedValue({ sections: {} });
    mocks.mockInvokePlanningAgent.mockResolvedValue({ content: "Support both roles." });
    mocks.mockSendMessage.mockResolvedValue({ message: "OK" });
    mocks.mockResolve.mockResolvedValue({ status: "resolved" });

    const notification = openQuestionNotification({
      source: "plan",
      sourceId: "draft:draft-uuid-1",
    });
    await maybeAutoRespond("proj-1", notification);

    expect(mocks.mockSendMessage).toHaveBeenCalledWith("proj-1", {
      message: "Support both roles.",
      context: "plan-draft:draft-uuid-1",
    });
    expect(mocks.mockResolve).toHaveBeenCalledWith("proj-1", notification.id);
    expect(mocks.mockRecategorizeFeedback).not.toHaveBeenCalled();
  });

  it("invokes Dreamer and applies answer for eval source when full autonomy", async () => {
    mocks.mockGetSettings.mockResolvedValue({ aiAutonomyLevel: "full" });
    mocks.mockGetPrd.mockResolvedValue({ sections: {} });
    mocks.mockInvokePlanningAgent.mockResolvedValue({ content: "Treat as a bug in the form." });
    mocks.mockResolve.mockResolvedValue({ status: "resolved" });
    mocks.mockRecategorizeFeedback.mockResolvedValue({ id: "fb-1" });

    const notification = openQuestionNotification({
      source: "eval",
      sourceId: "fb-1",
    });
    await maybeAutoRespond("proj-1", notification);

    expect(mocks.mockResolve).toHaveBeenCalledWith("proj-1", notification.id);
    expect(mocks.mockRecategorizeFeedback).toHaveBeenCalledWith("proj-1", "fb-1", {
      answer: "Treat as a bug in the form.",
    });
    expect(mocks.mockSendMessage).not.toHaveBeenCalled();
  });

  it("invokes Dreamer and applies answer for prd source when full autonomy", async () => {
    mocks.mockGetSettings.mockResolvedValue({ aiAutonomyLevel: "full" });
    mocks.mockGetPrd.mockResolvedValue({ sections: {} });
    mocks.mockInvokePlanningAgent.mockResolvedValue({ content: "Target mobile-first users." });
    mocks.mockSendMessage.mockResolvedValue({ message: "OK" });
    mocks.mockResolve.mockResolvedValue({ status: "resolved" });

    const notification = openQuestionNotification({
      source: "prd",
      sourceId: "executive_summary",
    });
    await maybeAutoRespond("proj-1", notification);

    expect(mocks.mockSendMessage).toHaveBeenCalledWith("proj-1", {
      message: "Target mobile-first users.",
      context: "sketch",
    });
    expect(mocks.mockResolve).toHaveBeenCalledWith("proj-1", notification.id);
  });
});
