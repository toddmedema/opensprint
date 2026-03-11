import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SelfImprovementRunnerService,
  parseImprovementList,
  runSelfImprovement,
  isSelfImprovementRunInProgress,
} from "../services/self-improvement-runner.service.js";

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    create: vi.fn().mockResolvedValue({ id: "os-1", title: "Task" }),
    insertSelfImprovementRunHistory: vi.fn().mockResolvedValue({
      id: 1,
      projectId: "proj-1",
      runId: "si-1",
      timestamp: new Date().toISOString(),
      status: "success",
      tasksCreatedCount: 0,
    }),
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
  getSettingsFromStore: vi.fn().mockImplementation((_id: string, defaults: unknown) => Promise.resolve(defaults)),
}));

vi.mock("../services/agent-instructions.service.js", () => ({
  getCombinedInstructions: vi.fn().mockResolvedValue(""),
}));

vi.mock("../utils/shell-exec.js", () => ({
  shellExec: vi.fn().mockResolvedValue({ stdout: "abc123sha\n", stderr: "" }),
}));

describe("parseImprovementList", () => {
  it("parses JSON array into improvement items", () => {
    const json = `[{"title":"Add tests","description":"Unit tests for X","priority":1},{"title":"Refactor Y"}]`;
    const items = parseImprovementList(json);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ title: "Add tests", description: "Unit tests for X", priority: 1 });
    expect(items[1]).toEqual({ title: "Refactor Y", description: undefined, priority: undefined });
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
      content: '[{"title":"Improve error handling","description":"Add try/catch"}]',
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

  it("runs one general review when reviewAngles is empty", async () => {
    const { agentService } = await import("../services/agent.service.js");
    const service = new SelfImprovementRunnerService();

    await service.runSelfImprovement(projectId);

    expect(agentService.invokePlanningAgent).toHaveBeenCalledTimes(1);
    expect(agentService.invokePlanningAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        tracking: expect.objectContaining({ label: "Self-improvement (General)" }),
      })
    );
  });

  it("runs one review per lens when reviewAngles is set", async () => {
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
    vi.mocked(agentService.invokePlanningAgent).mockResolvedValue({
      content: '[{"title":"Item"}]',
    } as never);

    await service.runSelfImprovement(projectId);

    expect(agentService.invokePlanningAgent).toHaveBeenCalledTimes(2);
    const labels = vi.mocked(agentService.invokePlanningAgent).mock.calls.map(
      (c) => (c[0].tracking as { label: string }).label
    );
    expect(labels).toContain("Self-improvement (Security implications)");
    expect(labels).toContain("Self-improvement (Performance impact)");
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
    vi.mocked(agentService.invokePlanningAgent).mockRejectedValueOnce(new Error("Agent timeout"));

    const service = new SelfImprovementRunnerService();
    await service.runSelfImprovement(projectId);

    expect(taskStore.create).toHaveBeenCalledWith(
      projectId,
      "Self-improvement (Security implications): run failed",
      expect.objectContaining({
        description: "Agent timeout",
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
    const securityError =
      "Security command failed: Security process exited with code: 45";
    vi.mocked(agentService.invokePlanningAgent).mockRejectedValueOnce(
      new Error(securityError)
    );

    const service = new SelfImprovementRunnerService();
    await service.runSelfImprovement(projectId);

    expect(taskStore.create).toHaveBeenCalledWith(
      projectId,
      "Self-improvement (Validating test coverage): run failed",
      expect.objectContaining({
        description: securityError,
        extra: expect.objectContaining({ source: "self-improvement" }),
      })
    );
    expect(updateSettingsInStore).not.toHaveBeenCalled();
  });

  it("does not update lastRunAt when all Reviewer invocations fail", async () => {
    const { agentService } = await import("../services/agent.service.js");
    const { updateSettingsInStore } = await import("../services/settings-store.service.js");
    vi.mocked(agentService.invokePlanningAgent).mockRejectedValue(new Error("timeout"));

    const service = new SelfImprovementRunnerService();
    const result = await service.runSelfImprovement(projectId);

    expect(result).toMatchObject({ tasksCreated: 1, runId: expect.any(String) });
    expect(updateSettingsInStore).not.toHaveBeenCalled();
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

    resolveAgent!({ content: '[{"title":"One"}]' });
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
      content: '[{"title":"One"}]',
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

    resolveAgent!({ content: '[{"title":"One"}]' });
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
      content: '[{"title":"One"}]',
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
      content: '[{"title":"Task A"}]',
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
