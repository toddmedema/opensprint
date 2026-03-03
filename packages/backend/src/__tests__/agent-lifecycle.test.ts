import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentLifecycleManager } from "../services/agent-lifecycle.js";
import type { AgentRunState, AgentRunParams } from "../services/agent-lifecycle.js";
import { TimerRegistry } from "../services/timer-registry.js";
import { AGENT_INACTIVITY_TIMEOUT_MS, AGENT_SUSPEND_GRACE_MS } from "@opensprint/shared";

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
    promptPath: "/tmp/prompt.md",
    agentConfig: { type: "cursor", model: "gpt-4" },
    attempt: 1,
    agentLabel: "Coder",
    role: "coder",
    onDone: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
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
      startedAt: "",
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

  describe("run", () => {
    it("spawns coder agent and initializes run state", () => {
      manager.run(baseParams, runState, timers);

      expect(mockInvokeCodingAgent).toHaveBeenCalled();
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
    });

    it("spawns reviewer agent when role is reviewer", () => {
      manager.run({ ...baseParams, role: "reviewer" }, runState, timers);

      expect(mockInvokeReviewAgent).toHaveBeenCalled();
      expect(mockInvokeCodingAgent).not.toHaveBeenCalled();
    });

    it("preserves startedAt when already set (e.g. by phase-executor before spawn)", () => {
      const assignmentCreatedAt = "2026-02-16T11:57:00.000Z";
      runState.startedAt = assignmentCreatedAt;

      manager.run(baseParams, runState, timers);

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

      manager.run(baseParams, runState, timers);
      expect(baseParams.onDone).not.toHaveBeenCalled();

      await capturedOnExit?.(0);

      expect(baseParams.onDone).toHaveBeenCalledWith(0);
      expect(runState.activeProcess).toBeNull();
      expect(runState.exitHandled).toBe(true);
      expect(mockDeleteHeartbeat).toHaveBeenCalledWith("/tmp/repo", "task-1");
      expect(timers.has("heartbeat")).toBe(false);
      expect(timers.has("inactivity")).toBe(false);
    });

    it("appends output chunks to runState.outputLog", () => {
      let capturedOnOutput: ((chunk: string) => void) | undefined;
      mockInvokeCodingAgent.mockImplementation(
        (_path: string, _config: unknown, options: { onOutput?: (chunk: string) => void }) => {
          capturedOnOutput = options.onOutput;
          return { kill: vi.fn(), pid: 9999 };
        }
      );

      manager.run(baseParams, runState, timers);

      capturedOnOutput?.("chunk1");
      capturedOnOutput?.("chunk2");

      expect(runState.outputLog).toEqual(["chunk1", "chunk2"]);
      expect(mockSendAgentOutputToProject).toHaveBeenCalledWith("proj-1", "task-1", "chunk1");
      expect(mockSendAgentOutputToProject).toHaveBeenCalledWith("proj-1", "task-1", "chunk2");
    });

    it("does not call onDone twice when onExit is invoked multiple times", async () => {
      let capturedOnExit: ((code: number | null) => void) | undefined;
      mockInvokeCodingAgent.mockImplementation(
        (_path: string, _config: unknown, options: { onExit?: (code: number | null) => void }) => {
          capturedOnExit = options.onExit;
          return { kill: vi.fn(), pid: 9999 };
        }
      );

      manager.run(baseParams, runState, timers);

      await capturedOnExit?.(0);
      await capturedOnExit?.(1);

      expect(baseParams.onDone).toHaveBeenCalledTimes(1);
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

      manager.run(baseParams, runState, timers);
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

    it("suspends when a shell tool call stays silent past the extended window", async () => {
      vi.useFakeTimers();
      const handle = {
        kill: vi.fn(() => {
          runState.activeProcess = null;
        }),
        pid: 9999,
      };
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

      manager.run(baseParams, runState, timers);
      capturedOnOutput?.(
        '{"type":"tool_call","subtype":"started","call_id":"call-1","tool_call":{"shellToolCall":{"args":{"command":"npm test"}}}}\n'
      );

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 30_000);
      await Promise.resolve();

      expect(runState.lifecycleState).toBe("suspended");
      expect(runState.suspendReason).toBe("output_gap");
      expect(runState.killedDueToTimeout).toBe(false);
      expect(handle.kill).not.toHaveBeenCalled();

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

      manager.run(baseParams, runState, timers);
      capturedOnOutput?.(
        '{"type":"tool_call","subtype":"started","call_id":"call-1","tool_call":{"shellToolCall":{"args":{"command":"npm test"}}}}\n'
      );

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 30_000);
      expect(runState.lifecycleState).toBe("suspended");

      await vi.advanceTimersByTimeAsync(AGENT_SUSPEND_GRACE_MS + 30_000);
      await Promise.resolve();

      expect(runState.killedDueToTimeout).toBe(true);
      expect(handle.kill).toHaveBeenCalled();

      killSpy.mockRestore();
      vi.useRealTimers();
    });

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

      manager.run(baseParams, runState, timers);
      await vi.advanceTimersByTimeAsync(AGENT_INACTIVITY_TIMEOUT_MS + 30_000);

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

    it("records tool wait activity for diagnostics when a tool call starts and completes", () => {
      let capturedOnOutput: ((chunk: string) => void) | undefined;
      mockInvokeCodingAgent.mockImplementation(
        (_path: string, _config: unknown, options: { onOutput?: (chunk: string) => void }) => {
          capturedOnOutput = options.onOutput;
          return { kill: vi.fn(), pid: 9999 };
        }
      );

      manager.run(baseParams, runState, timers);
      capturedOnOutput?.(
        '{"type":"tool_call","subtype":"started","call_id":"call-1","tool_call":{"shellToolCall":{"args":{"command":"npm test -- --runInBand"}}}}\n'
      );
      capturedOnOutput?.('{"type":"tool_call","subtype":"completed","call_id":"call-1"}\n');

      expect(mockAppendEvent).toHaveBeenNthCalledWith(
        1,
        "/tmp/repo",
        expect.objectContaining({
          taskId: "task-1",
          event: "agent.waiting_on_tool",
          data: expect.objectContaining({
            attempt: 1,
            phase: "coding",
            summary: "npm test -- --runInBand",
          }),
        })
      );
      expect(mockAppendEvent).toHaveBeenNthCalledWith(
        2,
        "/tmp/repo",
        expect.objectContaining({
          taskId: "task-1",
          event: "agent.tool_completed",
          data: expect.objectContaining({
            attempt: 1,
            phase: "coding",
            summary: "npm test -- --runInBand",
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
      const handle = { kill: vi.fn(), pid: 9999 };
      const onDone = vi.fn().mockResolvedValue(undefined);
      const params = { ...baseParams, onDone };

      await manager.resumeMonitoring(handle, params, runState, timers);
      expect(timers.has("outputTail")).toBe(true);

      // Simulate process-dead path: inactivity monitor will call the wrapped onDone
      vi.spyOn(process, "kill").mockImplementation((pid: number, sig?: number) => {
        if (sig === 0 && pid === 9999) throw new Error("dead");
        return true;
      });
      vi.advanceTimersByTime(30_000);

      await vi.runAllTimersAsync();

      expect(timers.has("outputTail")).toBe(false);
      expect(onDone).toHaveBeenCalledWith(null);
      vi.useRealTimers();
    });
  });
});
