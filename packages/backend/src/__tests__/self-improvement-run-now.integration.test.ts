/**
 * Integration tests: "Run now" audit-only vs audit+experiments and approval flow.
 *
 * (1) runAgentEnhancementExperiments=false → audit-only; history shows audit_only.
 * (2) runAgentEnhancementExperiments=true  → audit then experiment pipeline;
 *     history shows audit_and_experiments + outcome.
 * (3) promotion_pending → self_improvement_approval notification exists;
 *     approve promotes and clears pending; reject clears pending.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  selfImprovementRunnerService,
  setSelfImprovementRunInProgressForTest,
} from "../services/self-improvement-runner.service.js";

/* ---------- module-level mocks ---------- */
const governed = vi.hoisted(() => ({
  mode: "disabled" as "disabled" | "enforced",
  proposals: [] as Array<{ id: string; state: string; version: number }>,
}));
vi.mock("../services/governance.service.js", async () => ({
  governanceService: {
    ...(await import("./mocks/disabled-governance.js")).disabledGovernanceService,
    getConfig: async () => ({ mode: governed.mode }),
    listProposals: async () => governed.proposals,
  },
}));
vi.mock("../services/congress.service.js", () => ({
  runGovernanceCongress: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/policy-evaluation.service.js", () => ({
  evaluatePolicyProposal: vi.fn().mockResolvedValue({ id: "proposal-1", state: "evaluated" }),
}));

const mockTaskStoreCreate = vi.fn().mockResolvedValue({ id: "os-si-1", title: "Improvement task" });
const mockInsertSelfImprovementRunHistory = vi.fn().mockImplementation(async (record) => ({
  id: 1,
  projectId: record.projectId,
  runId: record.runId,
  timestamp: record.completedAt,
  status: record.status,
  tasksCreatedCount: record.tasksCreatedCount,
  mode: record.mode,
  outcome: record.outcome,
  summary: record.summary,
  ...(record.pendingCandidateId != null ? { pendingCandidateId: record.pendingCandidateId } : {}),
  ...(record.promotedVersionId != null ? { promotedVersionId: record.promotedVersionId } : {}),
}));

const historyStore: Array<Record<string, unknown>> = [];

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    create: (...args: unknown[]) => mockTaskStoreCreate(...args),
    listAll: vi.fn().mockResolvedValue([]),
    getDb: vi.fn().mockResolvedValue({ query: vi.fn().mockResolvedValue([]) }),
    insertSelfImprovementRunHistory: (...args: unknown[]) => {
      const record = args[0] as Record<string, unknown>;
      historyStore.push(record);
      return mockInsertSelfImprovementRunHistory(record);
    },
    listSelfImprovementRunHistory: vi.fn().mockImplementation(async () => historyStore),
    runWrite: vi
      .fn()
      .mockImplementation(
        async (fn: (client: { execute: () => Promise<void> }) => Promise<void>) => {
          await fn({ execute: vi.fn().mockResolvedValue(undefined) });
        }
      ),
  },
}));

const mockGetProject = vi.fn().mockResolvedValue({ id: "proj-1", repoPath: "/tmp/repo" });
const mockGetSettings = vi.fn();

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getProject: (...args: unknown[]) => mockGetProject(...args),
    getSettings: (...args: unknown[]) => mockGetSettings(...args),
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

const mockUpdateSettingsInStore = vi
  .fn()
  .mockImplementation(
    async (
      _id: string,
      _current: unknown,
      updater: (s: Record<string, unknown>) => Record<string, unknown>
    ) => {
      if (typeof updater === "function") {
        const currentSettings =
          typeof _current === "object" && _current ? (_current as Record<string, unknown>) : {};
        const updated = updater(currentSettings);
        // Reflect pending candidate back to getSettings for subsequent calls
        if (updated.selfImprovementPendingCandidateId !== undefined) {
          const prevSettings = await mockGetSettings("proj-1");
          mockGetSettings.mockResolvedValue({
            ...prevSettings,
            selfImprovementPendingCandidateId:
              updated.selfImprovementPendingCandidateId || undefined,
            selfImprovementActiveBehaviorVersionId: updated.selfImprovementActiveBehaviorVersionId,
            selfImprovementBehaviorVersions:
              updated.selfImprovementBehaviorVersions ??
              prevSettings?.selfImprovementBehaviorVersions,
            selfImprovementBehaviorHistory:
              updated.selfImprovementBehaviorHistory ??
              prevSettings?.selfImprovementBehaviorHistory,
            selfImprovementPendingReplaySampleSize: updated.selfImprovementPendingReplaySampleSize,
            selfImprovementPendingBaselineMetrics: updated.selfImprovementPendingBaselineMetrics,
            selfImprovementPendingCandidateMetrics: updated.selfImprovementPendingCandidateMetrics,
          });
        }
      }
    }
  );

