/**
 * Integration tests: root-cause fix task creation from failure analysis.
 *
 * (1) Seed failures → run audit → verify fix tasks created with correct metadata.
 * (2) Duplicate detection: re-run with existing open root-cause fix task → skip creation.
 * (3) Non-root-cause tasks are created normally alongside root-cause tasks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  selfImprovementRunnerService,
  setSelfImprovementRunInProgressForTest,
  isRootCauseFixTask,
  extractRootCauseKey,
  buildFailurePatternSummary,
  enrichRootCauseDescription,
  ROOT_CAUSE_PREFIX,
} from "../services/self-improvement-runner.service.js";

/* ---------- module-level mocks ---------- */

const createdTasks: Array<{
  projectId: string;
  title: string;
  opts: Record<string, unknown>;
}> = [];

const mockTaskStoreCreate = vi.fn().mockImplementation(async (projectId, title, opts) => {
  const task = {
    id: `os-rc-${createdTasks.length + 1}`,
    project_id: projectId,
    title,
    description: opts?.description,
    issue_type: opts?.type ?? "task",
    status: "open",
    priority: opts?.priority ?? 2,
    labels: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...(opts?.extra ?? {}),
  };
  createdTasks.push({ projectId, title, opts: opts ?? {} });
  return task;
});

const mockListAll = vi.fn().mockResolvedValue([]);

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    create: (...args: unknown[]) => mockTaskStoreCreate(...args),
    listAll: (...args: unknown[]) => mockListAll(...args),
    getDb: vi.fn().mockResolvedValue({ query: vi.fn().mockResolvedValue([]) }),
    insertSelfImprovementRunHistory: vi.fn().mockImplementation(async (record) => ({
      id: 1,
      ...record,
      timestamp: record.completedAt,
    })),
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
      questions: [{ id: "q-1", text: "Failure" }],
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      kind: "agent_failed",
    }),
    createSelfImprovementApproval: vi.fn().mockResolvedValue({
      id: "sia-1",
      projectId: "proj-1",
      source: "self-improvement",
      sourceId: "candidate-x",
      questions: [],
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      kind: "self_improvement_approval",
    }),
    resolveSelfImprovementApprovalNotifications: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("../websocket/index.js", () => ({ broadcastToProject: vi.fn() }));

vi.mock("../services/agent.service.js", () => ({
  agentService: { invokePlanningAgent: vi.fn() },
}));

vi.mock("../services/behavior-version-store.service.js", () => ({
  runBehaviorVersionStoreWrite: vi.fn().mockImplementation(async (fn) => {
    return fn({
      saveCandidate: vi.fn().mockResolvedValue(undefined),
      promoteToActive: vi.fn().mockResolvedValue(undefined),
      setActivePromoted: vi.fn().mockResolvedValue(undefined),
    });
  }),
}));

const mockReadSinceByProjectId = vi.fn().mockResolvedValue([]);

vi.mock("../services/event-log.service.js", () => ({
  eventLogService: {
    readSinceByProjectId: (...args: unknown[]) => mockReadSinceByProjectId(...args),
  },
}));

const rootCauseAgentOutput = JSON.stringify([
  {
    title: "[Root Cause] Fix flaky dependency resolution in CI",
    description:
      "**Root cause:** npm ci intermittently fails due to stale lockfile.\n" +
      "**Affected area:** CI pipeline, package.json.\n" +
      "**Remediation steps:** 1. Regenerate lockfile. 2. Pin dependency versions.\n" +
      "**Acceptance criteria:** CI passes reliably for 10 consecutive runs.",
    priority: 0,
    complexity: 4,
  },
  {
    title: "[Root Cause] Handle missing test fixtures gracefully",
    description:
      "**Root cause:** Test fixtures are not generated before test run.\n" +
      "**Affected area:** packages/backend/src/__tests__/.\n" +
      "**Remediation steps:** 1. Add fixture generation to test setup.\n" +
      "**Acceptance criteria:** Tests pass without manual fixture setup.",
    priority: 1,
    complexity: 3,
  },
  {
    title: "Add input validation to settings API",
    description: "General improvement: validate user input on PATCH endpoint.",
    priority: 2,
    complexity: 2,
  },
]);

