import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SelfImprovementRunnerService,
  parseImprovementList,
  capAndDedupeImprovementItems,
  enrichPriorityAndComplexity,
  runSelfImprovement,
  isSelfImprovementRunInProgress,
  getSelfImprovementStatus,
  getSelfImprovementRunMode,
  getSelfImprovementRunState,
  setSelfImprovementRunInProgressForTest,
} from "../services/self-improvement-runner.service.js";
import { governanceService } from "../services/governance.service.js";
import { evaluatePolicyProposal } from "../services/policy-evaluation.service.js";
vi.mock("../services/governance.service.js", () => ({
  governanceService: {
    getConfig: vi.fn().mockResolvedValue({ mode: "disabled" }),
    listProposals: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("../services/congress.service.js", () => ({
  runGovernanceCongress: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/policy-evaluation.service.js", () => ({ evaluatePolicyProposal: vi.fn() }));

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    create: vi.fn().mockResolvedValue({ id: "os-1", title: "Task" }),
    listAll: vi.fn().mockResolvedValue([]),
    getDb: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue([]),
    }),
    insertSelfImprovementRunHistory: vi.fn().mockResolvedValue({
      id: 1,
      projectId: "proj-1",
      runId: "si-1",
      timestamp: new Date().toISOString(),
      status: "success",
      tasksCreatedCount: 0,
      mode: "audit_only",
      outcome: "no_changes",
      summary: "Audit completed; no new improvement tasks.",
    }),
    runWrite: vi
      .fn()
      .mockImplementation(
        async (fn: (client: { execute: () => Promise<void> }) => Promise<void>) => {
          await fn({ execute: vi.fn().mockResolvedValue(undefined) });
        }
      ),
  },
}));

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: vi.fn(),
  },
}));

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getProject: vi.fn().mockResolvedValue({ id: "proj-1", repoPath: "/tmp/repo" }),
    getSettings: vi.fn().mockResolvedValue({
      simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
      reviewAngles: undefined as string[] | undefined,
    }),
  })),
}));

vi.mock("../services/plan.service.js", () => ({
  PlanService: vi.fn().mockImplementation(() => ({
    getCodebaseContext: vi.fn().mockResolvedValue({
      fileTree: "src/\n  index.ts\n",
      keyFilesContent: "// key files",
    }),
  })),
}));

vi.mock("../services/context-assembler.js", () => ({
  ContextAssembler: vi.fn().mockImplementation(() => ({
    extractPrdExcerpt: vi.fn().mockResolvedValue("# SPEC\n\nContent"),
  })),
}));

vi.mock("../services/settings-store.service.js", () => ({
  updateSettingsInStore: vi.fn().mockResolvedValue(undefined),
  getSettingsFromStore: vi
    .fn()
    .mockImplementation((_id: string, defaults: unknown) => Promise.resolve(defaults)),
}));

vi.mock("../services/agent-instructions.service.js", () => ({
  getCombinedInstructions: vi.fn().mockResolvedValue(""),
  agentInstructionsService: {
    getGeneralInstructions: vi.fn().mockResolvedValue(""),
    getRoleInstructions: vi.fn().mockResolvedValue(""),
  },
}));

vi.mock("../utils/shell-exec.js", () => ({
  shellExec: vi.fn().mockResolvedValue({ stdout: "abc123sha\n", stderr: "" }),
}));

vi.mock("../services/notification.service.js", () => ({
  notificationService: {
    createAgentFailed: vi.fn().mockResolvedValue({
      id: "af-1",
      projectId: "proj-1",
      source: "execute",
      sourceId: "self-improvement-si-1",
      questions: [{ id: "q-1", text: "Self-improvement run had failure(s)" }],
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      kind: "agent_failed",
    }),
  },
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: vi.fn(),
}));

vi.mock("../services/behavior-version-store.service.js", () => ({
  runBehaviorVersionStoreWrite: vi
    .fn()
    .mockImplementation(
      async (fn: (store: { promoteToActive: () => Promise<void> }) => Promise<void>) => {
        await fn({ promoteToActive: vi.fn().mockResolvedValue(undefined) });
      }
    ),
}));

vi.mock("../services/self-improvement-failure-collector.service.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../services/self-improvement-failure-collector.service.js")
    >();
  return {
    ...actual,
    collectFailuresSince: vi.fn().mockResolvedValue([]),
  };
});

describe("getSelfImprovementStatus", () => {
  afterEach(() => {
    setSelfImprovementRunInProgressForTest("test-proj", false);
  });

  it("returns idle when no run in progress and no pending candidate", () => {
    const snapshot = getSelfImprovementStatus("test-proj", {});
    expect(snapshot).toEqual({ status: "idle" });
  });

  it("returns awaiting_approval when settings have a pending candidate", () => {
    const snapshot = getSelfImprovementStatus("test-proj", {
      selfImprovementPendingCandidateId: "bv-cand-1",
    });
    expect(snapshot.status).toBe("awaiting_approval");
    expect(snapshot.pendingCandidateId).toBe("bv-cand-1");
    expect(snapshot.summary).toBeDefined();
  });

  it("returns running_audit when audit run is in progress", () => {
    setSelfImprovementRunInProgressForTest("test-proj", {
      status: "running_audit",
    });
    const snapshot = getSelfImprovementStatus("test-proj");
    expect(snapshot.status).toBe("running_audit");
    expect(snapshot.stage).toBeUndefined();
  });

  it("returns running_experiments with stage when experiment run is active", () => {
    setSelfImprovementRunInProgressForTest("test-proj", {
      status: "running_experiments",
      stage: "generating_candidate",
    });
    const snapshot = getSelfImprovementStatus("test-proj");
    expect(snapshot.status).toBe("running_experiments");
    expect(snapshot.stage).toBe("generating_candidate");
  });

  it("in-progress state takes precedence over settings pending candidate", () => {
    setSelfImprovementRunInProgressForTest("test-proj", {
      status: "running_audit",
    });
    const snapshot = getSelfImprovementStatus("test-proj", {
      selfImprovementPendingCandidateId: "bv-cand-1",
    });
    expect(snapshot.status).toBe("running_audit");
  });

  it("setSelfImprovementRunInProgressForTest with true sets running_audit default", () => {
    setSelfImprovementRunInProgressForTest("test-proj", true);
    expect(isSelfImprovementRunInProgress("test-proj")).toBe(true);
    const snapshot = getSelfImprovementStatus("test-proj");
    expect(snapshot.status).toBe("running_audit");
  });

  it("setSelfImprovementRunInProgressForTest with false clears state", () => {
    setSelfImprovementRunInProgressForTest("test-proj", true);
    setSelfImprovementRunInProgressForTest("test-proj", false);
    expect(isSelfImprovementRunInProgress("test-proj")).toBe(false);
    const snapshot = getSelfImprovementStatus("test-proj");
    expect(snapshot.status).toBe("idle");
  });
});

describe("getSelfImprovementRunMode", () => {
  afterEach(() => {
    setSelfImprovementRunInProgressForTest("test-proj", false);
  });

  it("returns undefined when no run is in progress", () => {
    expect(getSelfImprovementRunMode("test-proj")).toBeUndefined();
  });

  it("returns 'audit' when status is running_audit", () => {
    setSelfImprovementRunInProgressForTest("test-proj", { status: "running_audit" });
    expect(getSelfImprovementRunMode("test-proj")).toBe("audit");
  });

  it("returns 'experiments' when status is running_experiments", () => {
    setSelfImprovementRunInProgressForTest("test-proj", {
      status: "running_experiments",
      stage: "collecting_replay_cases",
    });
    expect(getSelfImprovementRunMode("test-proj")).toBe("experiments");
  });

  it("returns undefined when status is awaiting_approval (not actively running)", () => {
    setSelfImprovementRunInProgressForTest("test-proj", {
      status: "awaiting_approval",
      pendingCandidateId: "bv-1",
    });
    expect(getSelfImprovementRunMode("test-proj")).toBeUndefined();
  });
});