vi.mock("../services/settings-store.service.js", () => ({
  updateSettingsInStore: (...args: unknown[]) => mockUpdateSettingsInStore(...args),
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

const mockCreateSelfImprovementApproval = vi.fn().mockImplementation(async (input) => ({
  id: "sia-test-1",
  projectId: typeof input === "string" ? input : input.projectId,
  source: "self-improvement",
  sourceId: typeof input === "string" ? "candidate-x" : input.candidateId,
  questions: [{ id: "q-sia-1", text: "Approve or reject agent improvement candidate." }],
  status: "open",
  createdAt: new Date().toISOString(),
  resolvedAt: null,
  kind: "self_improvement_approval",
}));

const mockResolveSelfImprovementApprovalNotifications = vi.fn().mockResolvedValue([]);

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
    createSelfImprovementApproval: (...args: unknown[]) =>
      mockCreateSelfImprovementApproval(...args),
    resolveSelfImprovementApprovalNotifications: (...args: unknown[]) =>
      mockResolveSelfImprovementApprovalNotifications(...args),
  },
}));

vi.mock("../websocket/index.js", () => ({ broadcastToProject: vi.fn() }));

const mockInvokePlanningAgent = vi.fn();
vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: (...args: unknown[]) => mockInvokePlanningAgent(...args),
  },
}));

vi.mock("../services/structured-agent-output.service.js", () => ({
  invokeStructuredPlanningAgent: vi.fn().mockImplementation(async (options) => {
    const content =
      '[{"title":"Add tests","description":"Unit tests","priority":1,"complexity":3}]';
    const parsed = options.contract?.parse?.(content) ?? null;
    return {
      ok: true,
      parsed,
      initialRawContent: content,
      rawContent: content,
      repaired: false,
      attempts: 1,
      exhausted: false,
      fallbackApplied: false,
    };
  }),
}));

vi.mock("../services/behavior-version-store.service.js", () => ({
  runBehaviorVersionStoreWrite: vi.fn().mockImplementation(async (fn) => {
    const mockStore = {
      saveCandidate: vi.fn().mockResolvedValue(undefined),
      promoteToActive: vi.fn().mockResolvedValue(undefined),
      setActivePromoted: vi.fn().mockResolvedValue(undefined),
    };
    return fn(mockStore);
  }),
}));

vi.mock("../services/self-improvement-experiment.service.js", async () => {
  return {
    mineReplayGradeExecuteSessionIds: vi.fn().mockResolvedValue([101, 102]),
    SelfImprovementExperimentService: vi.fn().mockImplementation(() => ({
      generateAndPersistCandidate: vi.fn().mockResolvedValue({
        versionId: "exp-test-run-1",
        bundle: {
          versionType: "candidate",
          minedSessionIds: [101, 102],
          runId: "test-run-1",
          generalInstructionDiff: "diff --git ...",
          roleInstructionDiffs: {},
          promptTemplateDiffs: { coder: "", reviewer: "", finalReview: "", selfImprovement: "" },
          createdAt: new Date().toISOString(),
        },
      }),
    })),
  };
});

vi.mock("../services/experiment-replay.service.js", () => ({
  ExperimentReplayService: vi.fn().mockImplementation(() => ({
    runReplay: vi.fn().mockResolvedValue({
      sessions: [],
      baselineMetrics: {
        taskSuccessRate: 0.8,
        retryRate: 0,
        reviewPassRate: 1,
        avgLatencyMs: 100,
        avgCostUsd: 0.01,
      },
      candidateMetrics: {
        taskSuccessRate: 0.8,
        retryRate: 0,
        reviewPassRate: 1,
        avgLatencyMs: 100,
        avgCostUsd: 0.01,
      },
      sampleSize: 2,
    }),
  })),
}));

/* ---------- tests ---------- */

