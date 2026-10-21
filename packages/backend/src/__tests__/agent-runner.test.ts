import { describe, expect, it, vi } from "vitest";
import { AgentRunner } from "../services/agent/agent-runner.js";
import { createProcessGroupHandle } from "../services/agent/agent-process-handle.js";

describe("AgentRunner", () => {
  it("cancels admission before an invocation can start", () => {
    const runner = new AgentRunner("attempt-1");
    const invoke = vi.fn();
    runner.cancel();
    expect(runner.start(invoke)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    expect(runner.observe()).toMatchObject({ attemptId: "attempt-1", state: "stopped" });
  });

  it("retains stop_requested until termination is observed", () => {
    const runner = new AgentRunner("attempt-2");
    const kill = vi.fn();
    runner.start(() => ({ pid: 123, kill }));
    runner.cancel();
    runner.cancel();
    expect(kill).toHaveBeenCalledOnce();
    expect(runner.observe().state).toBe("stop_requested");
    expect(runner.steer("continue")).toBe(false);
    runner.complete();
    expect(runner.observe().state).toBe("stopped");
  });

  it("does not signal a recovered PID without independent ownership verification", () => {
    const kill = vi.spyOn(process, "kill");
    try {
      const runner = new AgentRunner("recovered");
      runner.start(() => createProcessGroupHandle(123456));
      runner.cancel();
      expect(runner.observe()).toMatchObject({
        state: "uncertain",
        ownership: "recovered_unverified",
      });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});
