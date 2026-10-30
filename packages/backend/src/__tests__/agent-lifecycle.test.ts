import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { AgentLifecycleManager } from "../services/agent-lifecycle.js";
import type { AgentRunState, AgentRunParams } from "../services/agent-lifecycle.js";
import { TimerRegistry } from "../services/timer-registry.js";
import { AGENT_INACTIVITY_TIMEOUT_MS, AGENT_SUSPEND_GRACE_MS } from "@opensprint/shared";
import {
  acquireGlobalAgentSlot,
  trackExistingGlobalAgentSlot,
} from "../services/agent-global-concurrency.service.js";

const SUSPEND_TRANSITION_DELAY_MS = 60_000;

const mockInvokeCodingAgent = vi.fn();
const mockInvokeReviewAgent = vi.fn();
const mockWriteHeartbeat = vi.fn().mockResolvedValue(undefined);
const mockDeleteHeartbeat = vi.fn().mockResolvedValue(undefined);
const mockBroadcastToProject = vi.fn();
const mockSendAgentOutputToProject = vi.fn();
const mockCommitWip = vi.fn().mockResolvedValue(undefined);
const mockAppendEvent = vi.fn().mockResolvedValue(undefined);

vi.mock("../services/agent.service.js", () => ({
  agentService: {
    invokeCodingAgent: (...args: unknown[]) => mockInvokeCodingAgent(...args),
    invokeReviewAgent: (...args: unknown[]) => mockInvokeReviewAgent(...args),
  },
}));

vi.mock("../services/heartbeat.service.js", () => ({
  heartbeatService: {
    writeHeartbeat: (...args: unknown[]) => mockWriteHeartbeat(...args),
    deleteHeartbeat: (...args: unknown[]) => mockDeleteHeartbeat(...args),
  },
}));

vi.mock("../services/event-log.service.js", () => ({
  eventLogService: {
    append: (...args: unknown[]) => mockAppendEvent(...args),
  },
}));

vi.mock("../websocket/index.js", () => ({
  broadcastToProject: (...args: unknown[]) => mockBroadcastToProject(...args),
  sendAgentOutputToProject: (...args: unknown[]) => mockSendAgentOutputToProject(...args),
}));

vi.mock("../services/branch-manager.js", () => ({
  BranchManager: vi.fn().mockImplementation(() => ({
    commitWip: (...args: unknown[]) => mockCommitWip(...args),
  })),
}));

vi.mock("../services/agent-global-concurrency.service.js", () => ({
  acquireGlobalAgentSlot: vi.fn().mockResolvedValue(() => {}),
  trackExistingGlobalAgentSlot: vi.fn(() => () => {}),
}));