describe("parseImprovementList", () => {
  it("parses JSON array into improvement items", () => {
    const json = `[{"title":"Add tests","description":"Unit tests for X","priority":1},{"title":"Refactor Y"}]`;
    const items = parseImprovementList(json);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ title: "Add tests", description: "Unit tests for X", priority: 1 });
    expect(items[1]).toEqual({ title: "Refactor Y", description: undefined, priority: undefined });
  });

  it("parses complexity from JSON array (1-10, assigned by AI)", () => {
    const json = `[{"title":"Add tests","priority":0,"complexity":3},{"title":"Refactor API","complexity":7}]`;
    const items = parseImprovementList(json);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ title: "Add tests", priority: 0, complexity: 3 });
    expect(items[1]).toEqual({ title: "Refactor API", complexity: 7 });
  });

  it("drops invalid complexity (out of range or non-integer)", () => {
    const json = `[{"title":"A","complexity":0},{"title":"B","complexity":11},{"title":"C","complexity":5.5}]`;
    const items = parseImprovementList(json);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ title: "A" });
    expect(items[1]).toEqual({ title: "B" });
    expect(items[2]).toEqual({ title: "C" });
  });

  it("parses object with items array", () => {
    const json = `{"items":[{"title":"One"},{"title":"Two","description":"D2"}]}`;
    const items = parseImprovementList(json);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ title: "One" });
    expect(items[1]).toEqual({ title: "Two", description: "D2" });
  });

  it("returns one fallback task on parse failure", () => {
    const items = parseImprovementList("not json or list");
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe(
      "Self-improvement review failed to parse — please review agent output"
    );
    expect(items[0]!.description).toBeDefined();
  });

  it("returns empty array when JSON array is empty", () => {
    const items = parseImprovementList("[]");
    expect(items).toHaveLength(0);
  });

  it("returns fallback for empty content", () => {
    const items = parseImprovementList("");
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe(
      "Self-improvement review failed to parse — please review agent output"
    );
  });

  it("parses markdown list with bold title and em-dash description", () => {
    const input = "- **Title one** — optional desc\n- Title two: desc";
    const items = parseImprovementList(input);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ title: "Title one", description: "optional desc" });
    expect(items[1]).toEqual({ title: "Title two", description: "desc" });
  });

  it("parses JSON array embedded in text (extractJsonArrayFromAgentResponse)", () => {
    const input = `Here are the improvement tasks:
[{"title":"Add unit tests","description":"Cover API layer","priority":1,"complexity":3},{"title":"Refactor auth","priority":0,"complexity":6}]`;
    const items = parseImprovementList(input);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: "Add unit tests",
      description: "Cover API layer",
      priority: 1,
      complexity: 3,
    });
    expect(items[1]).toEqual({ title: "Refactor auth", priority: 0, complexity: 6 });
  });
});

describe("enrichPriorityAndComplexity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("always calls agent to assign priority and complexity (AI-assigned for all items)", async () => {
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: JSON.stringify([
        { title: "A", priority: 1, complexity: 3 },
        { title: "B", priority: 2, complexity: 5 },
      ]),
    } as never);

    const items = [
      { title: "A", priority: 1, complexity: 3 },
      { title: "B", priority: 2, complexity: 5 },
    ];
    const result = await enrichPriorityAndComplexity("proj-1", items, {
      repoPath: "/tmp/repo",
      settings: {} as never,
      runId: "r1",
    });
    expect(agentService.invokePlanningAgent).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ title: "A", priority: 1, complexity: 3 });
    expect(result[1]).toMatchObject({ title: "B", priority: 2, complexity: 5 });
  });

  it("calls agent and merges priority/complexity when items lack them", async () => {
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: JSON.stringify([
        { title: "Add tests", priority: 1, complexity: 3 },
        { title: "Refactor API", priority: 0, complexity: 7 },
      ]),
    } as never);

    const items: Array<{
      title: string;
      description?: string;
      priority?: number;
      complexity?: number;
    }> = [{ title: "Add tests", description: "Unit tests" }, { title: "Refactor API" }];
    const result = await enrichPriorityAndComplexity("proj-1", items, {
      repoPath: "/tmp/repo",
      settings: {} as never,
      runId: "r1",
    });

    expect(agentService.invokePlanningAgent).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ title: "Add tests", priority: 1, complexity: 3 });
    expect(result[1]).toMatchObject({ title: "Refactor API", priority: 0, complexity: 7 });
  });

  it("uses defaults when enrichment agent returns invalid or partial response", async () => {
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: '[{"title":"Add tests"}]', // no priority/complexity in response
    } as never);

    const items = [{ title: "Add tests", description: "Unit tests" }];
    const result = await enrichPriorityAndComplexity("proj-1", items, {
      repoPath: "/tmp/repo",
      settings: {} as never,
      runId: "r1",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: "Add tests", priority: 2, complexity: 5 });
  });

  it("parses enrichment response with leading text (extractJsonArrayFromAgentResponse)", async () => {
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: `Here are the items with priority and complexity:
[{"title":"Add tests","priority":1,"complexity":3},{"title":"Refactor API","priority":0,"complexity":7}]`,
    } as never);

    const items: Array<{
      title: string;
      description?: string;
      priority?: number;
      complexity?: number;
    }> = [
      { title: "Add tests", description: "Unit tests" },
      { title: "Refactor API", description: "API refactor" },
    ];
    const result = await enrichPriorityAndComplexity("proj-1", items, {
      repoPath: "/tmp/repo",
      settings: {} as never,
      runId: "r1",
    });

    expect(agentService.invokePlanningAgent).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ title: "Add tests", priority: 1, complexity: 3 });
    expect(result[1]).toMatchObject({ title: "Refactor API", priority: 0, complexity: 7 });
  });

  it("accepts partial agent response but sets _aiAssigned false when only one of priority/complexity from AI", async () => {
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: JSON.stringify([
        { title: "Add tests", priority: 1 }, // no complexity
        { title: "Refactor API", complexity: 7 }, // no priority
      ]),
    } as never);

    const items: Array<{
      title: string;
      description?: string;
      priority?: number;
      complexity?: number;
    }> = [
      { title: "Add tests", description: "Unit tests" },
      { title: "Refactor API", description: "API refactor" },
    ];
    const result = await enrichPriorityAndComplexity("proj-1", items, {
      repoPath: "/tmp/repo",
      settings: {} as never,
      runId: "r1",
    });

    expect(result).toHaveLength(2);
    // Add tests: AI priority 1, complexity from default (5) — _aiAssigned false (missing complexity)
    expect(result[0]).toMatchObject({
      title: "Add tests",
      priority: 1,
      complexity: 5,
      _aiAssigned: false,
    });
    // Refactor API: priority from default (2), AI complexity 7 — _aiAssigned false (missing priority)
    expect(result[1]).toMatchObject({
      title: "Refactor API",
      priority: 2,
      complexity: 7,
      _aiAssigned: false,
    });
  });

  it("retries enrichment when agent throws", async () => {
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent)
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce({
        content: JSON.stringify([{ title: "Add tests", priority: 1, complexity: 3 }]),
      } as never);

    const items = [{ title: "Add tests", description: "Unit tests" }];
    const result = await enrichPriorityAndComplexity("proj-1", items, {
      repoPath: "/tmp/repo",
      settings: {} as never,
      runId: "r1",
    });

    expect(agentService.invokePlanningAgent).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ title: "Add tests", priority: 1, complexity: 3 });
  });

  it("uses defaults when enrichment agent throws", async () => {
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockRejectedValue(new Error("timeout"));

    const items = [{ title: "Add tests" }];
    const result = await enrichPriorityAndComplexity("proj-1", items, {
      repoPath: "/tmp/repo",
      settings: {} as never,
      runId: "r1",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: "Add tests",
      priority: 2,
      complexity: 5,
      _aiAssigned: false,
    });
  });

  it("sets _aiAssigned true when enrichment throws but main agent provided both priority and complexity", async () => {
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockRejectedValue(new Error("timeout"));

    const items = [{ title: "Add tests", priority: 1, complexity: 3 }];
    const result = await enrichPriorityAndComplexity("proj-1", items, {
      repoPath: "/tmp/repo",
      settings: {} as never,
      runId: "r1",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: "Add tests",
      priority: 1,
      complexity: 3,
      _aiAssigned: true,
    });
  });

  it("sets _aiAssigned false when enrichment throws and main agent provided only one of priority/complexity", async () => {
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockRejectedValue(new Error("timeout"));

    const items = [{ title: "Add tests", priority: 1 }];
    const result = await enrichPriorityAndComplexity("proj-1", items, {
      repoPath: "/tmp/repo",
      settings: {} as never,
      runId: "r1",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      title: "Add tests",
      priority: 1,
      complexity: 5,
      _aiAssigned: false,
    });
  });

  it("matches enrichment response by case-insensitive title", async () => {
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: JSON.stringify([
        { title: "ADD TESTS", priority: 1, complexity: 3 },
        { title: "Refactor API", priority: 0, complexity: 7 },
      ]),
    } as never);

    const items: Array<{
      title: string;
      description?: string;
      priority?: number;
      complexity?: number;
    }> = [
      { title: "Add tests", description: "Unit tests" },
      { title: "Refactor API", description: "API refactor" },
    ];
    const result = await enrichPriorityAndComplexity("proj-1", items, {
      repoPath: "/tmp/repo",
      settings: {} as never,
      runId: "r1",
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ title: "Add tests", priority: 1, complexity: 3 });
    expect(result[1]).toMatchObject({ title: "Refactor API", priority: 0, complexity: 7 });
  });

  it("uses index-based fallback when title match fails but counts align (agent returns same order)", async () => {
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: JSON.stringify([
        { title: "Add unit tests", priority: 1, complexity: 3 },
        { title: "Refactor the API layer", priority: 0, complexity: 7 },
      ]),
    } as never);

    const items: Array<{
      title: string;
      description?: string;
      priority?: number;
      complexity?: number;
    }> = [
      { title: "Add tests", description: "Unit tests" },
      { title: "Refactor API", description: "API refactor" },
    ];
    const result = await enrichPriorityAndComplexity("proj-1", items, {
      repoPath: "/tmp/repo",
      settings: {} as never,
      runId: "r1",
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      title: "Add tests",
      priority: 1,
      complexity: 3,
      _aiAssigned: true,
    });
    expect(result[1]).toMatchObject({
      title: "Refactor API",
      priority: 0,
      complexity: 7,
      _aiAssigned: true,
    });
  });

  it("marks _aiAssigned true only when both priority and complexity come from AI (main or enrichment)", async () => {
    const { agentService } = await import("../services/agent.service.js");
    const items = [{ title: "Add tests", priority: 1, complexity: 3 }];
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: JSON.stringify([{ title: "Add tests", priority: 1, complexity: 3 }]),
    } as never);

    const result = await enrichPriorityAndComplexity("proj-1", items, {
      repoPath: "/tmp/repo",
      settings: {} as never,
      runId: "r1",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ _aiAssigned: true, priority: 1, complexity: 3 });
  });
});