vi.mock("../services/structured-agent-output.service.js", () => ({
  invokeStructuredPlanningAgent: vi.fn().mockImplementation(async (options) => {
    const parsed = options.contract?.parse?.(rootCauseAgentOutput) ?? null;
    return {
      ok: true,
      parsed,
      initialRawContent: rootCauseAgentOutput,
      rawContent: rootCauseAgentOutput,
      repaired: false,
      attempts: 1,
      exhausted: false,
      fallbackApplied: false,
    };
  }),
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

describe("Root-cause fix task creation from failure analysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createdTasks.length = 0;
    mockListAll.mockResolvedValue([]);
  });

  afterEach(() => {
    setSelfImprovementRunInProgressForTest(projectId, false);
  });

  describe("unit helpers", () => {
    it("isRootCauseFixTask detects [Root Cause] prefix", () => {
      expect(isRootCauseFixTask("[Root Cause] Fix flaky tests")).toBe(true);
      expect(isRootCauseFixTask("  [Root Cause] Fix flaky tests")).toBe(true);
      expect(isRootCauseFixTask("Add unit tests")).toBe(false);
      expect(isRootCauseFixTask("")).toBe(false);
    });

    it("extractRootCauseKey normalizes the title after prefix", () => {
      expect(extractRootCauseKey("[Root Cause] Fix Flaky Tests")).toBe("fix flaky tests");
      expect(extractRootCauseKey("[Root Cause]  Multiple  Spaces ")).toBe("multiple spaces");
    });

    it("buildFailurePatternSummary groups failures by type", () => {
      const failures = [
        {
          taskId: "t1",
          failureType: "execution" as const,
          attemptCount: 1,
          finalDisposition: "blocked" as const,
          timestamp: "2026-01-01T00:00:00Z",
        },
        {
          taskId: "t2",
          failureType: "execution" as const,
          attemptCount: 2,
          finalDisposition: "requeued" as const,
          timestamp: "2026-01-02T00:00:00Z",
        },
        {
          taskId: "t3",
          failureType: "merge" as const,
          attemptCount: 1,
          finalDisposition: "blocked" as const,
          timestamp: "2026-01-03T00:00:00Z",
        },
      ];
      const summary = buildFailurePatternSummary(failures);
      expect(summary).toBe("execution: 2, merge: 1");
    });

    it("buildFailurePatternSummary returns empty string for no failures", () => {
      expect(buildFailurePatternSummary([])).toBe("");
    });

    it("enrichRootCauseDescription appends source failure info", () => {
      const desc = enrichRootCauseDescription(
        "Original description",
        ["os-1234", "os-5678"],
        "execution: 2"
      );
      expect(desc).toContain("Original description");
      expect(desc).toContain("**Source failure tasks:** os-1234, os-5678");
      expect(desc).toContain("**Failure pattern:** execution: 2");
    });

    it("enrichRootCauseDescription handles empty inputs", () => {
      const desc = enrichRootCauseDescription(undefined, [], "");
      expect(desc).toBe("");
    });
  });

  describe("end-to-end: seed failures → run audit → verify fix tasks", () => {
    it("creates root-cause fix tasks with correct metadata from failure analysis", async () => {
      mockReadSinceByProjectId.mockResolvedValue([
        {
          timestamp: "2026-03-20T12:00:00.000Z",
          projectId,
          taskId: "os-fail-1",
          event: "task.failed",
          data: { failureType: "test_failure", summary: "npm test failed" },
        },
        {
          timestamp: "2026-03-20T13:00:00.000Z",
          projectId,
          taskId: "os-fail-2",
          event: "task.blocked",
          data: { failureType: "merge_conflict", summary: "merge conflict" },
        },
      ]);

      mockGetSettings.mockResolvedValue({ ...baseSettings });
      mockListAll.mockResolvedValue([
        {
          id: "os-fail-1",
          project_id: projectId,
          title: "Task fail-1",
          issue_type: "task",
          status: "blocked",
          priority: 2,
          labels: [],
          created_at: "2026-03-01T00:00:00.000Z",
          updated_at: "2026-03-20T00:00:00.000Z",
        },
        {
          id: "os-fail-2",
          project_id: projectId,
          title: "Task fail-2",
          issue_type: "task",
          status: "blocked",
          priority: 2,
          labels: [],
          created_at: "2026-03-01T00:00:00.000Z",
          updated_at: "2026-03-20T00:00:00.000Z",
        },
      ]);

      const result = await selfImprovementRunnerService.runSelfImprovement(projectId);

      expect(result).toHaveProperty("runId");
      expect(result).toHaveProperty("tasksCreated");
      expect((result as { tasksCreated: number }).tasksCreated).toBe(3);

      const rootCauseTasks = createdTasks.filter((t) => t.title.startsWith(ROOT_CAUSE_PREFIX));
      expect(rootCauseTasks.length).toBe(2);

      const firstFix = rootCauseTasks[0]!;
      expect(firstFix.opts.extra).toMatchObject({
        source: "self-improvement",
        selfImprovementKind: "root-cause-fix",
        rootCauseKey: "fix flaky dependency resolution in ci",
        aiAssignedPriority: true,
        aiAssignedComplexity: true,
      });
      expect((firstFix.opts.extra as Record<string, unknown>).sourceFailureTaskIds).toEqual(
        expect.arrayContaining(["os-fail-1", "os-fail-2"])
      );
      expect(firstFix.opts.extra).toHaveProperty("failurePattern");
      expect(firstFix.opts.description).toContain("**Source failure tasks:**");
      expect(firstFix.opts.description).toContain("os-fail-1");
      expect(firstFix.opts.description).toContain("os-fail-2");

      const normalTasks = createdTasks.filter((t) => !t.title.startsWith(ROOT_CAUSE_PREFIX));
      expect(normalTasks.length).toBe(1);
      expect(normalTasks[0]!.title).toBe("Add input validation to settings API");
      const normalExtra = normalTasks[0]!.opts.extra as Record<string, unknown>;
      expect(normalExtra.selfImprovementKind).toBeUndefined();
      expect(normalExtra.rootCauseKey).toBeUndefined();
    });

    it("skips duplicate root-cause fix task when open task with same root cause exists", async () => {
      mockReadSinceByProjectId.mockResolvedValue([
        {
          timestamp: "2026-03-20T12:00:00.000Z",
          projectId,
          taskId: "os-fail-1",
          event: "task.failed",
          data: { failureType: "test_failure" },
        },
      ]);

      mockGetSettings.mockResolvedValue({ ...baseSettings });

      mockListAll.mockResolvedValue([
        {
          id: "os-fail-1",
          project_id: projectId,
          title: "Task fail-1",
          issue_type: "task",
          status: "blocked",
          priority: 2,
          labels: [],
          created_at: "2026-03-01T00:00:00.000Z",
          updated_at: "2026-03-20T00:00:00.000Z",
        },
        {
          id: "os-existing-rc",
          project_id: projectId,
          title: "[Root Cause] Fix flaky dependency resolution in CI",
          issue_type: "task",
          status: "open",
          priority: 0,
          labels: [],
          created_at: "2026-03-15T00:00:00.000Z",
          updated_at: "2026-03-15T00:00:00.000Z",
          selfImprovementKind: "root-cause-fix",
          rootCauseKey: "fix flaky dependency resolution in ci",
        },
      ]);

      const result = await selfImprovementRunnerService.runSelfImprovement(projectId);

      expect((result as { tasksCreated: number }).tasksCreated).toBe(2);

      const rootCauseTasks = createdTasks.filter((t) => t.title.startsWith(ROOT_CAUSE_PREFIX));
      expect(rootCauseTasks.length).toBe(1);
      expect(rootCauseTasks[0]!.title).toBe("[Root Cause] Handle missing test fixtures gracefully");

      const skippedTitles = createdTasks.map((t) => t.title);
      expect(skippedTitles).not.toContain("[Root Cause] Fix flaky dependency resolution in CI");
    });

    it("does not skip closed root-cause fix tasks as duplicates", async () => {
      mockReadSinceByProjectId.mockResolvedValue([
        {
          timestamp: "2026-03-20T12:00:00.000Z",
          projectId,
          taskId: "os-fail-1",
          event: "task.failed",
          data: { failureType: "test_failure" },
        },
      ]);

      mockGetSettings.mockResolvedValue({ ...baseSettings });

      mockListAll.mockResolvedValue([
        {
          id: "os-fail-1",
          project_id: projectId,
          title: "Task fail-1",
          issue_type: "task",
          status: "blocked",
          priority: 2,
          labels: [],
          created_at: "2026-03-01T00:00:00.000Z",
          updated_at: "2026-03-20T00:00:00.000Z",
        },
        {
          id: "os-closed-rc",
          project_id: projectId,
          title: "[Root Cause] Fix flaky dependency resolution in CI",
          issue_type: "task",
          status: "closed",
          priority: 0,
          labels: [],
          created_at: "2026-03-10T00:00:00.000Z",
          updated_at: "2026-03-15T00:00:00.000Z",
          selfImprovementKind: "root-cause-fix",
          rootCauseKey: "fix flaky dependency resolution in ci",
        },
      ]);

      const result = await selfImprovementRunnerService.runSelfImprovement(projectId);

      const rootCauseTasks = createdTasks.filter((t) => t.title.startsWith(ROOT_CAUSE_PREFIX));
      expect(rootCauseTasks.length).toBe(2);
      expect((result as { tasksCreated: number }).tasksCreated).toBe(3);
    });

    it("creates fix tasks with failure pattern derived from collected failures", async () => {
      mockReadSinceByProjectId.mockResolvedValue([
        {
          timestamp: "2026-03-20T12:00:00.000Z",
          projectId,
          taskId: "os-f1",
          event: "task.failed",
          data: { failureType: "test_failure" },
        },
        {
          timestamp: "2026-03-20T13:00:00.000Z",
          projectId,
          taskId: "os-f2",
          event: "task.failed",
          data: { failureType: "test_failure" },
        },
        {
          timestamp: "2026-03-20T14:00:00.000Z",
          projectId,
          taskId: "os-f3",
          event: "task.blocked",
          data: { failureType: "merge_conflict" },
        },
      ]);

      mockGetSettings.mockResolvedValue({ ...baseSettings });
      mockListAll.mockResolvedValue([
        {
          id: "os-f1",
          project_id: projectId,
          title: "T1",
          issue_type: "task",
          status: "blocked",
          priority: 2,
          labels: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-03-20T00:00:00Z",
        },
        {
          id: "os-f2",
          project_id: projectId,
          title: "T2",
          issue_type: "task",
          status: "blocked",
          priority: 2,
          labels: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-03-20T00:00:00Z",
        },
        {
          id: "os-f3",
          project_id: projectId,
          title: "T3",
          issue_type: "task",
          status: "blocked",
          priority: 2,
          labels: [],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-03-20T00:00:00Z",
        },
      ]);

      await selfImprovementRunnerService.runSelfImprovement(projectId);

      const rootCauseTasks = createdTasks.filter((t) => t.title.startsWith(ROOT_CAUSE_PREFIX));
      expect(rootCauseTasks.length).toBeGreaterThan(0);

      for (const task of rootCauseTasks) {
        const extra = task.opts.extra as Record<string, unknown>;
        expect(extra.failurePattern).toContain("execution");
        expect(extra.sourceFailureTaskIds).toEqual(
          expect.arrayContaining(["os-f1", "os-f2", "os-f3"])
        );
      }
    });

    it("handles audit with no failures — no root-cause metadata", async () => {
      mockReadSinceByProjectId.mockResolvedValue([]);
      mockGetSettings.mockResolvedValue({ ...baseSettings });
      mockListAll.mockResolvedValue([]);

      await selfImprovementRunnerService.runSelfImprovement(projectId);

      const rootCauseTasks = createdTasks.filter((t) => t.title.startsWith(ROOT_CAUSE_PREFIX));
      for (const task of rootCauseTasks) {
        const extra = task.opts.extra as Record<string, unknown>;
        expect(extra.sourceFailureTaskIds).toEqual([]);
        expect(extra.failurePattern).toBe("");
      }
    });
  });
});
