import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { FeedbackService } from "../services/feedback.service.js";
import { ProjectService } from "../services/project.service.js";
import { DEFAULT_HIL_CONFIG, OPENSPRINT_PATHS } from "@opensprint/shared";

const mockInvoke = vi.fn();
vi.mock("../services/agent-client.js", () => ({
  AgentClient: vi.fn().mockImplementation(() => ({
    invoke: (opts: { prompt?: string }) => mockInvoke(opts),
  })),
}));

vi.mock("../services/hil-service.js", () => ({
  hilService: { evaluateDecision: vi.fn().mockResolvedValue({ approved: false }) },
}));

const mockRegister = vi.fn();
const mockUnregister = vi.fn();
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

let beadsCreateCallCount = 0;
const mockBeadsCreate = vi.fn().mockImplementation(() => {
  beadsCreateCallCount += 1;
  // First call: feedback source bead; subsequent: task beads
  const id = beadsCreateCallCount === 1 ? "mock-feedback-source-1" : `mock-task-${beadsCreateCallCount - 1}`;
  return Promise.resolve({ id, title: "Mock", status: "open" });
});
const mockBeadsAddDependency = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/beads.service.js", () => ({
  BeadsService: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    create: (...args: unknown[]) => mockBeadsCreate(...args),
    addDependency: (...args: unknown[]) => mockBeadsAddDependency(...args),
    listAll: vi.fn().mockResolvedValue([]),
    list: vi.fn().mockResolvedValue([]),
    ready: vi.fn().mockResolvedValue([]),
    show: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    close: vi.fn().mockResolvedValue({}),
    sync: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe("FeedbackService", () => {
  let feedbackService: FeedbackService;
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    beadsCreateCallCount = 0;
    feedbackService = new FeedbackService();
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-feedback-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    const project = await projectService.createProject({
      name: "Test Project",
      description: "A test project",
      repoPath: path.join(tempDir, "my-project"),
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

  it("should list feedback items with createdTaskIds for Build tab navigation", async () => {
    const repoPath = path.join(tempDir, "my-project");
    const feedbackDir = path.join(repoPath, OPENSPRINT_PATHS.feedback);
    await fs.mkdir(feedbackDir, { recursive: true });

    const feedbackItem = {
      id: "fb-1",
      text: "Login button doesn't work",
      category: "bug",
      mappedPlanId: "auth-plan",
      createdTaskIds: ["bd-a3f8.5", "bd-a3f8.6"],
      status: "mapped",
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(feedbackDir, "fb-1.json"),
      JSON.stringify(feedbackItem),
      "utf-8",
    );

    const items = await feedbackService.listFeedback(projectId);

    expect(items).toHaveLength(1);
    expect(items[0].createdTaskIds).toEqual(["bd-a3f8.5", "bd-a3f8.6"]);
    expect(items[0].mappedPlanId).toBe("auth-plan");
    expect(items[0].id).toBe("fb-1");
  });

  it("should return empty createdTaskIds for pending feedback", async () => {
    const repoPath = path.join(tempDir, "my-project");
    const feedbackDir = path.join(repoPath, OPENSPRINT_PATHS.feedback);
    await fs.mkdir(feedbackDir, { recursive: true });

    const feedbackItem = {
      id: "fb-2",
      text: "Add dark mode",
      category: "feature",
      mappedPlanId: null,
      createdTaskIds: [],
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(feedbackDir, "fb-2.json"),
      JSON.stringify(feedbackItem),
      "utf-8",
    );

    const items = await feedbackService.listFeedback(projectId);

    expect(items).toHaveLength(1);
    expect(items[0].createdTaskIds).toEqual([]);
    expect(items[0].status).toBe("pending");
  });

  it("should categorize feedback via planning agent with PRD and plans context", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mappedPlanId: "auth-plan",
        task_titles: ["Add dark mode toggle", "Implement theme persistence"],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Users want dark mode",
    });

    expect(item.status).toBe("pending");
    expect(item.id).toBeDefined();

    // Wait for async categorization + task creation
    await new Promise((r) => setTimeout(r, 200));

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.status).toBe("mapped");
    expect(updated.category).toBe("feature");
    expect(updated.mappedPlanId).toBe("auth-plan");
    expect(updated.taskTitles).toEqual([
      "Add dark mode toggle",
      "Implement theme persistence",
    ]);
    // BeadsService.create is mocked — feedback source bead + 2 task beads
    expect(updated.createdTaskIds).toEqual(["mock-task-1", "mock-task-2"]);
    expect(updated.feedbackSourceBeadId).toBe("mock-feedback-source-1");

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const prompt = mockInvoke.mock.calls[0][0]?.prompt ?? "";
    expect(prompt).toContain("# PRD");
    expect(prompt).toContain("# Plans");
    expect(prompt).toContain("Users want dark mode");
  });

  it("should support legacy suggestedTitle when task_titles is missing", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mappedPlanId: null,
        suggestedTitle: "Fix login button",
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Login button broken",
    });

    await new Promise((r) => setTimeout(r, 200));

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.category).toBe("bug");
    expect(updated.taskTitles).toEqual(["Fix login button"]);
  });

  it("should fallback to bug and first plan when agent returns invalid JSON", async () => {
    mockInvoke.mockResolvedValue({ content: "This is not valid JSON at all" });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Something broke",
    });

    await new Promise((r) => setTimeout(r, 200));

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.status).toBe("mapped");
    expect(updated.category).toBe("bug");
    expect(updated.taskTitles).toEqual(["Something broke"]);
  });

  it("should fallback to bug when agent throws", async () => {
    mockInvoke.mockRejectedValue(new Error("Agent timeout"));

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Random feedback",
    });

    await new Promise((r) => setTimeout(r, 200));

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.status).toBe("mapped");
    expect(updated.category).toBe("bug");
    expect(updated.taskTitles).toEqual(["Random feedback"]);
  });

  it("should create bug-type bead when category is bug", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mappedPlanId: null,
        task_titles: ["Fix login button"],
      }),
    });

    await feedbackService.submitFeedback(projectId, { text: "Login broken" });
    await new Promise((r) => setTimeout(r, 200));

    const createCalls = mockBeadsCreate.mock.calls;
    const bugCreateCall = createCalls.find((c) => c[2]?.type === "bug");
    expect(bugCreateCall).toBeDefined();
    expect(bugCreateCall![2]).toMatchObject({ type: "bug" });
  });

  it("should create feature-type bead when category is feature", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mappedPlanId: null,
        task_titles: ["Add dark mode"],
      }),
    });

    await feedbackService.submitFeedback(projectId, { text: "Need dark mode" });
    await new Promise((r) => setTimeout(r, 200));

    const createCalls = mockBeadsCreate.mock.calls;
    // First call: feedback source (chore); second: task
    const taskCreateCall = createCalls.find((c) => c[2]?.type === "feature");
    expect(taskCreateCall).toBeDefined();
    expect(taskCreateCall![2]).toMatchObject({ type: "feature" });
  });

  it("should add discovered-from dependency from each task to feedback source bead", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mappedPlanId: null,
        task_titles: ["Task A", "Task B"],
      }),
    });

    await feedbackService.submitFeedback(projectId, { text: "Add feature" });
    await new Promise((r) => setTimeout(r, 200));

    expect(mockBeadsAddDependency).toHaveBeenCalledTimes(2);
    expect(mockBeadsAddDependency).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      "mock-task-1",
      "mock-feedback-source-1",
      "discovered-from",
    );
    expect(mockBeadsAddDependency).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      "mock-task-2",
      "mock-feedback-source-1",
      "discovered-from",
    );
  });

  it("should store image attachments when provided", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mappedPlanId: null,
        task_titles: ["Fix screenshot bug"],
      }),
    });

    const base64Image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const item = await feedbackService.submitFeedback(projectId, {
      text: "Bug with screenshot",
      images: [`data:image/png;base64,${base64Image}`],
    });

    expect(item.id).toBeDefined();
    expect(item.text).toBe("Bug with screenshot");

    const stored = await feedbackService.getFeedback(projectId, item.id);
    expect(stored.images).toBeDefined();
    expect(stored.images).toHaveLength(1);
    expect(stored.images![0]).toContain("data:image/png;base64,");
  });

  it("should create feedback source bead (chore) for provenance", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "ux",
        mappedPlanId: null,
        task_titles: ["Improve button layout"],
      }),
    });

    await feedbackService.submitFeedback(projectId, { text: "Buttons are cramped" });
    await new Promise((r) => setTimeout(r, 200));

    const createCalls = mockBeadsCreate.mock.calls;
    const feedbackSourceCall = createCalls[0];
    expect(feedbackSourceCall[1]).toMatch(/^Feedback: /);
    expect(feedbackSourceCall[2]).toMatchObject({ type: "chore", priority: 4 });
  });

  describe("Validate phase agent registry", () => {
    it("should register and unregister Feedback categorization agent on success", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          category: "feature",
          mappedPlanId: null,
          task_titles: ["Add feature"],
        }),
      });

      const item = await feedbackService.submitFeedback(projectId, { text: "Add feature" });
      await new Promise((r) => setTimeout(r, 200));

      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockRegister).toHaveBeenCalledWith(
        expect.stringMatching(/^feedback-categorize-.*-/),
        projectId,
        "validate",
        "Feedback categorization",
        expect.any(String),
      );
      expect(mockUnregister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledWith(mockRegister.mock.calls[0][0]);
    });

    it("should unregister even when agent invocation throws", async () => {
      mockInvoke.mockRejectedValue(new Error("Agent timeout"));

      await feedbackService.submitFeedback(projectId, { text: "Random feedback" });
      await new Promise((r) => setTimeout(r, 200));

      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledWith(mockRegister.mock.calls[0][0]);
    });
  });
});