describe("capAndDedupeImprovementItems", () => {
  it("returns items up to max, sorted by priority", () => {
    const items: Array<{ title: string; priority?: number }> = [
      { title: "Low", priority: 3 },
      { title: "High", priority: 0 },
      { title: "Mid", priority: 2 },
      { title: "Mid2", priority: 2 },
      { title: "High2", priority: 1 },
    ];
    const out = capAndDedupeImprovementItems(items, 3);
    expect(out).toHaveLength(3);
    expect(out[0]!.title).toBe("High");
    expect(out[1]!.title).toBe("High2");
    expect(out[2]!.title).toBe("Mid");
  });

  it("dedupes by normalized title (case-insensitive)", () => {
    const items = [
      { title: "Add tests" },
      { title: "  ADD TESTS  " },
      { title: "Add Tests", description: "second" },
    ];
    const out = capAndDedupeImprovementItems(items, 10);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("Add tests");
  });

  it("treats undefined priority as 2 for sort", () => {
    const items = [
      { title: "Task A", priority: 1 },
      { title: "Task B" },
      { title: "Task C", priority: 3 },
    ];
    const out = capAndDedupeImprovementItems(items, 10);
    expect(out.map((i) => i.title)).toEqual(["Task A", "Task B", "Task C"]);
  });

  it("filters out items with title shorter than MIN_IMPROVEMENT_TITLE_LENGTH (e.g. junk from agent output)", () => {
    const items = [
      { title: "th" },
      { title: "Add tests", description: "Unit tests" },
      { title: "e" },
      { title: "  ab  ", priority: 1 },
      { title: "Refactor API", priority: 0 },
    ];
    const out = capAndDedupeImprovementItems(items, 10);
    expect(out).toHaveLength(2);
    expect(out[0]!.title).toBe("Refactor API");
    expect(out[1]!.title).toBe("Add tests");
  });

  it("returns empty array when all items have too-short titles", () => {
    const items = [{ title: "a" }, { title: "b" }, { title: "th" }];
    const out = capAndDedupeImprovementItems(items, 10);
    expect(out).toHaveLength(0);
  });
});

