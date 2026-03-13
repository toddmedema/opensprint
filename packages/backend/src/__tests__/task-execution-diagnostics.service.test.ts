import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, TaskLastExecutionSummary } from "@opensprint/shared";
import { TaskExecutionDiagnosticsService } from "../services/task-execution-diagnostics.service.js";

const mockReadForTask = vi.fn();

vi.mock("../services/event-log.service.js", () => ({
  eventLogService: {
    readForTask: (...args: unknown[]) => mockReadForTask(...args),
  },
}));

describe("TaskExecutionDiagnosticsService", () => {
  const projectId = "proj-1";
  const taskId = "os-eeac.39";
  const repoPath = "/tmp/repo";
  const lastExecutionSummary: TaskLastExecutionSummary = {
    at: "2026-03-01T17:04:21.000Z",
    attempt: 6,
    outcome: "blocked",
    phase: "merge",
    blockReason: "Merge Failure",
    summary:
      "Attempt 6 merge failed during merge_to_main: Command failed: git -c core.editor=true rebase --continue fatal: no rebase in progress",
  };

  const taskStore = {
    show: vi.fn().mockResolvedValue({
      id: taskId,
      status: "blocked",
      labels: ["attempts:6", "merge_stage:merge_to_main"],
      block_reason: "Merge Failure",
      last_execution_summary: lastExecutionSummary,
    }),
    getCumulativeAttemptsFromIssue: vi.fn().mockReturnValue(6),
  };

  const sessionManager = {
    listSessions: vi.fn().mockResolvedValue([
      {
        taskId,
        attempt: 1,
        agentType: "openai",
        agentModel: "gpt-5.3-codex",
        startedAt: "2026-03-01T16:08:24.000Z",
        completedAt: "2026-03-01T16:08:26.000Z",
        status: "failed",
        outputLog:
          "[Agent error: 404 This is not a chat model and thus not supported in the v1/chat/completions endpoint.]",
        gitBranch: "opensprint/os-eeac.39",
        gitDiff: null,
        testResults: null,
        failureReason:
          "The coding agent stopped without reporting whether the task succeeded or failed. Recent agent output: 404 This is not a chat model and thus not supported in the v1/chat/completions endpoint.",
      },
    ] satisfies AgentSession[]),
  };

  const projectService = {
    getProject: vi.fn().mockResolvedValue({ id: projectId, repoPath }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    taskStore.show.mockResolvedValue({
      id: taskId,
      status: "blocked",
      labels: ["attempts:6", "merge_stage:merge_to_main"],
      block_reason: "Merge Failure",
      last_execution_summary: lastExecutionSummary,
    });
    taskStore.getCumulativeAttemptsFromIssue.mockReturnValue(6);
    sessionManager.listSessions.mockResolvedValue([
      {
        taskId,
        attempt: 1,
        agentType: "openai",
        agentModel: "gpt-5.3-codex",
        startedAt: "2026-03-01T16:08:24.000Z",
        completedAt: "2026-03-01T16:08:26.000Z",
        status: "failed",
        outputLog:
          "[Agent error: 404 This is not a chat model and thus not supported in the v1/chat/completions endpoint.]",
        gitBranch: "opensprint/os-eeac.39",
        gitDiff: null,
        testResults: null,
        failureReason:
          "The coding agent stopped without reporting whether the task succeeded or failed. Recent agent output: 404 This is not a chat model and thus not supported in the v1/chat/completions endpoint.",
      },
    ] satisfies AgentSession[]);
    mockReadForTask.mockResolvedValue([
      {
        timestamp: "2026-03-01T16:08:20.000Z",
        projectId,
        taskId,
        event: "transition.start_task",
        data: { attempt: 1 },
      },
      {
        timestamp: "2026-03-01T16:08:24.000Z",
        projectId,
        taskId,
        event: "agent.spawned",
        data: { attempt: 1, phase: "coding", model: "gpt-5.3-codex" },
      },
      {
        timestamp: "2026-03-01T16:08:26.000Z",
        projectId,
        taskId,
        event: "task.failed",
        data: {
          attempt: 1,
          phase: "coding",
          failureType: "no_result",
          summary:
            "Coding failed: The coding agent stopped without reporting whether the task succeeded or failed. Recent agent output: 404 This is not a chat model",
          nextAction: "Requeued for retry",
        },
      },
      {
        timestamp: "2026-03-01T17:04:21.000Z",
        projectId,
        taskId,
        event: "merge.failed",
        data: {
          attempt: 6,
          stage: "merge_to_main",
          resolvedBy: "blocked",
          summary:
            "Attempt 6 merge failed during merge_to_main: Command failed: git -c core.editor=true rebase --continue fatal: no rebase in progress",
          conflictedFiles: [],
          nextAction: "Blocked pending investigation",
        },
      },
    ]);
  });

  it("reconstructs attempt history and latest blocked merge summary", async () => {
    const service = new TaskExecutionDiagnosticsService(
      projectService as never,
      taskStore as never,
      sessionManager as never
    );

    const diagnostics = await service.getDiagnostics(projectId, taskId);

    expect(projectService.getProject).toHaveBeenCalledWith(projectId);
    expect(taskStore.show).toHaveBeenCalledWith(projectId, taskId);
    expect(diagnostics.blockReason).toBe("Merge Failure");
    expect(diagnostics.cumulativeAttempts).toBe(6);
    expect(diagnostics.latestOutcome).toBe("blocked");
    expect(diagnostics.latestSummary).toContain("merge failed during merge_to_main");
    expect((diagnostics as { latestQualityGateDetail?: unknown }).latestQualityGateDetail).toBe(
      undefined
    );
    expect(diagnostics.attempts[0]).toEqual(
      expect.objectContaining({
        attempt: 6,
        finalPhase: "merge",
        finalOutcome: "blocked",
      })
    );
    expect(diagnostics.attempts.at(-1)).toEqual(
      expect.objectContaining({
        attempt: 1,
        finalPhase: "coding",
        finalOutcome: "failed",
      })
    );
  });

  it("prefers actionable quality-gate merge summaries when structured fields exist", async () => {
    taskStore.show.mockResolvedValue({
      id: taskId,
      status: "open",
      labels: ["attempts:2", "merge_stage:quality_gate"],
      block_reason: null,
      last_execution_summary: null,
    });
    taskStore.getCumulativeAttemptsFromIssue.mockReturnValue(2);
    sessionManager.listSessions.mockResolvedValue([]);
    mockReadForTask.mockResolvedValue([
      {
        timestamp: "2026-03-02T12:00:00.000Z",
        projectId,
        taskId,
        event: "merge.failed",
        data: {
          attempt: 2,
          stage: "quality_gate",
          resolvedBy: "requeued",
          summary: "Attempt 2 quality-gate failed: Pre-merge quality gates failed",
          qualityGateCategory: "environment_setup",
          failedGateCommand: "npm run build",
          failedGateReason: "Command failed with exit code 1",
          failedGateOutputSnippet: "Cannot find module 'better-sqlite3'",
          worktreePath: "/tmp/worktree/os-eeac.39",
          qualityGateFirstErrorLine: "Cannot find module 'better-sqlite3'",
          qualityGateAutoRepairAttempted: true,
          qualityGateAutoRepairSucceeded: false,
          qualityGateAutoRepairCommands: ["npm ci", "npm install"],
          nextAction: "Requeued for retry",
        },
      },
    ]);

    const service = new TaskExecutionDiagnosticsService(
      projectService as never,
      taskStore as never,
      sessionManager as never
    );

    const diagnostics = await service.getDiagnostics(projectId, taskId);
    const diagnosticsQualityGate = diagnostics as {
      latestQualityGateDetail?: unknown;
      timeline: Array<{ qualityGateDetail?: unknown }>;
      attempts: Array<{ qualityGateDetail?: unknown }>;
    };

    expect(diagnostics.latestSummary).toContain("npm run build: Cannot find module");
    expect(diagnostics.latestSummary).toContain("repair: npm ci -> npm install (failed)");
    expect(diagnostics.latestSummary).toContain("category: environment_setup");
    expect(diagnosticsQualityGate.latestQualityGateDetail).toEqual({
      command: "npm run build",
      reason: "Command failed with exit code 1",
      outputSnippet: "Cannot find module 'better-sqlite3'",
      worktreePath: "/tmp/worktree/os-eeac.39",
      firstErrorLine: "Cannot find module 'better-sqlite3'",
    });
    expect(diagnosticsQualityGate.timeline[0]?.qualityGateDetail).toEqual({
      command: "npm run build",
      reason: "Command failed with exit code 1",
      outputSnippet: "Cannot find module 'better-sqlite3'",
      worktreePath: "/tmp/worktree/os-eeac.39",
      firstErrorLine: "Cannot find module 'better-sqlite3'",
    });
    expect(diagnosticsQualityGate.attempts[0]?.qualityGateDetail).toEqual({
      command: "npm run build",
      reason: "Command failed with exit code 1",
      outputSnippet: "Cannot find module 'better-sqlite3'",
      worktreePath: "/tmp/worktree/os-eeac.39",
      firstErrorLine: "Cannot find module 'better-sqlite3'",
    });
  });

  it("falls back to command + reason when quality-gate output snippet and firstErrorLine are missing", async () => {
    taskStore.show.mockResolvedValue({
      id: taskId,
      status: "open",
      labels: ["attempts:5", "merge_stage:quality_gate"],
      block_reason: null,
      last_execution_summary: null,
    });
    taskStore.getCumulativeAttemptsFromIssue.mockReturnValue(5);
    sessionManager.listSessions.mockResolvedValue([]);
    mockReadForTask.mockResolvedValue([
      {
        timestamp: "2026-03-02T12:00:00.000Z",
        projectId,
        taskId,
        event: "merge.failed",
        data: {
          attempt: 5,
          stage: "quality_gate",
          resolvedBy: "requeued",
          qualityGateCategory: "quality_gate",
          failedGateCommand: "npm run build",
          failedGateReason: "Command failed with exit code 1",
          nextAction: "Requeued for retry",
        },
      },
    ]);

    const service = new TaskExecutionDiagnosticsService(
      projectService as never,
      taskStore as never,
      sessionManager as never
    );

    const diagnostics = await service.getDiagnostics(projectId, taskId);
    const diagnosticsQualityGate = diagnostics as {
      latestQualityGateDetail?: unknown;
    };

    expect(diagnostics.latestSummary).toContain("npm run build: Command failed with exit code 1");
    expect(diagnosticsQualityGate.latestQualityGateDetail).toEqual({
      command: "npm run build",
      reason: "Command failed with exit code 1",
      outputSnippet: null,
      worktreePath: null,
      firstErrorLine: "Command failed with exit code 1",
    });
  });

  it("prefers the latest execution failure detail over stale task-level gate metadata after requeue", async () => {
    taskStore.show.mockResolvedValue({
      id: taskId,
      status: "open",
      labels: ["attempts:3"],
      block_reason: null,
      last_execution_summary: null,
      failedGateCommand: "npm run build",
      failedGateReason: "Command failed with exit code 1",
      failedGateOutputSnippet: "stale build error",
      worktreePath: "/tmp/worktree/stale",
      qualityGateDetail: {
        command: "npm run build",
        reason: "Command failed with exit code 1",
        outputSnippet: "stale build error",
        worktreePath: "/tmp/worktree/stale",
        firstErrorLine: "stale build error",
      },
    });
    taskStore.getCumulativeAttemptsFromIssue.mockReturnValue(3);
    sessionManager.listSessions.mockResolvedValue([]);
    mockReadForTask.mockResolvedValue([
      {
        timestamp: "2026-03-03T08:00:00.000Z",
        projectId,
        taskId,
        event: "transition.start_task",
        data: { attempt: 3 },
      },
      {
        timestamp: "2026-03-03T08:01:00.000Z",
        projectId,
        taskId,
        event: "task.failed",
        data: {
          attempt: 3,
          phase: "coding",
          failureType: "test_failure",
          summary: "Coding failed: Tests failed: 1 failed, 0 passed",
          nextAction: "Requeued for retry",
          failedGateCommand: "node ./node_modules/vitest/vitest.mjs run src/foo.test.ts",
          failedGateReason: "Tests failed: 1 failed, 0 passed",
          failedGateOutputSnippet:
            "FAIL src/foo.test.ts > auth > rejects invalid token\nAssertionError: expected 401 to be 403 // Object.is equality",
          firstErrorLine: "AssertionError: expected 401 to be 403 // Object.is equality",
          worktreePath: "/tmp/worktree/os-eeac.39",
          qualityGateDetail: {
            command: "node ./node_modules/vitest/vitest.mjs run src/foo.test.ts",
            reason: "Tests failed: 1 failed, 0 passed",
            outputSnippet:
              "FAIL src/foo.test.ts > auth > rejects invalid token\nAssertionError: expected 401 to be 403 // Object.is equality",
            worktreePath: "/tmp/worktree/os-eeac.39",
            firstErrorLine: "AssertionError: expected 401 to be 403 // Object.is equality",
          },
        },
      },
      {
        timestamp: "2026-03-03T08:01:05.000Z",
        projectId,
        taskId,
        event: "task.requeued",
        data: {
          attempt: 3,
          phase: "coding",
          failureType: "test_failure",
          summary: "Coding failed: Tests failed: 1 failed, 0 passed. Requeued for retry",
          nextAction: "Requeued for retry",
        },
      },
    ]);

    const service = new TaskExecutionDiagnosticsService(
      projectService as never,
      taskStore as never,
      sessionManager as never
    );

    const diagnostics = await service.getDiagnostics(projectId, taskId);
    const diagnosticsQualityGate = diagnostics as {
      latestQualityGateDetail?: unknown;
      timeline: Array<{ qualityGateDetail?: unknown }>;
      attempts: Array<{ qualityGateDetail?: unknown; finalSummary: string }>;
    };

    expect(diagnostics.latestSummary).toContain(
      "node ./node_modules/vitest/vitest.mjs run src/foo.test.ts: AssertionError: expected 401 to be 403"
    );
    expect(diagnostics.latestSummary).not.toContain("stale build error");
    expect(diagnosticsQualityGate.latestQualityGateDetail).toEqual({
      command: "node ./node_modules/vitest/vitest.mjs run src/foo.test.ts",
      reason: "Tests failed: 1 failed, 0 passed",
      outputSnippet:
        "FAIL src/foo.test.ts > auth > rejects invalid token\nAssertionError: expected 401 to be 403 // Object.is equality",
      worktreePath: "/tmp/worktree/os-eeac.39",
      firstErrorLine: "AssertionError: expected 401 to be 403 // Object.is equality",
    });
    expect(diagnosticsQualityGate.timeline.at(-1)?.qualityGateDetail).toBeUndefined();
    expect(diagnosticsQualityGate.attempts[0]?.qualityGateDetail).toEqual({
      command: "node ./node_modules/vitest/vitest.mjs run src/foo.test.ts",
      reason: "Tests failed: 1 failed, 0 passed",
      outputSnippet:
        "FAIL src/foo.test.ts > auth > rejects invalid token\nAssertionError: expected 401 to be 403 // Object.is equality",
      worktreePath: "/tmp/worktree/os-eeac.39",
      firstErrorLine: "AssertionError: expected 401 to be 403 // Object.is equality",
    });
    expect(diagnosticsQualityGate.attempts[0]?.finalSummary).toContain(
      "node ./node_modules/vitest/vitest.mjs run src/foo.test.ts: AssertionError: expected 401 to be 403"
    );
  });

  it("surfaces running tool-wait diagnostics for active attempts", async () => {
    taskStore.show.mockResolvedValue({
      id: taskId,
      status: "in_progress",
      labels: ["attempts:6"],
      block_reason: null,
      last_execution_summary: null,
    });
    sessionManager.listSessions.mockResolvedValue([]);
    mockReadForTask.mockResolvedValue([
      {
        timestamp: "2026-03-02T10:00:00.000Z",
        projectId,
        taskId,
        event: "transition.start_task",
        data: { attempt: 6 },
      },
      {
        timestamp: "2026-03-02T10:02:00.000Z",
        projectId,
        taskId,
        event: "agent.waiting_on_tool",
        data: {
          attempt: 6,
          phase: "coding",
          summary: "npm test -- --runInBand",
        },
      },
    ]);

    const service = new TaskExecutionDiagnosticsService(
      projectService as never,
      taskStore as never,
      sessionManager as never
    );

    const diagnostics = await service.getDiagnostics(projectId, taskId);

    expect(diagnostics.latestOutcome).toBe("running");
    expect(diagnostics.latestSummary).toContain("waiting on npm test");
    expect(diagnostics.latestNextAction).toBe("Awaiting tool completion");
    expect(diagnostics.timeline.at(-1)).toEqual(
      expect.objectContaining({
        phase: "coding",
        outcome: "running",
        title: "Waiting on tool",
      })
    );
  });

  it("surfaces suspended and resumed diagnostics for recoverable interruptions", async () => {
    taskStore.show.mockResolvedValue({
      id: taskId,
      status: "in_progress",
      labels: ["attempts:6"],
      block_reason: null,
      last_execution_summary: null,
    });
    sessionManager.listSessions.mockResolvedValue([]);
    mockReadForTask.mockResolvedValue([
      {
        timestamp: "2026-03-02T10:00:00.000Z",
        projectId,
        taskId,
        event: "transition.start_task",
        data: { attempt: 6 },
      },
      {
        timestamp: "2026-03-02T10:10:00.000Z",
        projectId,
        taskId,
        event: "agent.suspended",
        data: {
          attempt: 6,
          phase: "coding",
          reason: "heartbeat_gap",
          summary: "Heartbeat gap after host sleep or backend pause",
        },
      },
      {
        timestamp: "2026-03-02T10:12:00.000Z",
        projectId,
        taskId,
        event: "agent.resumed",
        data: {
          attempt: 6,
          phase: "coding",
          reason: "heartbeat_gap",
          summary: "Agent output resumed after reconnect",
        },
      },
    ]);

    const service = new TaskExecutionDiagnosticsService(
      projectService as never,
      taskStore as never,
      sessionManager as never
    );

    const diagnostics = await service.getDiagnostics(projectId, taskId);

    expect(diagnostics.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "coding",
          outcome: "suspended",
          title: "Coding suspended",
        }),
        expect.objectContaining({
          phase: "coding",
          outcome: "running",
          title: "Coding resumed",
        }),
      ])
    );
    expect(diagnostics.latestOutcome).toBe("running");
    expect(diagnostics.latestSummary).toContain("resumed after reconnect");
  });
});
