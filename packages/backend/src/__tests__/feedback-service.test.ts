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

const mockHilEvaluate = vi.fn().mockResolvedValue({ approved: false });
vi.mock("../services/hil-service.js", () => ({
  hilService: { evaluateDecision: (...args: unknown[]) => mockHilEvaluate(...args) },
}));

const mockSyncPrdFromScopeChange = vi.fn().mockResolvedValue(undefined);
const mockGetScopeChangeProposal = vi.fn().mockResolvedValue(null);
const mockApplyScopeChangeUpdates = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/chat.service.js", () => ({
  ChatService: vi.fn().mockImplementation(() => ({
    syncPrdFromScopeChangeFeedback: (...args: unknown[]) => mockSyncPrdFromScopeChange(...args),
    getScopeChangeProposal: (...args: unknown[]) => mockGetScopeChangeProposal(...args),
    applyScopeChangeUpdates: (...args: unknown[]) => mockApplyScopeChangeUpdates(...args),
  })),
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
  const id =
    beadsCreateCallCount === 1 ? "mock-feedback-source-1" : `mock-task-${beadsCreateCallCount - 1}`;
  return Promise.resolve({ id, title: "Mock", status: "open" });
});
const mockBeadsAddDependency = vi.fn().mockResolvedValue(undefined);

let feedbackIdSequence: string[] = [];
vi.mock("../utils/feedback-id.js", () => ({
  generateShortFeedbackId: () => feedbackIdSequence.shift() ?? "xyz123",
}));