describe("SelfImprovementRunnerService", () => {
  const projectId = "proj-1";

  beforeEach(async () => {
    vi.clearAllMocks();
    const { taskStore } = await import("../services/task-store.service.js");
    const { agentService } = await import("../services/agent.service.js");
    const { updateSettingsInStore } = await import("../services/settings-store.service.js");
    vi.mocked(taskStore.create).mockResolvedValue({ id: "os-1", title: "Task" } as never);
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content:
        '[{"title":"Improve error handling","description":"Add try/catch","priority":1,"complexity":3}]',
    } as never);
    vi.mocked(updateSettingsInStore).mockResolvedValue(undefined);
  });

  it("creates tasks with source and optional planId/runId", async () => {
    const service = new SelfImprovementRunnerService();
    const { taskStore } = await import("../services/task-store.service.js");

    const result = await service.runSelfImprovement(projectId, {
      planId: "plan-1",
      runId: "run-xyz",
    });

    expect(result).toMatchObject({ tasksCreated: 1, runId: "run-xyz" });
    expect(taskStore.create).toHaveBeenCalledWith(
      projectId,
      "Improve error handling",
      expect.objectContaining({
        description: "Add try/catch",
        extra: expect.objectContaining({
          source: "self-improvement",
          runId: "run-xyz",
          planId: "plan-1",
        }),
      })
    );
  });

  it("creates tasks with AI-assigned complexity and priority from enrichment agent", async () => {
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(agentService.invokePlanningAgent)
      .mockResolvedValueOnce({
        content: JSON.stringify([
          { title: "Add tests", description: "Unit tests", priority: 1, complexity: 3 },
          { title: "Refactor API", priority: 0, complexity: 7 },
        ]),
      } as never)
      .mockResolvedValueOnce({
        content: JSON.stringify([
          { title: "Add tests", priority: 1, complexity: 3 },
          { title: "Refactor API", priority: 0, complexity: 7 },
        ]),
      } as never);

    const service = new SelfImprovementRunnerService();
    const result = await service.runSelfImprovement(projectId);

    expect(result).toMatchObject({ tasksCreated: 2 });
    // Tasks are sorted by priority (lower first), so Refactor API (0) then Add tests (1)
    expect(taskStore.create).toHaveBeenNthCalledWith(
      1,
      projectId,
      "Refactor API",
      expect.objectContaining({
        priority: 0,
        complexity: 7,
        extra: expect.objectContaining({ source: "self-improvement" }),
      })
    );
    expect(taskStore.create).toHaveBeenNthCalledWith(
      2,
      projectId,
      "Add tests",
      expect.objectContaining({
        description: "Unit tests",
        priority: 1,
        complexity: 3,
        extra: expect.objectContaining({ source: "self-improvement" }),
      })
    );
  });

  it("calls enrichment agent when items lack priority/complexity and creates tasks with both", async () => {
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    // First call: review returns markdown-style items (no priority/complexity)
    vi.mocked(agentService.invokePlanningAgent)
      .mockResolvedValueOnce({
        content: "- **Add tests** — Unit tests\n- **Refactor API**",
      } as never)
      .mockResolvedValueOnce({
        content: JSON.stringify([
          { title: "Add tests", priority: 1, complexity: 3 },
          { title: "Refactor API", priority: 0, complexity: 7 },
        ]),
      } as never);

    const service = new SelfImprovementRunnerService();
    const result = await service.runSelfImprovement(projectId);

    expect(result).toMatchObject({ tasksCreated: 2 });
    expect(agentService.invokePlanningAgent).toHaveBeenCalledTimes(2);
    // Order preserved from parsed list (Add tests, Refactor API); both get AI-assigned priority and complexity
    expect(taskStore.create).toHaveBeenNthCalledWith(
      1,
      projectId,
      "Add tests",
      expect.objectContaining({
        priority: 1,
        complexity: 3,
        extra: expect.objectContaining({ source: "self-improvement" }),
      })
    );
    expect(taskStore.create).toHaveBeenNthCalledWith(
      2,
      projectId,
      "Refactor API",
      expect.objectContaining({
        priority: 0,
        complexity: 7,
        extra: expect.objectContaining({ source: "self-improvement" }),
      })
    );
  });

  it("never creates self-improvement tasks without AI-assigned priority and complexity", async () => {
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    // Main agent returns items with only priority (no complexity) - enrichment would be needed
    vi.mocked(agentService.invokePlanningAgent)
      .mockResolvedValueOnce({
        content: JSON.stringify([
          { title: "Add tests", priority: 1 },
          { title: "Refactor API", priority: 0 },
        ]),
      } as never)
      .mockResolvedValueOnce({
        content: '[{"title":"Add tests"}]', // enrichment returns invalid/partial - no priority/complexity
      } as never);

    const service = new SelfImprovementRunnerService();
    const result = await service.runSelfImprovement(projectId);

    expect(result).toMatchObject({ tasksCreated: 0 });
    expect(taskStore.create).not.toHaveBeenCalled();
  });

  it("ensures all created self-improvement tasks have AI-assigned priority and complexity", async () => {
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(agentService.invokePlanningAgent)
      .mockResolvedValueOnce({
        content: JSON.stringify([
          { title: "Add tests", description: "Unit tests", priority: 1, complexity: 3 },
          { title: "Refactor API", priority: 0, complexity: 7 },
        ]),
      } as never)
      .mockResolvedValueOnce({
        content: JSON.stringify([
          { title: "Add tests", priority: 1, complexity: 3 },
          { title: "Refactor API", priority: 0, complexity: 7 },
        ]),
      } as never);

    const service = new SelfImprovementRunnerService();
    await service.runSelfImprovement(projectId);

    expect(taskStore.create).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(taskStore.create).mock.calls) {
      const opts = call[2];
      expect(opts).toHaveProperty("priority");
      expect(opts).toHaveProperty("complexity");
      expect(typeof opts.priority).toBe("number");
      expect(typeof opts.complexity).toBe("number");
      expect(opts.priority).toBeGreaterThanOrEqual(0);
      expect(opts.priority).toBeLessThanOrEqual(4);
      expect(opts.complexity).toBeGreaterThanOrEqual(1);
      expect(opts.complexity).toBeLessThanOrEqual(10);
      // Self-improvement tasks must always have AI-assigned priority and complexity
      expect(opts.extra).toMatchObject({
        aiAssignedPriority: true,
        aiAssignedComplexity: true,
      });
    }
  });

  it("creates tasks with source and runId when planId omitted", async () => {
    const service = new SelfImprovementRunnerService();
    const { taskStore } = await import("../services/task-store.service.js");

    await service.runSelfImprovement(projectId);

    expect(taskStore.create).toHaveBeenCalledWith(
      projectId,
      expect.any(String),
      expect.objectContaining({
        extra: expect.objectContaining({
          source: "self-improvement",
          runId: expect.stringMatching(/^si-/),
        }),
      })
    );
    const extra = vi.mocked(taskStore.create).mock.calls[0]![2].extra as Record<string, unknown>;
    expect(extra.planId).toBeUndefined();
  });

  it("updates last run and optional lastCommitSha only on success", async () => {
    const { updateSettingsInStore } = await import("../services/settings-store.service.js");
    const service = new SelfImprovementRunnerService();

    await service.runSelfImprovement(projectId, { lastCommitSha: "sha-from-caller" });

    expect(updateSettingsInStore).toHaveBeenCalledWith(
      projectId,
      expect.anything(),
      expect.any(Function)
    );
    const updater = vi.mocked(updateSettingsInStore).mock.calls[0]![2];
    const current = {
      selfImprovementLastRunAt: undefined,
      selfImprovementLastCommitSha: undefined,
    };
    const next = updater(current as never);
    expect(next.selfImprovementLastRunAt).toBeDefined();
    expect(next.selfImprovementLastCommitSha).toBe("sha-from-caller");
  });

  it("does not update last run when task create throws", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    const { updateSettingsInStore } = await import("../services/settings-store.service.js");
    vi.mocked(taskStore.create).mockRejectedValueOnce(new Error("DB error"));

    const service = new SelfImprovementRunnerService();
    await expect(service.runSelfImprovement(projectId)).rejects.toThrow("DB error");
    expect(updateSettingsInStore).not.toHaveBeenCalled();
  });

  it("runs one general review and enrichment when reviewAngles is empty", async () => {
    const { agentService } = await import("../services/agent.service.js");
    const service = new SelfImprovementRunnerService();
    vi.mocked(agentService.invokePlanningAgent)
      .mockResolvedValueOnce({
        content: '[{"title":"Improve X","priority":1,"complexity":3}]',
      } as never)
      .mockResolvedValueOnce({
        content: '[{"title":"Improve X","priority":1,"complexity":3}]',
      } as never);

    await service.runSelfImprovement(projectId);

    expect(agentService.invokePlanningAgent).toHaveBeenCalledTimes(2);
    expect(agentService.invokePlanningAgent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tracking: expect.objectContaining({ label: "Self-improvement (General)" }),
      })
    );
    expect(agentService.invokePlanningAgent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tracking: expect.objectContaining({
          label: "Self-improvement (assign priority & complexity)",
        }),
      })
    );
  });

  it("runs one review per lens and enrichment when reviewAngles is set", async () => {
    const { ProjectService } = await import("../services/project.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: "proj-1", repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            reviewAngles: ["security", "performance"],
          }),
        }) as never
    );

    const service = new SelfImprovementRunnerService();
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(agentService.invokePlanningAgent)
      .mockResolvedValueOnce({ content: '[{"title":"Item","priority":2,"complexity":5}]' } as never)
      .mockResolvedValueOnce({ content: '[{"title":"Item","priority":2,"complexity":5}]' } as never)
      .mockResolvedValueOnce({
        content: '[{"title":"Item","priority":2,"complexity":5}]',
      } as never);

    await service.runSelfImprovement(projectId);

    expect(agentService.invokePlanningAgent).toHaveBeenCalledTimes(3);
    const labels = vi
      .mocked(agentService.invokePlanningAgent)
      .mock.calls.map((c) => (c[0].tracking as { label: string }).label);
    expect(labels).toContain("Self-improvement (Security implications)");
    expect(labels).toContain("Self-improvement (Performance impact)");
    expect(labels).toContain("Self-improvement (assign priority & complexity)");
  });

  it("creates tasks when enrichment fails but main agent provided both priority and complexity", async () => {
    const { ProjectService } = await import("../services/project.service.js");
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: "proj-1", repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            reviewAngles: undefined,
          }),
        }) as never
    );
    vi.mocked(agentService.invokePlanningAgent)
      .mockResolvedValueOnce({
        content: JSON.stringify([
          { title: "Add tests", description: "Unit tests", priority: 1, complexity: 3 },
          { title: "Refactor API", priority: 0, complexity: 7 },
        ]),
      } as never)
      .mockRejectedValue(new Error("enrichment timeout"));

    const service = new SelfImprovementRunnerService();
    const result = await service.runSelfImprovement(projectId);

    expect(result).toMatchObject({ tasksCreated: 2 });
    expect(taskStore.create).toHaveBeenCalledTimes(2);
    expect(taskStore.create).toHaveBeenNthCalledWith(
      1,
      projectId,
      "Refactor API",
      expect.objectContaining({ priority: 0, complexity: 7 })
    );
    expect(taskStore.create).toHaveBeenNthCalledWith(
      2,
      projectId,
      "Add tests",
      expect.objectContaining({ priority: 1, complexity: 3 })
    );
  });

  it("skips creating improvement tasks when enrichment fails and items lack priority/complexity from main agent", async () => {
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    const { ProjectService } = await import("../services/project.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: "proj-1", repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            reviewAngles: undefined,
          }),
        }) as never
    );
    vi.mocked(agentService.invokePlanningAgent)
      .mockResolvedValueOnce({
        content: "- **Add tests** — Unit tests\n- **Refactor API**",
      } as never)
      .mockRejectedValue(new Error("enrichment timeout"));

    const service = new SelfImprovementRunnerService();
    const result = await service.runSelfImprovement(projectId);

    expect(result).toMatchObject({ tasksCreated: 0, runId: expect.any(String) });
    expect(taskStore.create).not.toHaveBeenCalled();
  });

  it("creates no tasks when agent returns only short/junk titles (e.g. truncated output)", async () => {
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: '[{"title":"th"},{"title":"e"},{"title":"re"}]',
    } as never);

    const service = new SelfImprovementRunnerService();
    const result = await service.runSelfImprovement(projectId);

    expect(result).toMatchObject({ tasksCreated: 0, runId: expect.any(String) });
    expect(taskStore.create).not.toHaveBeenCalled();
  });

  it("caps tasks at 10 per run when agent returns many items", async () => {
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    const manyItems = Array.from({ length: 15 }, (_, i) => ({
      title: `Improvement ${i + 1}`,
      description: `Detail ${i}`,
      priority: i % 3,
    }));
    // capAndDedupe sorts by priority (0,1,2) and takes first 10: 1,4,7,10,13,2,5,8,11,14
    const cappedTitles = [
      "Improvement 1",
      "Improvement 4",
      "Improvement 7",
      "Improvement 10",
      "Improvement 13",
      "Improvement 2",
      "Improvement 5",
      "Improvement 8",
      "Improvement 11",
      "Improvement 14",
    ];
    const enrichedItems = cappedTitles.map((title, i) => ({
      title,
      priority: i < 5 ? 0 : i < 10 ? 1 : 2,
      complexity: 5,
    }));
    vi.mocked(agentService.invokePlanningAgent)
      .mockResolvedValueOnce({ content: JSON.stringify(manyItems) } as never)
      .mockResolvedValueOnce({ content: JSON.stringify(enrichedItems) } as never);

    const service = new SelfImprovementRunnerService();
    const result = await service.runSelfImprovement(projectId);

    expect(result).toMatchObject({ tasksCreated: 10, runId: expect.any(String) });
    expect(taskStore.create).toHaveBeenCalledTimes(10);
  });

  it("caps and dedupes when multiple lenses return overlapping items", async () => {
    const { ProjectService } = await import("../services/project.service.js");
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: "proj-1", repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            reviewAngles: ["security", "performance"],
          }),
        }) as never
    );
    vi.mocked(agentService.invokePlanningAgent)
      .mockResolvedValueOnce({
        content: JSON.stringify([
          { title: "Add tests", priority: 0 },
          { title: "Fix lint", priority: 1 },
          { title: "Harden auth", priority: 0 },
        ]),
      } as never)
      .mockResolvedValueOnce({
        content: JSON.stringify([
          { title: "Add tests", priority: 1 },
          { title: "Optimize queries", priority: 0 },
        ]),
      } as never)
      .mockResolvedValueOnce({
        content: JSON.stringify([
          { title: "Add tests", priority: 1, complexity: 4 },
          { title: "Fix lint", priority: 1, complexity: 2 },
          { title: "Harden auth", priority: 0, complexity: 6 },
          { title: "Optimize queries", priority: 0, complexity: 5 },
        ]),
      } as never);

    const service = new SelfImprovementRunnerService();
    const result = await service.runSelfImprovement(projectId);

    expect(result.tasksCreated).toBe(4);
    expect(taskStore.create).toHaveBeenCalledTimes(4);
    const titles = vi.mocked(taskStore.create).mock.calls.map((c) => c[1]);
    expect(titles).toContain("Add tests");
    expect(titles).toContain("Fix lint");
    expect(titles).toContain("Harden auth");
    expect(titles).toContain("Optimize queries");
    expect(titles.filter((t) => t === "Add tests")).toHaveLength(1);
  });

  it("creates fallback task when invokePlanningAgent rejects for one lens", async () => {
    const { ProjectService } = await import("../services/project.service.js");
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    const { updateSettingsInStore } = await import("../services/settings-store.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: "proj-1", repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            reviewAngles: ["security"],
          }),
        }) as never
    );
    vi.mocked(agentService.invokePlanningAgent)
      .mockRejectedValueOnce(new Error("Agent timeout"))
      .mockResolvedValueOnce({
        content: JSON.stringify([
          {
            title: "Self-improvement (Security implications): run failed",
            priority: 0,
            complexity: 1,
          },
        ]),
      } as never);

    const service = new SelfImprovementRunnerService();
    await service.runSelfImprovement(projectId);

    expect(taskStore.create).toHaveBeenCalledWith(
      projectId,
      "Self-improvement (Security implications): run failed",
      expect.objectContaining({
        description: "Agent timeout",
        priority: 0,
        complexity: 1,
        extra: expect.objectContaining({ source: "self-improvement" }),
      })
    );
    // On Reviewer failure we do not update lastRunAt.
    expect(updateSettingsInStore).not.toHaveBeenCalled();
  });

  it("creates fallback task for Validating test coverage when Cursor security exit 45 occurs", async () => {
    const { ProjectService } = await import("../services/project.service.js");
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    const { updateSettingsInStore } = await import("../services/settings-store.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: "proj-1", repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            reviewAngles: ["test_coverage"],
          }),
        }) as never
    );
    const securityError = "Security command failed: Security process exited with code: 45";
    vi.mocked(agentService.invokePlanningAgent)
      .mockRejectedValueOnce(new Error(securityError))
      .mockResolvedValueOnce({
        content: JSON.stringify([
          {
            title: "Self-improvement (Validating test coverage): run failed",
            priority: 0,
            complexity: 1,
          },
        ]),
      } as never);

    const service = new SelfImprovementRunnerService();
    await service.runSelfImprovement(projectId);

    expect(taskStore.create).toHaveBeenCalledWith(
      projectId,
      "Self-improvement (Validating test coverage): run failed",
      expect.objectContaining({
        description: securityError,
        priority: 0,
        complexity: 1,
        extra: expect.objectContaining({ source: "self-improvement" }),
      })
    );
    expect(updateSettingsInStore).not.toHaveBeenCalled();
  });

  it("does not update lastRunAt when all Reviewer invocations fail", async () => {
    const { agentService } = await import("../services/agent.service.js");
    const { updateSettingsInStore } = await import("../services/settings-store.service.js");
    const { notificationService } = await import("../services/notification.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockRejectedValue(new Error("timeout"));

    const service = new SelfImprovementRunnerService();
    const result = await service.runSelfImprovement(projectId);

    expect(result).toMatchObject({ tasksCreated: 0, runId: expect.any(String) });
    expect(updateSettingsInStore).not.toHaveBeenCalled();
    expect(notificationService.createAgentFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        source: "execute",
        sourceId: expect.stringMatching(/^self-improvement-/),
        message: expect.stringContaining("Self-improvement run had"),
      })
    );
  });
});