describe("AgentLifecycleManager", () => {
  let manager: AgentLifecycleManager;
  let timers: TimerRegistry;
  let runState: AgentRunState;

  const baseParams: AgentRunParams = {
    projectId: "proj-1",
    taskId: "task-1",
    repoPath: "/tmp/repo",
    phase: "coding",
    wtPath: "/tmp/repo",
    branchName: "main",
    promptPath: "/tmp/repo/.opensprint/active/task-1/prompt.md",
    agentConfig: { type: "cursor", model: "gpt-4" },
    attempt: 1,
    agentLabel: "Coder",
    role: "coder",
    onDone: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.mocked(acquireGlobalAgentSlot).mockResolvedValue(() => {});
    manager = new AgentLifecycleManager();
    timers = new TimerRegistry();
    runState = {
      activeProcess: null,
      lastOutputTime: 0,
      lastOutputAtIso: undefined,
      outputLog: [],
      outputLogBytes: 0,
      outputParseBuffer: "",
      activeToolCallIds: new Set<string>(),
      activeToolCallSummaries: new Map<string, string | null>(),
      activeToolCallStartedAtMs: new Map<string, number>(),
      startedAt: "",
      firstOutputAtIso: undefined,
      exitHandled: false,
      killedDueToTimeout: false,
      lifecycleState: "running",
      suspendedAtIso: undefined,
      suspendReason: undefined,
      suspendDeadlineMs: undefined,
    };

    const mockHandle = {
      kill: vi.fn(),
      pid: 9999,
    };

    mockInvokeCodingAgent.mockImplementation(
      (_path: string, _config: unknown, _options: { onExit?: (code: number | null) => void }) => {
        return mockHandle;
      }
    );

    mockInvokeReviewAgent.mockImplementation(
      (_path: string, _config: unknown, _options: { onExit?: (code: number | null) => void }) => {
        return mockHandle;
      }
    );
  });

  afterEach(() => {
    timers.clearAll();
    vi.useRealTimers();
  });

  describe("run", () => {
    it("never starts work for a slot removed before run was entered", async () => {
      runState.cancelled = true;
      await manager.run(baseParams, runState, timers);
      expect(acquireGlobalAgentSlot).not.toHaveBeenCalled();
      expect(mockInvokeCodingAgent).not.toHaveBeenCalled();
    });

    it("revalidates owning slot identity after queued admission", async () => {
      let admit!: (release: () => void) => void;
      let ownsSlot = true;
      const release = vi.fn();
      vi.mocked(acquireGlobalAgentSlot).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            admit = resolve;
          })
      );
      const running = manager.run(
        { ...baseParams, isStillActive: () => ownsSlot },
        runState,
        timers
      );
      ownsSlot = false;
      admit(release);
      await running;
      expect(mockInvokeCodingAgent).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
    });

    it("notifies review coordination when an individually killed queued reviewer is cancelled", async () => {
      vi.mocked(acquireGlobalAgentSlot).mockImplementationOnce(
        (_projectId, signal) =>
          new Promise((_resolve, reject) =>
            signal!.addEventListener("abort", () => reject(signal!.reason))
          )
      );
      const running = manager.run({ ...baseParams, role: "reviewer" }, runState, timers);
      runState.runner!.cancel(true);
      await running;
      expect(mockInvokeReviewAgent).not.toHaveBeenCalled();
      expect(baseParams.onDone).toHaveBeenCalledOnce();
      expect(baseParams.onDone).toHaveBeenCalledWith(null);
    });

    it("does not spawn a queued invocation after cancellation even if admission resolves", async () => {
      let admit!: (release: () => void) => void;
      const release = vi.fn();
      vi.mocked(acquireGlobalAgentSlot).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            admit = resolve;
          })
      );
      const running = manager.run(baseParams, runState, timers);
      runState.activeProcess!.kill();
      expect(runState.runner?.observe().state).toBe("stopped");
      admit(release);
      await running;
      expect(mockInvokeCodingAgent).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledOnce();
      expect(baseParams.onDone).not.toHaveBeenCalled();
      expect(timers.has("heartbeat")).toBe(false);
    });

    it("ignores output and exit callbacks from an earlier invocation generation", async () => {
      const callbacks: Array<{
        onOutput: (chunk: string) => void;
        onExit: (code: number | null) => Promise<void>;
      }> = [];
      mockInvokeCodingAgent.mockImplementation((_path, _config, options) => {
        callbacks.push(options);
        return { kill: vi.fn(), pid: null };
      });
      await manager.run(baseParams, runState, timers);
      const firstId = runState.attemptId;
      await manager.run({ ...baseParams, attempt: 2 }, runState, timers);
      expect(runState.attemptId).not.toBe(firstId);
      callbacks[0].onOutput("stale output\n");
      await callbacks[0].onExit(1);
      expect(runState.exitHandled).toBe(false);
      expect(runState.outputLog).toEqual([]);
      expect(baseParams.onDone).not.toHaveBeenCalled();
      expect(timers.has("heartbeat")).toBe(true);
      await callbacks[1].onExit(0);
      expect(baseParams.onDone).toHaveBeenCalledOnce();
    });

    it("does not install monitors or retain a handle after synchronous process exit", async () => {
      mockInvokeCodingAgent.mockImplementation((_path, _config, options) => {
        void options.onExit(0);
        return { kill: vi.fn(), pid: null };
      });
      await manager.run(baseParams, runState, timers);
      await Promise.resolve();
      expect(runState.activeProcess).toBeNull();
      expect(runState.exitHandled).toBe(true);
      expect(timers.has("heartbeat")).toBe(false);
      expect(baseParams.onDone).toHaveBeenCalledOnce();
    });

    it("spawns coder agent and initializes run state", async () => {
      await manager.run(baseParams, runState, timers);

      expect(mockInvokeCodingAgent).toHaveBeenCalled();
      expect(mockInvokeCodingAgent).toHaveBeenCalledWith(
        baseParams.promptPath,
        baseParams.agentConfig,
        expect.objectContaining({
          tracking: expect.objectContaining({
            id: "task-1",
            projectId: "proj-1",
            phase: "coding",
            role: "coder",
            label: "Coder",
            branchName: "main",
          }),
        })
      );
      expect(mockInvokeReviewAgent).not.toHaveBeenCalled();
      expect(runState.activeProcess).not.toBeNull();
      expect(runState.startedAt).toBeTruthy();
      expect(runState.outputLog).toEqual([]);
      expect(runState.exitHandled).toBe(false);
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          type: "agent.started",
          taskId: "task-1",
          phase: "coding",
        })
      );
      expect(timers.has("heartbeat")).toBe(true);
      expect(timers.has("inactivity")).toBe(true);
      expect(mockWriteHeartbeat).toHaveBeenCalledWith(
        "/tmp/repo",
        "task-1",
        expect.objectContaining({
          processGroupLeaderPid: 9999,
        }),
        undefined
      );
    });

    it("spawns reviewer agent when role is reviewer", async () => {
      await manager.run({ ...baseParams, role: "reviewer" }, runState, timers);

      expect(mockInvokeReviewAgent).toHaveBeenCalled();
      expect(mockInvokeCodingAgent).not.toHaveBeenCalled();
    });

    it("fails fast when promptPath is outside the task worktree layout", async () => {
      await expect(
        manager.run(
          {
            ...baseParams,
            wtPath: "/tmp/repo-a",
            promptPath: "/tmp/repo-b/.opensprint/active/task-1/prompt.md",
          },
          runState,
          timers
        )
      ).rejects.toThrow("Prompt path does not match task worktree layout");

      expect(mockInvokeCodingAgent).not.toHaveBeenCalled();
      expect(mockInvokeReviewAgent).not.toHaveBeenCalled();
    });

    it("preserves startedAt when already set (e.g. by phase-executor before spawn)", async () => {
      const assignmentCreatedAt = "2026-02-16T11:57:00.000Z";
      runState.startedAt = assignmentCreatedAt;

      await manager.run(baseParams, runState, timers);

      expect(runState.startedAt).toBe(assignmentCreatedAt);
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          type: "agent.started",
          startedAt: assignmentCreatedAt,
        })
      );
    });

    it("invokes onDone and cleans up when agent exits via onExit", async () => {
      let capturedOnExit: ((code: number | null) => void) | undefined;
      mockInvokeCodingAgent.mockImplementation(
        (_path: string, _config: unknown, options: { onExit?: (code: number | null) => void }) => {
          capturedOnExit = options.onExit;
          return { kill: vi.fn(), pid: 9999 };
        }
      );

      await manager.run(baseParams, runState, timers);
      expect(baseParams.onDone).not.toHaveBeenCalled();

      await capturedOnExit?.(0);

      expect(baseParams.onDone).toHaveBeenCalledWith(0);
      expect(runState.activeProcess).toBeNull();
      expect(runState.exitHandled).toBe(true);
      expect(mockDeleteHeartbeat).toHaveBeenCalledWith("/tmp/repo", "task-1", undefined);
      expect(timers.has("heartbeat")).toBe(false);
      expect(timers.has("inactivity")).toBe(false);
    });

    it("appends filtered output chunks to runState.outputLog and sends filtered live output", async () => {
      let capturedOnOutput: ((chunk: string) => void) | undefined;
      mockInvokeCodingAgent.mockImplementation(
        (_path: string, _config: unknown, options: { onOutput?: (chunk: string) => void }) => {
          capturedOnOutput = options.onOutput;
          return { kill: vi.fn(), pid: 9999 };
        }
      );

      await manager.run(baseParams, runState, timers);

      // Plain text with newlines is passed through; tool_call and code-context are filtered
      capturedOnOutput?.("chunk1\n");
      capturedOnOutput?.("chunk2\n");

      expect(runState.outputLog).toEqual(["chunk1\n", "chunk2\n"]);
      expect(mockSendAgentOutputToProject).toHaveBeenCalledWith("proj-1", "task-1", "chunk1\n");
      expect(mockSendAgentOutputToProject).toHaveBeenCalledWith("proj-1", "task-1", "chunk2\n");
    });

    it("does not append or send tool_call and code-context noise", async () => {
      let capturedOnOutput: ((chunk: string) => void) | undefined;
      mockInvokeCodingAgent.mockImplementation(
        (_path: string, _config: unknown, options: { onOutput?: (chunk: string) => void }) => {
          capturedOnOutput = options.onOutput;
          return { kill: vi.fn(), pid: 9999 };
        }
      );

      await manager.run(baseParams, runState, timers);

      capturedOnOutput?.('{"type":"text","text":"User message"}\n');
      capturedOnOutput?.(
        '{"type":"tool_call","subtype":"started","call_id":"c1","tool_call":{}}\n'
      );
      capturedOnOutput?.('{"lineNumber":1,"content":"snippet","isContextLine":true}\n');
      capturedOnOutput?.('{"type":"text","text":"Done"}\n');

      const joined = runState.outputLog.join("");
      expect(joined).toContain("User message");
      expect(joined).toContain("Done");
      expect(joined).not.toContain("tool_call");
      expect(joined).not.toContain("lineNumber");
      expect(mockSendAgentOutputToProject).toHaveBeenCalledWith(
        "proj-1",
        "task-1",
        expect.stringContaining("User message")
      );
      expect(mockSendAgentOutputToProject).toHaveBeenCalledWith(
        "proj-1",
        "task-1",
        expect.stringContaining("Done")
      );
    });

    it("does not call onDone twice when onExit is invoked multiple times", async () => {
      let capturedOnExit: ((code: number | null) => void) | undefined;
      mockInvokeCodingAgent.mockImplementation(
        (_path: string, _config: unknown, options: { onExit?: (code: number | null) => void }) => {
          capturedOnExit = options.onExit;
          return { kill: vi.fn(), pid: 9999 };
        }
      );

      await manager.run(baseParams, runState, timers);

      await capturedOnExit?.(0);
      await capturedOnExit?.(1);

      expect(baseParams.onDone).toHaveBeenCalledTimes(1);
    });

    it("finalizes the run when terminal result.json appears even if the agent never exits", async () => {
      vi.useFakeTimers();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-lifecycle-run-"));
      const promptPath = path.join(tmpDir, ".opensprint", "active", "task-1", "prompt.md");
      const onDone = vi.fn().mockResolvedValue(undefined);
      const handle = { kill: vi.fn(), pid: 9999 };
      await fs.mkdir(path.dirname(promptPath), { recursive: true });
      await fs.writeFile(promptPath, "prompt", "utf-8");

      mockInvokeCodingAgent.mockImplementation(() => handle);

      await manager.run(
        {
          ...baseParams,
          repoPath: tmpDir,
          wtPath: tmpDir,
          promptPath,
          onDone,
        },
        runState,
        timers
      );

      await fs.writeFile(
        path.join(path.dirname(promptPath), "result.json"),
        JSON.stringify({ status: "approved" }),
        "utf-8"
      );

      await vi.advanceTimersByTimeAsync(600);
      // Timer callback started fs.readFile (real I/O); yield so it and its .then() run
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 50));

      expect(handle.kill).toHaveBeenCalledTimes(1);
      expect(onDone).toHaveBeenCalledWith(0);
      expect(runState.activeProcess).toBeNull();
      expect(runState.exitHandled).toBe(true);
      expect(mockDeleteHeartbeat).toHaveBeenCalledWith(tmpDir, "task-1", undefined);
    });

    it("does not timeout while a shell tool call is still active", async () => {
      vi.useFakeTimers();
      const handle = { kill: vi.fn(), pid: 9999 };
      let capturedOnOutput: ((chunk: string) => void) | undefined;

      mockInvokeCodingAgent.mockImplementation(
        (_path: string, _config: unknown, options: { onOutput?: (chunk: string) => void }) => {
          capturedOnOutput = options.onOutput;
          return handle;
        }
      );

      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid: number, sig?: number) => {
        if (sig === 0 && pid === 9999) return true;
        return true;
      });

      await manager.run(baseParams, runState, timers);
      capturedOnOutput?.(
        '{"type":"tool_call","subtype":"started","call_id":"call-1","tool_call":{"shellToolCall":{"args":{"command":"npm test"}}}}\n'
      );

      await vi.advanceTimersByTimeAsync(AGENT_INACTIVITY_TIMEOUT_MS + 30_000);

      expect(handle.kill).not.toHaveBeenCalled();
      expect(runState.killedDueToTimeout).toBe(false);
      expect(runState.activeToolCallIds.has("call-1")).toBe(true);

      killSpy.mockRestore();
      vi.useRealTimers();
    });

    it("suspends and eventually times out when a tool call stays active without output", async () => {
      vi.useFakeTimers();
      const handle = { kill: vi.fn(), pid: 9999 };
      let capturedOnOutput: ((chunk: string) => void) | undefined;

      mockInvokeCodingAgent.mockImplementation(
        (_path: string, _config: unknown, options: { onOutput?: (chunk: string) => void }) => {
          capturedOnOutput = options.onOutput;
          return handle;
        }
      );

      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid: number, sig?: number) => {
        if (sig === 0 && pid === 9999) return true;
        return true;
      });

      await manager.run(baseParams, runState, timers);
      runState.lifecycleState = "suspended";
      runState.suspendReason = "output_gap";
      runState.suspendedAtIso = new Date(Date.now() - 5_000).toISOString();
      runState.suspendDeadlineMs = Date.now() + 60_000;
      capturedOnOutput?.(
        '{"type":"tool_call","subtype":"started","call_id":"call-1","tool_call":{"shellToolCall":{"args":{"command":"npm test"}}}}\n'
      );
      await Promise.resolve();
      expect(runState.lifecycleState).toBe("running");

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 5 * 60 * 1000);
      await Promise.resolve();

      expect(runState.lifecycleState).toBe("suspended");
      expect(runState.suspendReason).toBe("output_gap");
      expect(runState.killedDueToTimeout).toBe(false);
      expect(handle.kill).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(AGENT_SUSPEND_GRACE_MS + 30_000);
      await Promise.resolve();

      expect(runState.killedDueToTimeout).toBe(true);
      expect(handle.kill).toHaveBeenCalled();

      killSpy.mockRestore();
      vi.useRealTimers();
    });

    it("kills after the suspend grace expires", async () => {
      vi.useFakeTimers();
      const handle = {
        kill: vi.fn(() => {
          runState.activeProcess = null;
        }),
        pid: 9999,
      };

      mockInvokeCodingAgent.mockImplementation(
        (_path: string, _config: unknown, _options: { onOutput?: (chunk: string) => void }) =>
          handle
      );

      const killSpy = vi.spyOn(process, "kill").mockImplementation((pid: number, sig?: number) => {
        if (sig === 0 && pid === 9999) return true;
        return true;
      });

      await manager.run(baseParams, runState, timers);

      await vi.advanceTimersByTimeAsync(
        AGENT_INACTIVITY_TIMEOUT_MS + SUSPEND_TRANSITION_DELAY_MS + 30_000
      );
      expect(runState.lifecycleState).toBe("suspended");

      await vi.advanceTimersByTimeAsync(AGENT_SUSPEND_GRACE_MS + 30_000);
      await Promise.resolve();

      expect(runState.killedDueToTimeout).toBe(true);
      expect(handle.kill).toHaveBeenCalled();

      killSpy.mockRestore();
      vi.useRealTimers();
    }, 60_000);

    it("resumes from suspended when new output arrives", async () => {
      vi.useFakeTimers();
      let capturedOnOutput: ((chunk: string) => void) | undefined;

      mockInvokeCodingAgent.mockImplementation(
        (_path: string, _config: unknown, options: { onOutput?: (chunk: string) => void }) => {
          capturedOnOutput = options.onOutput;
          return { kill: vi.fn(), pid: 9999 };
        }
      );

      vi.spyOn(process, "kill").mockImplementation((pid: number, sig?: number) => {
        if (sig === 0 && pid === 9999) return true;
        return true;
      });

      await manager.run(baseParams, runState, timers);
      await vi.advanceTimersByTimeAsync(
        AGENT_INACTIVITY_TIMEOUT_MS + SUSPEND_TRANSITION_DELAY_MS + 30_000
      );

      expect(runState.lifecycleState).toBe("suspended");

      capturedOnOutput?.("agent resumed\n");
      await Promise.resolve();

      expect(runState.lifecycleState).toBe("running");
      expect(runState.suspendReason).toBeUndefined();
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          type: "agent.activity",
          activity: "resumed",
        })
      );

      vi.useRealTimers();
    });

    it("records tool wait activity for diagnostics when a tool call starts and completes", async () => {
      let capturedOnOutput: ((chunk: string) => void) | undefined;
      mockInvokeCodingAgent.mockImplementation(
        (_path: string, _config: unknown, options: { onOutput?: (chunk: string) => void }) => {
          capturedOnOutput = options.onOutput;
          return { kill: vi.fn(), pid: 9999 };
        }
      );

      await manager.run(baseParams, runState, timers);
      capturedOnOutput?.(
        '{"type":"tool_call","subtype":"started","call_id":"call-1","tool_call":{"shellToolCall":{"args":{"command":"npm test -- --runInBand"}}}}\n'
      );
      capturedOnOutput?.('{"type":"tool_call","subtype":"completed","call_id":"call-1"}\n');

      const events = vi.mocked(mockAppendEvent).mock.calls.map(([, event]) => event);
      const waitingEvent = events.find((event) => event.event === "agent.waiting_on_tool");
      const completedEvent = events.find((event) => event.event === "agent.tool_completed");
      expect(waitingEvent).toEqual(
        expect.objectContaining({
          taskId: "task-1",
          event: "agent.waiting_on_tool",
          data: expect.objectContaining({
            attempt: 1,
            phase: "coding",
            summary: "npm test -- --runInBand",
            toolStatus: "started",
          }),
        })
      );
      expect(completedEvent).toEqual(
        expect.objectContaining({
          taskId: "task-1",
          event: "agent.tool_completed",
          data: expect.objectContaining({
            attempt: 1,
            phase: "coding",
            summary: "npm test -- --runInBand",
            toolStatus: "completed",
          }),
        })
      );
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          type: "agent.activity",
          taskId: "task-1",
          activity: "waiting_on_tool",
        })
      );
      expect(mockBroadcastToProject).toHaveBeenCalledWith(
        "proj-1",
        expect.objectContaining({
          type: "agent.activity",
          taskId: "task-1",
          activity: "tool_completed",
        })
      );
    });
  });

  describe("resumeMonitoring", () => {
    it("keeps a live unverified recovered process despite a terminal result file", async () => {
      vi.useFakeTimers();
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "unverified-result-"));
      const promptPath = path.join(root, ".opensprint", "active", "task-1", "prompt.md");
      const handle = {
        kill: vi.fn(),
        pid: process.pid,
        ownership: "recovered_unverified" as const,
      };
      const onDone = vi.fn();
      try {
        await fs.mkdir(path.dirname(promptPath), { recursive: true });
        await fs.writeFile(
          path.join(path.dirname(promptPath), "result.json"),
          JSON.stringify({ status: "success" })
        );
        await manager.resumeMonitoring(
          handle,
          { ...baseParams, repoPath: root, wtPath: root, promptPath, onDone },
          runState,
          timers
        );
        await vi.advanceTimersByTimeAsync(31_000);
        expect(handle.kill).not.toHaveBeenCalled();
        expect(onDone).not.toHaveBeenCalled();
        expect(runState.activeProcess).toBe(handle);
        expect(runState.exitHandled).toBe(false);
      } finally {
        timers.clearAll();
        vi.useRealTimers();
        await fs.rm(root, { recursive: true, force: true });
      }
    });
    it.each(["cancelled", "replaced"])(
      "releases admission if recovery is %s while output is primed",
      async (mode) => {
        const release = vi.fn();
        vi.mocked(trackExistingGlobalAgentSlot).mockReturnValueOnce(release);
        let finishStat!: (value: Awaited<ReturnType<typeof fs.stat>>) => void;
        const stat = vi.spyOn(fs, "stat").mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishStat = resolve;
            })
        );
        try {
          const initializing = manager.resumeMonitoring(
            { pid: null, kill: vi.fn() },
            baseParams,
            runState,
            timers
          );
          if (mode === "cancelled") runState.runner!.cancel();
          else runState.attemptId = "replacement-invocation";
          finishStat({ size: 0, mtimeMs: 0 } as Awaited<ReturnType<typeof fs.stat>>);
          await initializing;
          expect(release).toHaveBeenCalledOnce();
          expect(timers.has("heartbeat")).toBe(false);
          expect(timers.has("result")).toBe(false);
        } finally {
          stat.mockRestore();
        }
      }
    );

    it("releases admission when recovery initialization throws before monitors are installed", async () => {
      const release = vi.fn();
      vi.mocked(trackExistingGlobalAgentSlot).mockReturnValueOnce(release);
      const prime = vi
        .spyOn(
          manager as unknown as {
            primeRecoveredRunState: () => Promise<void>;
          },
          "primeRecoveredRunState"
        )
        .mockRejectedValueOnce(new Error("recovery I/O failed"));
      try {
        await expect(
          manager.resumeMonitoring({ pid: null, kill: vi.fn() }, baseParams, runState, timers)
        ).rejects.toThrow("recovery I/O failed");
        expect(release).toHaveBeenCalledOnce();
        expect(timers.has("heartbeat")).toBe(false);
      } finally {
        prime.mockRestore();
      }
    });

    it("starts output tail and sets outputTailStop so live output streams after GUPP recovery", async () => {
      const handle = { kill: vi.fn(), pid: 9999 };

      await manager.resumeMonitoring(handle, baseParams, runState, timers);

      expect(runState.activeProcess).toBe(handle);
      expect(runState.exitHandled).toBe(false);
      expect(timers.has("outputTail")).toBe(true);
      expect(typeof runState.outputTailStop).toBe("function");
      expect(timers.has("heartbeat")).toBe(true);
      expect(timers.has("inactivity")).toBe(true);
    });

    it("outputTailStop clears the tail timer", async () => {
      const handle = { kill: vi.fn(), pid: 9999 };

      await manager.resumeMonitoring(handle, baseParams, runState, timers);
      expect(timers.has("outputTail")).toBe(true);

      runState.outputTailStop!();
      runState.outputTailStop = undefined;

      expect(timers.has("outputTail")).toBe(false);
    });

    it("wrapped onDone stops tail and then calls original onDone", async () => {
      vi.useFakeTimers();
      const killSpy = vi.spyOn(process, "kill");
      try {
        const handle = { kill: vi.fn(), pid: 9999 };
        const onDone = vi.fn().mockResolvedValue(undefined);
        const params = { ...baseParams, onDone };

        await manager.resumeMonitoring(handle, params, runState, timers);
        expect(timers.has("outputTail")).toBe(true);

        // Simulate process-dead path: inactivity monitor will call the wrapped onDone
        killSpy.mockImplementation((pid: number, sig?: number) => {
          if (sig === 0 && pid === 9999) throw new Error("dead");
          return true;
        });
        vi.advanceTimersByTime(30_000);

        await vi.runAllTimersAsync();

        expect(timers.has("outputTail")).toBe(false);
        expect(onDone).toHaveBeenCalledWith(null);
      } finally {
        killSpy.mockRestore();
        vi.useRealTimers();
      }
    });

    it("finalizes recovered runs from terminal result.json even if the process stays alive", async () => {
      vi.useFakeTimers();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-lifecycle-recover-"));
      const promptPath = path.join(tmpDir, ".opensprint", "active", "task-1", "prompt.md");
      const handle = { kill: vi.fn(), pid: 9999 };
      const onDone = vi.fn().mockResolvedValue(undefined);
      await fs.mkdir(path.dirname(promptPath), { recursive: true });
      await fs.writeFile(promptPath, "prompt", "utf-8");
      await fs.writeFile(
        path.join(path.dirname(promptPath), "result.json"),
        JSON.stringify({ status: "approved" }),
        "utf-8"
      );

      await manager.resumeMonitoring(
        handle,
        {
          ...baseParams,
          repoPath: tmpDir,
          wtPath: tmpDir,
          promptPath,
          onDone,
        },
        runState,
        timers
      );

      await vi.advanceTimersByTimeAsync(1_200);
      // Flush interval callback + fs.readFile microtasks (same pattern as wrapped onDone test below).
      await vi.runAllTimersAsync();

      expect(handle.kill).toHaveBeenCalledTimes(1);
      expect(onDone).toHaveBeenCalledWith(0);
      expect(runState.activeProcess).toBeNull();
      expect(runState.exitHandled).toBe(true);
      expect(timers.has("outputTail")).toBe(false);
      vi.useRealTimers();
    });
  });
});