const projectId = "proj-1";
const baseSettings = {
  simpleComplexityAgent: { type: "cursor", model: null, cliCommand: null },
  complexComplexityAgent: { type: "cursor", model: null, cliCommand: null },
  reviewAngles: undefined as string[] | undefined,
  selfImprovementFrequency: "daily",
  aiAutonomyLevel: "confirm_all" as const,
  runAgentEnhancementExperiments: false,
};

describe("Run now: audit-only vs audit+experiments and approval flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    historyStore.length = 0;
    governed.mode = "disabled";
    governed.proposals = [];
  });

  afterEach(() => {
    setSelfImprovementRunInProgressForTest(projectId, false);
  });

  // ---- (1) runAgentEnhancementExperiments=false → audit-only ----

  it("runs audit-only when runAgentEnhancementExperiments is false; history shows audit_only", async () => {
    mockGetSettings.mockResolvedValue({ ...baseSettings, runAgentEnhancementExperiments: false });

    const result = await selfImprovementRunnerService.runSelfImprovement(projectId);

    expect(result).toHaveProperty("runId");
    expect(historyStore.length).toBe(1);
    expect(historyStore[0]).toMatchObject({
      projectId,
      mode: "audit_only",
    });
    // Outcome should be tasks_created or no_changes (depending on mock parse)
    expect(["tasks_created", "no_changes"]).toContain(historyStore[0]!.outcome);
    expect(historyStore[0]!.pendingCandidateId).toBeNull();
  });

  // ---- (2) runAgentEnhancementExperiments=true → audit + experiments ----

  it("runs substantive governance evaluation before requesting human activation", async () => {
    governed.mode = "enforced";
    governed.proposals = [{ id: "proposal-1", state: "draft", version: 1 }];
    mockGetSettings.mockResolvedValue({ ...baseSettings, runAgentEnhancementExperiments: true });

    const result = await selfImprovementRunnerService.runSelfImprovement(projectId);

    expect(result).toHaveProperty("runId");
    expect(historyStore.length).toBe(1);
    expect(historyStore[0]).toMatchObject({
      projectId,
      mode: "audit_and_experiments",
    });
    // Independently evaluated content still requires the separate human activation path.
    expect(historyStore[0]!.outcome).toBe("promotion_pending");
  });

  it("records experiment outcome when experiments enabled and experiment pipeline runs (or skips with no replay data)", async () => {
    governed.mode = "enforced";

    mockGetSettings.mockResolvedValue({ ...baseSettings, runAgentEnhancementExperiments: true });

    await selfImprovementRunnerService.runSelfImprovement(projectId);

    expect(historyStore.length).toBe(1);
    expect(historyStore[0]).toMatchObject({
      mode: "audit_and_experiments",
    });
    // When no replay sessions, outcome stays as the audit outcome (no experiment result)
    expect(["tasks_created", "no_changes"]).toContain(historyStore[0]!.outcome);
    expect(historyStore[0]!.summary).toContain("no unevaluated substantive policy amendment");
  });

  // ---- (3) promotion_pending → approval flow ----

  it("does not manufacture ordinary approval notifications when governance is not onboarded", async () => {
    mockGetSettings.mockResolvedValue({
      ...baseSettings,
      runAgentEnhancementExperiments: true,
      aiAutonomyLevel: "confirm_all",
    });

    await selfImprovementRunnerService.runSelfImprovement(projectId);

    expect(["tasks_created", "no_changes"]).toContain(historyStore[0]!.outcome);
    expect(historyStore[0]!.summary).toContain("onboard an approved governance policy");
    expect(mockCreateSelfImprovementApproval).not.toHaveBeenCalled();
  });

  it("approve endpoint promotes candidate and clears pending", async () => {
    // Pre-populate settings with a pending candidate from a prior run
    const pendingCandidateId = "exp-test-run-1";
    mockGetSettings.mockResolvedValue({
      ...baseSettings,
      runAgentEnhancementExperiments: true,
      selfImprovementPendingCandidateId: pendingCandidateId,
      selfImprovementBehaviorVersions: [],
      selfImprovementBehaviorHistory: [],
    });

    const { SelfImprovementService } = await import("../services/self-improvement.service.js");
    const service = new SelfImprovementService();

    const result = await service.approvePendingCandidate(projectId, pendingCandidateId);

    // updateSettingsInStore was called to clear pending and set active
    expect(mockUpdateSettingsInStore).toHaveBeenCalled();
    const updateCall = mockUpdateSettingsInStore.mock.calls.find(
      (call: unknown[]) => call[0] === projectId
    );
    expect(updateCall).toBeTruthy();

    // The updater function should clear pending and set active version
    const updater = updateCall![2] as (s: Record<string, unknown>) => Record<string, unknown>;
    const updated = updater({
      selfImprovementPendingCandidateId: pendingCandidateId,
      selfImprovementBehaviorVersions: [],
      selfImprovementBehaviorHistory: [],
    });
    expect(updated.selfImprovementPendingCandidateId).toBeUndefined();
    expect(updated.selfImprovementActiveBehaviorVersionId).toBe(pendingCandidateId);

    // Notification resolved
    expect(mockResolveSelfImprovementApprovalNotifications).toHaveBeenCalledWith(
      projectId,
      pendingCandidateId
    );

    // result reflects promoted state
    expect(result).toBeDefined();
  });

  it("reject endpoint clears pending without promoting", async () => {
    const pendingCandidateId = "exp-test-run-1";
    mockGetSettings.mockResolvedValue({
      ...baseSettings,
      runAgentEnhancementExperiments: true,
      selfImprovementPendingCandidateId: pendingCandidateId,
      selfImprovementBehaviorVersions: [],
      selfImprovementBehaviorHistory: [],
    });

    const { SelfImprovementService } = await import("../services/self-improvement.service.js");
    const service = new SelfImprovementService();

    const result = await service.rejectPendingCandidate(projectId, pendingCandidateId);

    // The updater should clear pending without setting active version
    const updateCall = mockUpdateSettingsInStore.mock.calls.find(
      (call: unknown[]) => call[0] === projectId
    );
    expect(updateCall).toBeTruthy();

    const updater = updateCall![2] as (s: Record<string, unknown>) => Record<string, unknown>;
    const updated = updater({
      selfImprovementPendingCandidateId: pendingCandidateId,
      selfImprovementBehaviorVersions: [],
      selfImprovementBehaviorHistory: [],
    });
    expect(updated.selfImprovementPendingCandidateId).toBeUndefined();
    expect(updated.selfImprovementActiveBehaviorVersionId).toBeUndefined();

    // Notification resolved
    expect(mockResolveSelfImprovementApprovalNotifications).toHaveBeenCalledWith(
      projectId,
      pendingCandidateId
    );

    // History records rejected action
    const history = updated.selfImprovementBehaviorHistory as Array<{ action: string }>;
    expect(history.some((h) => h.action === "rejected")).toBe(true);

    expect(result).toBeDefined();
  });

  it("approve throws when no pending candidate exists", async () => {
    mockGetSettings.mockResolvedValue({
      ...baseSettings,
      selfImprovementPendingCandidateId: undefined,
    });

    const { SelfImprovementService } = await import("../services/self-improvement.service.js");
    const service = new SelfImprovementService();

    await expect(service.approvePendingCandidate(projectId)).rejects.toThrow(
      /No pending self-improvement candidate/
    );
  });

  it("reject throws when no pending candidate exists", async () => {
    mockGetSettings.mockResolvedValue({
      ...baseSettings,
      selfImprovementPendingCandidateId: undefined,
    });

    const { SelfImprovementService } = await import("../services/self-improvement.service.js");
    const service = new SelfImprovementService();

    await expect(service.rejectPendingCandidate(projectId)).rejects.toThrow(
      /No pending self-improvement candidate/
    );
  });

  // ---- auto-promote under full autonomy ----

  it("keeps evaluated policy pending explicit human activation even at full autonomy", async () => {
    governed.mode = "enforced";
    governed.proposals = [{ id: "proposal-1", state: "draft", version: 1 }];
    mockGetSettings.mockResolvedValue({
      ...baseSettings,
      runAgentEnhancementExperiments: true,
      aiAutonomyLevel: "full",
    });

    await selfImprovementRunnerService.runSelfImprovement(projectId);

    expect(historyStore.length).toBe(1);
    expect(historyStore[0]).toMatchObject({
      mode: "audit_and_experiments",
      outcome: "promotion_pending",
    });
    // No approval notification for auto-promoted
    expect(mockCreateSelfImprovementApproval).not.toHaveBeenCalled();
  });
});