describe("concurrency guard and isSelfImprovementRunInProgress", () => {
  const projectId = "proj-guard";

  it("isSelfImprovementRunInProgress is false when no run is active", () => {
    expect(isSelfImprovementRunInProgress(projectId)).toBe(false);
  });

  it("two concurrent triggers yield one run and one skip", async () => {
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(taskStore.create).mockResolvedValue({ id: "os-1", title: "Task" } as never);

    let resolveAgent: (v: { content: string }) => void;
    const agentPromise = new Promise<{ content: string }>((resolve) => {
      resolveAgent = resolve;
    });
    vi.mocked(agentService.invokePlanningAgent).mockReturnValue(agentPromise as never);

    const service = new SelfImprovementRunnerService();
    const run1Promise = service.runSelfImprovement(projectId, { runId: "run-1" });

    await vi.waitFor(() => {
      expect(isSelfImprovementRunInProgress(projectId)).toBe(true);
    });

    const run2Result = await service.runSelfImprovement(projectId, { runId: "run-2" });
    expect(run2Result).toEqual({ tasksCreated: 0, skipped: "run_in_progress" });

    resolveAgent!({ content: '[{"title":"One","priority":1,"complexity":3}]' });
    const run1Result = await run1Promise;
    expect(run1Result).toMatchObject({ tasksCreated: 1, runId: "run-1" });

    expect(isSelfImprovementRunInProgress(projectId)).toBe(false);
  });

  it("isSelfImprovementRunInProgress is true only while run is active", async () => {
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(taskStore.create).mockResolvedValue({ id: "os-1", title: "Task" } as never);

    let resolveAgent: (v: { content: string }) => void;
    const agentPromise = new Promise<{ content: string }>((resolve) => {
      resolveAgent = resolve;
    });
    vi.mocked(agentService.invokePlanningAgent).mockReturnValue(agentPromise as never);

    const service = new SelfImprovementRunnerService();
    expect(service.isSelfImprovementRunInProgress(projectId)).toBe(false);

    const runPromise = service.runSelfImprovement(projectId);
    await vi.waitFor(() => {
      expect(service.isSelfImprovementRunInProgress(projectId)).toBe(true);
    });
    resolveAgent!({ content: "[]" });
    await runPromise;
    expect(service.isSelfImprovementRunInProgress(projectId)).toBe(false);
  });

  it("releases guard when run throws so a subsequent run can proceed", async () => {
    const { ProjectService } = await import("../services/project.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockRejectedValue(new Error("getProject failed")),
          getSettings: vi.fn().mockResolvedValue({}),
        }) as never
    );
    const service1 = new SelfImprovementRunnerService();
    await expect(service1.runSelfImprovement(projectId)).rejects.toThrow("getProject failed");
    expect(isSelfImprovementRunInProgress(projectId)).toBe(false);
    // Restore mock so a new service gets a resolving ProjectService
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: "proj-1", repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            reviewAngles: undefined as string[] | undefined,
          }),
        }) as never
    );
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(taskStore.create).mockResolvedValue({ id: "os-1", title: "Task" } as never);
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: '[{"title":"One","priority":1,"complexity":3}]',
    } as never);
    const service2 = new SelfImprovementRunnerService();
    const result = await service2.runSelfImprovement(projectId, { runId: "after-throw" });
    expect(result).toMatchObject({ tasksCreated: 1, runId: "after-throw" });
  });
});

