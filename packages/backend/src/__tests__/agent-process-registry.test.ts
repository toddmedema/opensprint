import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  registerAgentProcess,
  unregisterAgentProcess,
  killAllTrackedAgentProcesses,
} from "../services/agent-process-registry.js";

describe("agent-process-registry", () => {
  let mockKill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // signal 0 = existence check; throw so isProcessAlive returns false (no SIGKILL fallback in tests)
    mockKill = vi.spyOn(process, "kill").mockImplementation((_pid: number, signal?: string | number) => {
      if (signal === 0) throw new Error("no process");
      return true;
    });
  });

  afterEach(async () => {
    await killAllTrackedAgentProcesses(0);
    mockKill.mockRestore();
  });

  it("should track and kill processes on killAllTrackedAgentProcesses", async () => {
    registerAgentProcess(1001);
    registerAgentProcess(1002);

    await killAllTrackedAgentProcesses(0);

    const sigtermCalls = mockKill.mock.calls.filter((c) => c[1] === "SIGTERM");
    expect(sigtermCalls).toContainEqual([1001, "SIGTERM"]);
    expect(sigtermCalls).toContainEqual([1002, "SIGTERM"]);
  });

  it("should track process groups (stored as negative PID for kill -pgid)", async () => {
    // Process groups use negative PID; registerAgentProcess(pid, {processGroup:true}) stores -pid
    registerAgentProcess(2001, { processGroup: true });
    registerAgentProcess(2002); // regular pid

    await killAllTrackedAgentProcesses(0);

    // Both process group (-2001) and regular pid (2002) should receive SIGTERM
    const sigtermCalls = mockKill.mock.calls.filter((c) => c[1] === "SIGTERM");
    expect(sigtermCalls).toHaveLength(2);
    expect(sigtermCalls.map((c) => c[0])).toContain(-2001);
    expect(sigtermCalls.map((c) => c[0])).toContain(2002);
  });

  it("should clear registry after killAllTrackedAgentProcesses", async () => {
    registerAgentProcess(3001);
    await killAllTrackedAgentProcesses(0);
    mockKill.mockClear();

    await killAllTrackedAgentProcesses(0);

    expect(mockKill).not.toHaveBeenCalled();
  });

  it("should unregister process so it is not killed", async () => {
    registerAgentProcess(4001);
    unregisterAgentProcess(4001);

    await killAllTrackedAgentProcesses(0);

    expect(mockKill).not.toHaveBeenCalled();
  });
});
