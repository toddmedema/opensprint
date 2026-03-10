import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SelfImprovementService,
  type SelfImprovementRunResult,
} from "../services/self-improvement.service.js";

vi.mock("../services/project.service.js", () => ({
  ProjectService: vi.fn().mockImplementation(() => ({
    getProject: vi.fn().mockResolvedValue({ id: "proj-1", repoPath: "/tmp/repo" }),
    getSettings: vi.fn().mockResolvedValue({
      selfImprovementLastRunAt: undefined,
      selfImprovementLastCommitSha: undefined,
      worktreeBaseBranch: "main",
    }),
  })),
}));

vi.mock("../services/self-improvement-change-detection.js", () => ({
  hasCodeChangesSince: vi.fn().mockResolvedValue(true),
}));

vi.mock("../services/task-store.service.js", () => ({
  taskStore: {
    create: vi.fn().mockResolvedValue({ id: "os-1", title: "Task" }),
  },
}));

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokePlanningAgent: vi.fn().mockResolvedValue({
      content: '[{"title":"Add tests","description":"Unit tests for X"}]',
    }),
  },
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

describe("SelfImprovementService", () => {
  const projectId = "proj-1";
  let service: SelfImprovementService;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { hasCodeChangesSince } = await import("../services/self-improvement-change-detection.js");
    vi.mocked(hasCodeChangesSince).mockResolvedValue(true);
    service = new SelfImprovementService();
  });

  describe("change detection gate", () => {
    it("returns skipped no_changes when repo has not changed since last run", async () => {
      const { hasCodeChangesSince } = await import("../services/self-improvement-change-detection.js");
      const { taskStore } = await import("../services/task-store.service.js");
      vi.mocked(hasCodeChangesSince).mockResolvedValue(false);

      const result = await service.run(projectId);

      expect(result).toEqual({ tasksCreated: 0, skipped: "no_changes" });
      expect(taskStore.create).not.toHaveBeenCalled();
    });

    it("passes baseBranch from settings to hasCodeChangesSince", async () => {
      const { ProjectService } = await import("../services/project.service.js");
      const { hasCodeChangesSince } = await import("../services/self-improvement-change-detection.js");
      vi.mocked(ProjectService).mockImplementation(
        () =>
          ({
            getProject: vi.fn().mockResolvedValue({ id: "proj-1", repoPath: "/tmp/repo" }),
            getSettings: vi.fn().mockResolvedValue({
              selfImprovementLastRunAt: "2025-01-01T00:00:00Z",
              selfImprovementLastCommitSha: "abc123",
              worktreeBaseBranch: "develop",
            }),
          }) as never
      );
      service = new SelfImprovementService();

      await service.run(projectId);

      expect(hasCodeChangesSince).toHaveBeenCalledWith("/tmp/repo", {
        sinceTimestamp: "2025-01-01T00:00:00Z",
        sinceCommitSha: "abc123",
        baseBranch: "develop",
      });
    });
  });

  describe("delegation to runner", () => {
    it("calls runner and returns its result when repo has changed", async () => {
      const { taskStore } = await import("../services/task-store.service.js");
      vi.mocked(taskStore.create).mockResolvedValue({ id: "os-1", title: "Task" } as never);

      const result = await service.run(projectId, { planId: "plan-1", runId: "si-456" });

      expect(result).toMatchObject({ tasksCreated: 1, runId: expect.any(String) });
      expect(taskStore.create).toHaveBeenCalled();
    });

    it("creates tasks with source self-improvement and optional planId/runId (mocked Reviewer)", async () => {
      const { taskStore } = await import("../services/task-store.service.js");

      await service.run(projectId, { planId: "plan-1", runId: "int-run-1" });

      expect(taskStore.create).toHaveBeenCalledWith(
        projectId,
        "Add tests",
        expect.objectContaining({
          description: "Unit tests for X",
          extra: expect.objectContaining({
            source: "self-improvement",
            runId: "int-run-1",
            planId: "plan-1",
          }),
        })
      );
    });
  });

  describe("run_in_progress", () => {
    it("returns runner result when runner skips due to run in progress", async () => {
      const runnerMod = await import("../services/self-improvement-runner.service.js");
      const spy = vi.spyOn(runnerMod, "runSelfImprovement").mockResolvedValueOnce({
        tasksCreated: 0,
        skipped: "run_in_progress",
      });

      const result: SelfImprovementRunResult = await service.run(projectId);

      expect(result).toEqual({ tasksCreated: 0, skipped: "run_in_progress" });
      expect(spy).toHaveBeenCalledWith(projectId, undefined);
      spy.mockRestore();
    });
  });

  describe("runIfDue", () => {
    it("returns frequency_not_due and does not run when frequency is never", async () => {
      const { ProjectService } = await import("../services/project.service.js");
      const runnerMod = await import("../services/self-improvement-runner.service.js");
      const runSpy = vi.spyOn(runnerMod, "runSelfImprovement");
      vi.mocked(ProjectService).mockImplementation(
        () =>
          ({
            getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath: "/tmp/repo" }),
            getSettings: vi.fn().mockResolvedValue({
              selfImprovementFrequency: "never",
              selfImprovementLastRunAt: undefined,
              worktreeBaseBranch: "main",
            }),
          }) as never
      );
      service = new SelfImprovementService();

      const result = await service.runIfDue(projectId, {
        trigger: "after_each_plan",
        planId: "plan-1",
      });

      expect(result).toEqual({ tasksCreated: 0, skipped: "frequency_not_due" });
      expect(runSpy).not.toHaveBeenCalled();
      runSpy.mockRestore();
    });

    it("calls run and returns its result when frequency is after_each_plan and changes exist", async () => {
      const { ProjectService } = await import("../services/project.service.js");
      const { taskStore } = await import("../services/task-store.service.js");
      vi.mocked(ProjectService).mockImplementation(
        () =>
          ({
            getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath: "/tmp/repo" }),
            getSettings: vi.fn().mockResolvedValue({
              selfImprovementFrequency: "after_each_plan",
              selfImprovementLastRunAt: undefined,
              worktreeBaseBranch: "main",
            }),
          }) as never
      );
      service = new SelfImprovementService();
      vi.mocked(taskStore.create).mockResolvedValue({ id: "os-1", title: "Task" } as never);

      const result = await service.runIfDue(projectId, {
        trigger: "after_each_plan",
        planId: "plan-1",
      });

      expect(result).toMatchObject({ tasksCreated: 1, runId: expect.any(String) });
      expect(taskStore.create).toHaveBeenCalled();
    });
  });
});