const mockBeadsListAll = vi.fn().mockResolvedValue([]);
vi.mock("../services/beads.service.js", () => ({
  BeadsService: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    configSet: vi.fn().mockResolvedValue(undefined),
    create: (...args: unknown[]) => mockBeadsCreate(...args),
    addDependency: (...args: unknown[]) => mockBeadsAddDependency(...args),
    listAll: (...args: unknown[]) => mockBeadsListAll(...args),
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
    mockBeadsListAll.mockResolvedValue([]);
    feedbackIdSequence = [];
    mockHilEvaluate.mockResolvedValue({ approved: false });
    mockSyncPrdFromScopeChange.mockResolvedValue(undefined);
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
    await fs.writeFile(path.join(feedbackDir, "fb-1.json"), JSON.stringify(feedbackItem), "utf-8");

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
    await fs.writeFile(path.join(feedbackDir, "fb-2.json"), JSON.stringify(feedbackItem), "utf-8");

    const items = await feedbackService.listFeedback(projectId);

    expect(items).toHaveLength(1);
    expect(items[0].createdTaskIds).toEqual([]);
    expect(items[0].status).toBe("pending");
  });

  it("should create reply with parent_id and depth when parent exists", async () => {
    feedbackIdSequence = ["parent1", "child01"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mappedPlanId: null,
        task_titles: ["Fix reply"],
      }),
    });

    const parent = await feedbackService.submitFeedback(projectId, { text: "Original bug" });
    expect(parent.parent_id).toBeNull();
    expect(parent.depth).toBe(0);

    const reply = await feedbackService.submitFeedback(projectId, {
      text: "Same issue on mobile",
      parent_id: parent.id,
    });

    expect(reply.parent_id).toBe(parent.id);
    expect(reply.depth).toBe(1);
  });

  it("should throw 404 when parent_id references non-existent feedback", async () => {
    await expect(
      feedbackService.submitFeedback(projectId, {
        text: "Reply to missing parent",
        parent_id: "nonexistent",
      })
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "FEEDBACK_NOT_FOUND",
    });
  });

  it("should pass parent context to categorization agent for replies", async () => {
    feedbackIdSequence = ["parent2", "child02"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mappedPlanId: "auth-plan",
        task_titles: ["Fix on mobile too"],
      }),
    });

    const parent = await feedbackService.submitFeedback(projectId, {
      text: "Login broken on desktop",
    });

    await feedbackService.submitFeedback(projectId, {
      text: "Same on mobile",
      parent_id: parent.id,
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(mockInvoke).toHaveBeenCalledTimes(2);
    const replyPrompt = mockInvoke.mock.calls[1][0]?.prompt ?? "";
    expect(replyPrompt).toContain("Parent feedback (this is a reply)");
    expect(replyPrompt).toContain("Login broken on desktop");
    expect(replyPrompt).toContain("Parent category:");
    expect(replyPrompt).toContain("Same on mobile");
  });

  it("should assign short 6-char alphanumeric feedback IDs", async () => {
    feedbackIdSequence = ["a1b2c3"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mappedPlanId: null,
        task_titles: ["Fix something"],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Something broke",
    });

    expect(item.id).toMatch(/^[a-z0-9]{6}$/);
    expect(item.id).toHaveLength(6);
  });

  it("should retry with new ID on collision", async () => {
    const repoPath = path.join(tempDir, "my-project");
    const feedbackDir = path.join(repoPath, OPENSPRINT_PATHS.feedback);
    await fs.mkdir(feedbackDir, { recursive: true });
    const existingId = "aaaaaa";
    await fs.writeFile(
      path.join(feedbackDir, `${existingId}.json`),
      JSON.stringify({
        id: existingId,
        text: "Existing",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: [],
        status: "pending",
        createdAt: new Date().toISOString(),
      }),
      "utf-8"
    );

    feedbackIdSequence = [existingId, "bbbbbb"];
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "bug",
        mappedPlanId: null,
        task_titles: ["Fix collision"],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "New feedback",
    });

    expect(item.id).toBe("bbbbbb");
    const existing = await feedbackService.getFeedback(projectId, existingId);
    expect(existing.text).toBe("Existing");
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
    expect(updated.taskTitles).toEqual(["Add dark mode toggle", "Implement theme persistence"]);
    // BeadsService.create is mocked — feedback source bead + 2 task beads
    expect(updated.createdTaskIds).toEqual(["mock-task-1", "mock-task-2"]);
    expect(updated.feedbackSourceBeadId).toBe("mock-feedback-source-1");

    expect(mockInvoke).toHaveBeenCalledTimes(1);
    const prompt = mockInvoke.mock.calls[0][0]?.prompt ?? "";
    expect(prompt).toContain("# PRD");
    expect(prompt).toContain("# Plans");
    expect(prompt).toContain("Users want dark mode");
  });

  it("should parse full PRD 12.3.4 format: proposed_tasks, mapped_epic_id, is_scope_change", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mapped_plan_id: "auth-plan",
        mapped_epic_id: "bd-auth-123",
        is_scope_change: false,
        proposed_tasks: [
          {
            index: 0,
            title: "Add theme toggle",
            description: "Add dark/light toggle to settings",
            priority: 1,
            depends_on: [],
          },
          {
            index: 1,
            title: "Persist theme",
            description: "Save preference to localStorage",
            priority: 2,
            depends_on: [0],
          },
        ],
      }),
    });

    const item = await feedbackService.submitFeedback(projectId, {
      text: "Users want dark mode",
    });

    await new Promise((r) => setTimeout(r, 200));

    const updated = await feedbackService.getFeedback(projectId, item.id);
    expect(updated.category).toBe("feature");
    expect(updated.mappedPlanId).toBe("auth-plan");
    expect(updated.mappedEpicId).toBe("bd-auth-123");
    expect(updated.isScopeChange).toBe(false);
    expect(updated.proposedTasks).toHaveLength(2);
    expect(updated.proposedTasks![0]).toMatchObject({
      index: 0,
      title: "Add theme toggle",
      description: "Add dark/light toggle to settings",
      priority: 1,
      depends_on: [],
    });
    expect(updated.proposedTasks![1].depends_on).toEqual([0]);
    expect(updated.taskTitles).toEqual(["Add theme toggle", "Persist theme"]);

    // Beads create should be called with description and priority for proposed_tasks
    const taskCreateCalls = mockBeadsCreate.mock.calls.filter((c) => c[2]?.type === "feature");
    expect(taskCreateCalls).toHaveLength(2);
    expect(taskCreateCalls[0][2]).toMatchObject({
      type: "feature",
      priority: 1,
      description: "Add dark/light toggle to settings",
    });
    expect(taskCreateCalls[1][2]).toMatchObject({
      type: "feature",
      priority: 2,
      description: "Save preference to localStorage",
    });

    // Inter-task blocks dependency (task 1 depends_on task 0) + 2 discovered-from
    expect(mockBeadsAddDependency).toHaveBeenCalledTimes(3);
  });

  it("should trigger HIL when is_scope_change is true even if category is not scope", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        category: "feature",
        mapped_plan_id: null,
        mapped_epic_id: null,
        is_scope_change: true,
        proposed_tasks: [
          {
            index: 0,
            title: "Add mobile platform",
            description: "...",
            priority: 1,
            depends_on: [],
          },
        ],
      }),
    });

    await feedbackService.submitFeedback(projectId, {
      text: "We need a native mobile app",
    });

    await new Promise((r) => setTimeout(r, 200));

    expect(mockGetScopeChangeProposal).toHaveBeenCalledWith(
      projectId,
      "We need a native mobile app"
    );
    expect(mockHilEvaluate).toHaveBeenCalledTimes(1);
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
      "discovered-from"
    );
    expect(mockBeadsAddDependency).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      "mock-task-2",
      "mock-feedback-source-1",
      "discovered-from"
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

    const base64Image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
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

  describe("Scope change feedback (category=scope) with HIL", () => {
    it("should call getScopeChangeProposal and HIL evaluateDecision when category is scope", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          category: "scope",
          mappedPlanId: null,
          task_titles: ["Update PRD for new requirements"],
        }),
      });

      await feedbackService.submitFeedback(projectId, {
        text: "We need to add a mobile app as a new platform",
      });

      await new Promise((r) => setTimeout(r, 200));

      expect(mockGetScopeChangeProposal).toHaveBeenCalledWith(
        projectId,
        "We need to add a mobile app as a new platform"
      );
      expect(mockHilEvaluate).toHaveBeenCalledTimes(1);
      const hilCall = mockHilEvaluate.mock.calls[0];
      expect(hilCall[0]).toBe(projectId);
      expect(hilCall[1]).toBe("scopeChanges");
      expect(hilCall[2]).toContain(
        "A user submitted feedback that was categorized as a scope change"
      );
      expect(hilCall[2]).toContain(
        "Please review the proposed PRD updates below and approve or reject"
      );
      expect(hilCall[2]).toContain("We need to add a mobile app as a new platform");
      expect(hilCall[3]).toHaveLength(2);
      expect(hilCall[3][0]).toMatchObject({
        id: "approve",
        label: "Approve",
        description: "Apply the proposed PRD updates",
      });
      expect(hilCall[3][1]).toMatchObject({
        id: "reject",
        label: "Reject",
        description: "Skip updates and do not modify the PRD",
      });
    });

    it("should pass scopeChangeMetadata to HIL when getScopeChangeProposal returns proposal", async () => {
      const proposal = {
        summary: "• feature_list: Add mobile app",
        prdUpdates: [
          { section: "feature_list", content: "New content", changeLogEntry: "Add mobile app" },
        ],
      };
      mockGetScopeChangeProposal.mockResolvedValue(proposal);
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          category: "scope",
          mappedPlanId: null,
          task_titles: ["Update PRD"],
        }),
      });
      mockHilEvaluate.mockResolvedValue({ approved: true });

      await feedbackService.submitFeedback(projectId, {
        text: "Add mobile app",
      });

      await new Promise((r) => setTimeout(r, 200));

      expect(mockHilEvaluate).toHaveBeenCalledWith(
        projectId,
        "scopeChanges",
        expect.stringContaining("Add mobile app"),
        expect.arrayContaining([
          expect.objectContaining({ id: "approve", label: "Approve" }),
          expect.objectContaining({ id: "reject", label: "Reject" }),
        ]),
        true,
        {
          scopeChangeSummary: "• feature_list: Add mobile app",
          scopeChangeProposedUpdates: [
            { section: "feature_list", changeLogEntry: "Add mobile app" },
          ],
        }
      );
      expect(mockApplyScopeChangeUpdates).toHaveBeenCalledWith(
        projectId,
        proposal.prdUpdates,
        expect.stringContaining("Add mobile app")
      );
    });

    it("should not call syncPrdFromScopeChangeFeedback when HIL rejects", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          category: "scope",
          mappedPlanId: null,
          task_titles: ["Update PRD"],
        }),
      });
      mockHilEvaluate.mockResolvedValue({ approved: false });

      await feedbackService.submitFeedback(projectId, {
        text: "Add mobile support - fundamental scope change",
      });

      await new Promise((r) => setTimeout(r, 200));

      expect(mockSyncPrdFromScopeChange).not.toHaveBeenCalled();
      expect(mockBeadsCreate).not.toHaveBeenCalled();
    });

    it("should truncate long feedback in scope change HIL description", async () => {
      const longFeedback = "A".repeat(250);
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          category: "scope",
          mappedPlanId: null,
          task_titles: ["Update PRD"],
        }),
      });

      await feedbackService.submitFeedback(projectId, { text: longFeedback });

      await new Promise((r) => setTimeout(r, 200));

      const hilDesc = mockHilEvaluate.mock.calls[0][2];
      expect(hilDesc).toContain("A".repeat(200) + "…");
      expect(hilDesc).not.toContain("A".repeat(250));
    });

    it("should call syncPrdFromScopeChangeFeedback and create bead tasks when HIL approves", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          category: "scope",
          mappedPlanId: null,
          task_titles: ["Update PRD for mobile platform", "Add mobile architecture section"],
        }),
      });
      mockHilEvaluate.mockResolvedValue({ approved: true });

      await feedbackService.submitFeedback(projectId, {
        text: "Add mobile app as a new platform - scope change",
      });

      await new Promise((r) => setTimeout(r, 200));

      expect(mockSyncPrdFromScopeChange).toHaveBeenCalledTimes(1);
      expect(mockSyncPrdFromScopeChange).toHaveBeenCalledWith(
        projectId,
        "Add mobile app as a new platform - scope change"
      );
      expect(mockBeadsCreate).toHaveBeenCalled();
    });
  });

  describe("Evaluate phase agent registry", () => {
    it("should register and unregister Feedback categorization agent on success", async () => {
      mockInvoke.mockResolvedValue({
        content: JSON.stringify({
          category: "feature",
          mappedPlanId: null,
          task_titles: ["Add feature"],
        }),
      });

      await feedbackService.submitFeedback(projectId, { text: "Add feature" });
      await new Promise((r) => setTimeout(r, 200));

      expect(mockRegister).toHaveBeenCalledTimes(1);
      expect(mockRegister).toHaveBeenCalledWith(
        expect.stringMatching(/^feedback-categorize-.*-/),
        projectId,
        "eval",
        "analyst",
        "Feedback categorization",
        expect.any(String)
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

  describe("checkAutoResolveOnTaskDone (PRD §10.2)", () => {
    it("should auto-resolve feedback when all created tasks are closed and setting enabled", async () => {
      const settingsPath = path.join(tempDir, "my-project", OPENSPRINT_PATHS.settings);
      const settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
      settings.deployment.autoResolveFeedbackOnTaskCompletion = true;
      await fs.writeFile(settingsPath, JSON.stringify(settings), "utf-8");

      const feedbackDir = path.join(tempDir, "my-project", OPENSPRINT_PATHS.feedback);
      await fs.mkdir(feedbackDir, { recursive: true });
      const feedbackItem = {
        id: "fb-auto-1",
        text: "Bug in login",
        category: "bug",
        mappedPlanId: "plan-1",
        createdTaskIds: ["task-1", "task-2"],
        status: "mapped",
        createdAt: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(feedbackDir, "fb-auto-1.json"),
        JSON.stringify(feedbackItem),
        "utf-8"
      );

      mockBeadsListAll.mockResolvedValue([
        { id: "task-1", status: "closed" },
        { id: "task-2", status: "closed" },
      ]);

      await feedbackService.checkAutoResolveOnTaskDone(projectId, "task-1");

      const stored = await feedbackService.getFeedback(projectId, "fb-auto-1");
      expect(stored.status).toBe("resolved");
    });

    it("should not resolve when autoResolveFeedbackOnTaskCompletion is false", async () => {
      const feedbackDir = path.join(tempDir, "my-project", OPENSPRINT_PATHS.feedback);
      await fs.mkdir(feedbackDir, { recursive: true });
      const feedbackItem = {
        id: "fb-auto-2",
        text: "Bug",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: ["task-1"],
        status: "mapped",
        createdAt: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(feedbackDir, "fb-auto-2.json"),
        JSON.stringify(feedbackItem),
        "utf-8"
      );

      mockBeadsListAll.mockResolvedValue([{ id: "task-1", status: "closed" }]);

      await feedbackService.checkAutoResolveOnTaskDone(projectId, "task-1");

      const stored = await feedbackService.getFeedback(projectId, "fb-auto-2");
      expect(stored.status).toBe("mapped");
    });

    it("should not resolve when not all created tasks are closed", async () => {
      const settingsPath = path.join(tempDir, "my-project", OPENSPRINT_PATHS.settings);
      const settings = JSON.parse(await fs.readFile(settingsPath, "utf-8"));
      settings.deployment.autoResolveFeedbackOnTaskCompletion = true;
      await fs.writeFile(settingsPath, JSON.stringify(settings), "utf-8");

      const feedbackDir = path.join(tempDir, "my-project", OPENSPRINT_PATHS.feedback);
      await fs.mkdir(feedbackDir, { recursive: true });
      const feedbackItem = {
        id: "fb-auto-3",
        text: "Bug",
        category: "bug",
        mappedPlanId: null,
        createdTaskIds: ["task-1", "task-2"],
        status: "mapped",
        createdAt: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(feedbackDir, "fb-auto-3.json"),
        JSON.stringify(feedbackItem),
        "utf-8"
      );

      mockBeadsListAll.mockResolvedValue([
        { id: "task-1", status: "closed" },
        { id: "task-2", status: "open" },
      ]);

      await feedbackService.checkAutoResolveOnTaskDone(projectId, "task-1");

      const stored = await feedbackService.getFeedback(projectId, "fb-auto-3");
      expect(stored.status).toBe("mapped");
    });
  });
});