describe("concurrency guard and isSelfImprovementRunInProgress", () => {
  const projectId = "proj-guard";

  it("isSelfImprovementRunInProgress is false when no run is active", () => {
    expect(isSelfImprovementRunInProgress(projectId)).toBe(false);
  });

  it("two concurrent triggers yield one run and one skip", async () => {
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(taskStore.create).mockResolvedValue({ id: "os-1", title: "Task" } as never);

    let resolveAgent: (v: { content: string }) => void;
    const agentPromise = new Promise<{ content: string }>((resolve) => {
      resolveAgent = resolve;
    });
    vi.mocked(agentService.invokePlanningAgent).mockReturnValue(agentPromise as never);

    const service = new SelfImprovementRunnerService();
    const run1Promise = service.runSelfImprovement(projectId, { runId: "run-1" });

    await vi.waitFor(() => {
      expect(isSelfImprovementRunInProgress(projectId)).toBe(true);
    });

    const run2Result = await service.runSelfImprovement(projectId, { runId: "run-2" });
    expect(run2Result).toEqual({ tasksCreated: 0, skipped: "run_in_progress" });

    resolveAgent!({ content: '[{"title":"One","priority":1,"complexity":3}]' });
    const run1Result = await run1Promise;
    expect(run1Result).toMatchObject({ tasksCreated: 1, runId: "run-1" });

    expect(isSelfImprovementRunInProgress(projectId)).toBe(false);
  });

  it("isSelfImprovementRunInProgress is true only while run is active", async () => {
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(taskStore.create).mockResolvedValue({ id: "os-1", title: "Task" } as never);

    let resolveAgent: (v: { content: string }) => void;
    const agentPromise = new Promise<{ content: string }>((resolve) => {
      resolveAgent = resolve;
    });
    vi.mocked(agentService.invokePlanningAgent).mockReturnValue(agentPromise as never);

    const service = new SelfImprovementRunnerService();
    expect(service.isSelfImprovementRunInProgress(projectId)).toBe(false);

    const runPromise = service.runSelfImprovement(projectId);
    await vi.waitFor(() => {
      expect(service.isSelfImprovementRunInProgress(projectId)).toBe(true);
    });
    resolveAgent!({ content: "[]" });
    await runPromise;
    expect(service.isSelfImprovementRunInProgress(projectId)).toBe(false);
  });

  it("releases guard when run throws so a subsequent run can proceed", async () => {
    const { ProjectService } = await import("../services/project.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockRejectedValue(new Error("getProject failed")),
          getSettings: vi.fn().mockResolvedValue({}),
        }) as never
    );
    const service1 = new SelfImprovementRunnerService();
    await expect(service1.runSelfImprovement(projectId)).rejects.toThrow("getProject failed");
    expect(isSelfImprovementRunInProgress(projectId)).toBe(false);
    // Restore mock so a new service gets a resolving ProjectService
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: "proj-1", repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            reviewAngles: undefined as string[] | undefined,
          }),
        }) as never
    );
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(taskStore.create).mockResolvedValue({ id: "os-1", title: "Task" } as never);
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: '[{"title":"One","priority":1,"complexity":3}]',
    } as never);
    const service2 = new SelfImprovementRunnerService();
    const result = await service2.runSelfImprovement(projectId, { runId: "after-throw" });
    expect(result).toMatchObject({ tasksCreated: 1, runId: "after-throw" });
  });
});

