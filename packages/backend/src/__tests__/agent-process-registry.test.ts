import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  registerAgentProcess,
  unregisterAgentProcess,
  killAllTrackedAgentProcesses,
} from "../services/agent-process-registry.js";

describe("agent-process-registry", () => {
  let mockKill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockKill = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    killAllTrackedAgentProcesses();
    mockKill.mockRestore();
  });

  it("should track and kill processes on killAllTrackedAgentProcesses", () => {
    registerAgentProcess(1001);
    registerAgentProcess(1002);

    killAllTrackedAgentProcesses();

    expect(mockKill).toHaveBeenCalledWith(1001, "SIGTERM");
    expect(mockKill).toHaveBeenCalledWith(1002, "SIGTERM");
  });

  it("should track process groups (stored as negative PID for kill -pgid)", () => {
    // Process groups use negative PID; registerAgentProcess(pid, {processGroup:true}) stores -pid
    registerAgentProcess(2001, { processGroup: true });
    registerAgentProcess(2002); // regular pid

    killAllTrackedAgentProcesses();

    // Both process group (-2001) and regular pid (2002) should be killed
    expect(mockKill).toHaveBeenCalledTimes(2);
    const calls = mockKill.mock.calls;
    expect(calls.map((c) => c[0])).toContain(-2001);
    expect(calls.map((c) => c[0])).toContain(2002);
  });

  it("should clear registry after killAllTrackedAgentProcesses", () => {
    registerAgentProcess(3001);
    killAllTrackedAgentProcesses();
    mockKill.mockClear();

    killAllTrackedAgentProcesses();

    expect(mockKill).not.toHaveBeenCalled();
  });

  it("should unregister process so it is not killed", () => {
    registerAgentProcess(4001);
    unregisterAgentProcess(4001);

    killAllTrackedAgentProcesses();

    expect(mockKill).not.toHaveBeenCalled();
  });
});