describe("runSelfImprovement", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { taskStore } = await import("../services/task-store.service.js");
    const { agentService } = await import("../services/agent.service.js");
    vi.mocked(taskStore.create).mockResolvedValue({ id: "os-1", title: "Task" } as never);
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: '[{"title":"Task A","priority":1,"complexity":3}]',
    } as never);
  });

  it("exports runSelfImprovement and creates tasks with source", async () => {
    const { taskStore } = await import("../services/task-store.service.js");
    const result = await runSelfImprovement("proj-1", { runId: "r1" });
    expect(result).toMatchObject({ tasksCreated: 1, runId: "r1" });
    expect(taskStore.create).toHaveBeenCalledWith(
      "proj-1",
      "Task A",
      expect.objectContaining({
        extra: expect.objectContaining({ source: "self-improvement", runId: "r1" }),
      })
    );
  });
});

describe("experiment pipeline wiring", () => {
  const projectId = "proj-exp";

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(governanceService.getConfig).mockResolvedValue({ mode: "disabled" } as never);
    setSelfImprovementRunInProgressForTest(projectId, false);
    const { taskStore } = await import("../services/task-store.service.js");
    const { agentService } = await import("../services/agent.service.js");
    const { updateSettingsInStore } = await import("../services/settings-store.service.js");
    vi.mocked(taskStore.create).mockResolvedValue({ id: "os-1", title: "Task" } as never);
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: '[{"title":"Task A","priority":1,"complexity":3}]',
    } as never);
    vi.mocked(updateSettingsInStore).mockResolvedValue(undefined);
  });

  afterEach(() => {
    setSelfImprovementRunInProgressForTest(projectId, false);
  });

  it("runs the independent evaluator and never auto-promotes policy under full autonomy", async () => {
    const { ProjectService } = await import("../services/project.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    const { updateSettingsInStore } = await import("../services/settings-store.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            runAgentEnhancementExperiments: true,
            aiAutonomyLevel: "full",
          }),
        }) as never
    );
    vi.mocked(governanceService.getConfig).mockResolvedValue({ mode: "enforced" } as never);
    vi.mocked(governanceService.listProposals).mockResolvedValue([
      { id: "proposal1", state: "draft", version: 2 },
    ] as never);
    vi.mocked(evaluatePolicyProposal).mockResolvedValue({
      id: "proposal1",
      state: "evaluated",
    } as never);
    await new SelfImprovementRunnerService().runSelfImprovement(projectId, {
      runId: "actual-evaluation",
    });
    expect(evaluatePolicyProposal).toHaveBeenCalledWith(projectId, "proposal1", 2, "/tmp/repo");
    expect(taskStore.insertSelfImprovementRunHistory).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "promotion_pending", pendingCandidateId: "proposal1" })
    );
    for (const [, , update] of vi.mocked(updateSettingsInStore).mock.calls) {
      const next = update({} as never);
      expect(next.selfImprovementActiveBehaviorVersionId).toBeUndefined();
    }
  });

  it("initial status is running_audit even when experiments are enabled", async () => {
    const { ProjectService } = await import("../services/project.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            reviewAngles: undefined,
            runAgentEnhancementExperiments: true,
          }),
        }) as never
    );

    const { agentService } = await import("../services/agent.service.js");
    let capturedStatus: string | undefined;
    vi.mocked(agentService.invokePlanningAgent).mockImplementation(async () => {
      const state = getSelfImprovementRunState(projectId);
      capturedStatus = state?.status;
      return {
        content: '[{"title":"Task A","priority":1,"complexity":3}]',
      } as never;
    });

    const service = new SelfImprovementRunnerService();
    await service.runSelfImprovement(projectId, { runId: "run-status-check" });

    expect(capturedStatus).toBe("running_audit");
  });

  it("runs audit only when runAgentEnhancementExperiments is false", async () => {
    const { ProjectService } = await import("../services/project.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            reviewAngles: undefined,
            runAgentEnhancementExperiments: false,
          }),
        }) as never
    );

    const service = new SelfImprovementRunnerService();
    const result = await service.runSelfImprovement(projectId, { runId: "audit-only-run" });

    expect(result).toMatchObject({ tasksCreated: 1, runId: "audit-only-run" });
    expect(taskStore.insertSelfImprovementRunHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "audit_only",
        outcome: "tasks_created",
        status: "success",
      })
    );
  });

  it("runs audit only when runAgentEnhancementExperiments is undefined (default)", async () => {
    const { ProjectService } = await import("../services/project.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            reviewAngles: undefined,
          }),
        }) as never
    );
    const { taskStore } = await import("../services/task-store.service.js");

    const service = new SelfImprovementRunnerService();
    await service.runSelfImprovement(projectId, { runId: "default-run" });

    expect(taskStore.insertSelfImprovementRunHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "audit_only",
      })
    );
  });

  it("skips experiment step when no replay-grade sessions and records audit outcome", async () => {
    const { ProjectService } = await import("../services/project.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            reviewAngles: undefined,
            runAgentEnhancementExperiments: true,
          }),
        }) as never
    );
    vi.mocked(taskStore.getDb).mockResolvedValue({
      query: vi.fn().mockResolvedValue([]),
    } as never);

    const service = new SelfImprovementRunnerService();
    const result = await service.runSelfImprovement(projectId, { runId: "no-replay-run" });

    expect(result).toMatchObject({ tasksCreated: 1, runId: "no-replay-run" });
    expect(taskStore.insertSelfImprovementRunHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "audit_and_experiments",
        outcome: "tasks_created",
        summary: expect.stringContaining("Experiment step skipped"),
      })
    );
  });

  it("records history status as failed when experiment pipeline throws", async () => {
    vi.mocked(governanceService.getConfig).mockRejectedValueOnce(new Error("DB connection lost"));
    const { ProjectService } = await import("../services/project.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            reviewAngles: undefined,
            runAgentEnhancementExperiments: true,
          }),
        }) as never
    );
    vi.mocked(taskStore.getDb).mockResolvedValue({
      query: vi.fn().mockRejectedValue(new Error("DB connection lost")),
    } as never);

    const service = new SelfImprovementRunnerService();
    const result = await service.runSelfImprovement(projectId, { runId: "fail-run" });

    expect(result).toMatchObject({ tasksCreated: 1, runId: "fail-run" });
    expect(taskStore.insertSelfImprovementRunHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "audit_and_experiments",
        outcome: "failed",
        status: "failed",
        summary: expect.stringContaining("Governance evaluation unavailable"),
      })
    );
  });

  it("does not run experiments when all audit reviews fail", async () => {
    const { ProjectService } = await import("../services/project.service.js");
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    const { notificationService } = await import("../services/notification.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            reviewAngles: undefined,
            runAgentEnhancementExperiments: true,
          }),
        }) as never
    );
    vi.mocked(agentService.invokePlanningAgent).mockRejectedValue(new Error("agent timeout"));

    const service = new SelfImprovementRunnerService();
    await service.runSelfImprovement(projectId, { runId: "all-fail-run" });

    expect(taskStore.insertSelfImprovementRunHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "audit_and_experiments",
        outcome: "no_changes",
        status: "success",
      })
    );
    expect(notificationService.createAgentFailed).toHaveBeenCalled();
  });

  it("records audit_and_experiments mode and no_changes outcome when experiments enabled but no tasks created and no sessions", async () => {
    const { ProjectService } = await import("../services/project.service.js");
    const { agentService } = await import("../services/agent.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            reviewAngles: undefined,
            runAgentEnhancementExperiments: true,
          }),
        }) as never
    );
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: "[]",
    } as never);
    vi.mocked(taskStore.getDb).mockResolvedValue({
      query: vi.fn().mockResolvedValue([]),
    } as never);

    const service = new SelfImprovementRunnerService();
    const result = await service.runSelfImprovement(projectId, { runId: "empty-run" });

    expect(result).toMatchObject({ tasksCreated: 0, runId: "empty-run" });
    expect(taskStore.insertSelfImprovementRunHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "audit_and_experiments",
        outcome: "no_changes",
        summary: expect.stringContaining("Experiment step skipped"),
      })
    );
  });

  it("clears in-progress state after experiment pipeline failure", async () => {
    const { ProjectService } = await import("../services/project.service.js");
    const { taskStore } = await import("../services/task-store.service.js");
    vi.mocked(ProjectService).mockImplementation(
      () =>
        ({
          getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath: "/tmp/repo" }),
          getSettings: vi.fn().mockResolvedValue({
            simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
            reviewAngles: undefined,
            runAgentEnhancementExperiments: true,
          }),
        }) as never
    );
    vi.mocked(taskStore.getDb).mockResolvedValue({
      query: vi.fn().mockRejectedValue(new Error("DB error")),
    } as never);

    const service = new SelfImprovementRunnerService();
    await service.runSelfImprovement(projectId, { runId: "cleanup-check" });

    expect(isSelfImprovementRunInProgress(projectId)).toBe(false);
  });
});

describe("failure root-cause analysis prompt integration", () => {
  const projectId = "proj-failure-review";

  beforeEach(async () => {
    vi.clearAllMocks();
    setSelfImprovementRunInProgressForTest(projectId, false);
    const { taskStore } = await import("../services/task-store.service.js");
    const { agentService } = await import("../services/agent.service.js");
    const { updateSettingsInStore } = await import("../services/settings-store.service.js");
    vi.mocked(taskStore.create).mockResolvedValue({ id: "os-1", title: "Task" } as never);
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content:
        '[{"title":"[Root Cause] Fix flaky test setup","description":"**Root cause:** Missing test fixture.\\n**Affected area:** src/tests/\\n**Remediation steps:** 1. Add fixture. 2. Update imports.\\n**Acceptance criteria:** Tests pass without retry.","priority":0,"complexity":3}]',
    } as never);
    vi.mocked(updateSettingsInStore).mockResolvedValue(undefined);
  });

  afterEach(() => {
    setSelfImprovementRunInProgressForTest(projectId, false);
  });

  it("includes failure root-cause analysis instructions in system prompt when failures exist", async () => {
    const { collectFailuresSince } =
      await import("../services/self-improvement-failure-collector.service.js");
    vi.mocked(collectFailuresSince).mockResolvedValue([
      {
        taskId: "os-fail-1",
        failureType: "execution",
        rawFailureType: "test_failure",
        attemptCount: 3,
        finalDisposition: "blocked",
        timestamp: "2026-03-20T12:00:00.000Z",
        errorSnippet: "Cannot find module 'react'",
      },
    ]);

    const { agentService } = await import("../services/agent.service.js");
    const service = new SelfImprovementRunnerService();
    await service.runSelfImprovement(projectId, { runId: "failure-review-run" });

    const calls = vi.mocked(agentService.invokePlanningAgent).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const reviewCall = calls[0]!;
    const systemPrompt = reviewCall[0].systemPrompt as string;
    expect(systemPrompt).toContain("Failure Root-Cause Analysis");
    expect(systemPrompt).toContain("Group failures by pattern/root cause");
    expect(systemPrompt).toContain("do not use special title prefixes");
    expect(systemPrompt).toContain("Remediation steps");
    expect(systemPrompt).toContain("Acceptance criteria");

    const userMessage = (reviewCall[0].messages as Array<{ content: string }>)[0]!.content;
    expect(userMessage).toContain("Failure Review");
    expect(userMessage).toContain("1 failure(s)");
    expect(userMessage).toContain("1 blocked");
  });

  it("omits failure root-cause analysis instructions when no failures exist", async () => {
    const { collectFailuresSince } =
      await import("../services/self-improvement-failure-collector.service.js");
    vi.mocked(collectFailuresSince).mockResolvedValue([]);

    const { agentService } = await import("../services/agent.service.js");
    const service = new SelfImprovementRunnerService();
    await service.runSelfImprovement(projectId, { runId: "no-failures-run" });

    const calls = vi.mocked(agentService.invokePlanningAgent).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const reviewCall = calls[0]!;
    const systemPrompt = reviewCall[0].systemPrompt as string;
    expect(systemPrompt).not.toContain("Failure Root-Cause Analysis");
    expect(systemPrompt).not.toContain("Group failures by pattern");

    const userMessage = (reviewCall[0].messages as Array<{ content: string }>)[0]!.content;
    expect(userMessage).not.toContain("Failure Review");
  });

  it("creates root-cause fix tasks with structured description from agent output", async () => {
    const { collectFailuresSince } =
      await import("../services/self-improvement-failure-collector.service.js");
    vi.mocked(collectFailuresSince).mockResolvedValue([
      {
        taskId: "os-fail-1",
        failureType: "execution",
        attemptCount: 2,
        finalDisposition: "requeued",
        timestamp: "2026-03-20T12:00:00.000Z",
      },
    ]);

    const { taskStore } = await import("../services/task-store.service.js");
    const service = new SelfImprovementRunnerService();
    const result = await service.runSelfImprovement(projectId, { runId: "root-cause-run" });

    expect(result.tasksCreated).toBe(1);
    expect(taskStore.create).toHaveBeenCalledWith(
      projectId,
      "[Root Cause] Fix flaky test setup",
      expect.objectContaining({
        description: expect.stringContaining("Root cause:"),
        priority: 0,
        complexity: 3,
      })
    );
  });

  it("includes failure stats in user prompt for mixed failure dispositions", async () => {
    const { collectFailuresSince } =
      await import("../services/self-improvement-failure-collector.service.js");
    vi.mocked(collectFailuresSince).mockResolvedValue([
      {
        taskId: "os-a",
        failureType: "execution",
        attemptCount: 3,
        finalDisposition: "blocked",
        timestamp: "2026-03-20T10:00:00.000Z",
      },
      {
        taskId: "os-b",
        failureType: "environment",
        attemptCount: 1,
        finalDisposition: "requeued",
        timestamp: "2026-03-20T11:00:00.000Z",
      },
      {
        taskId: "os-c",
        failureType: "merge",
        attemptCount: 2,
        finalDisposition: "blocked",
        timestamp: "2026-03-20T12:00:00.000Z",
      },
    ]);

    const { agentService } = await import("../services/agent.service.js");
    const service = new SelfImprovementRunnerService();
    await service.runSelfImprovement(projectId, { runId: "mixed-failures-run" });

    const calls = vi.mocked(agentService.invokePlanningAgent).mock.calls;
    const userMessage = (calls[0]![0].messages as Array<{ content: string }>)[0]!.content;
    expect(userMessage).toContain("3 failure(s)");
    expect(userMessage).toContain("2 blocked");
    expect(userMessage).toContain("1 requeued");
    expect(userMessage).toContain("2 with multiple attempts");

    const systemPrompt = calls[0]![0].systemPrompt as string;
    expect(systemPrompt).toContain("Environmental/infrastructure");
    expect(systemPrompt).toContain("Code/logic");
  });
});
