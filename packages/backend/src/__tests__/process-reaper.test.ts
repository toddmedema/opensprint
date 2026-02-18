import { describe, it, expect, vi, afterEach } from "vitest";

const mockExecSync = vi.fn().mockReturnValue("");

vi.mock("child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  spawn: vi.fn(),
  exec: vi.fn(),
}));

const { startProcessReaper, stopProcessReaper } = await import("../services/process-reaper.js");

describe("process-reaper", () => {
  afterEach(() => {
    stopProcessReaper();
    mockExecSync.mockClear();
  });

  it("should start and stop without error", () => {
    startProcessReaper();
    stopProcessReaper();
    expect(mockExecSync).toHaveBeenCalled();
  });

  it("should call reapOrphanedClaudeProcesses on start (non-Windows)", () => {
    if (process.platform === "win32") return;

    startProcessReaper();
    const calls = mockExecSync.mock.calls.map((c) => String(c[0]));
    expect(calls.some((cmd) => cmd.includes("claude"))).toBe(true);
    stopProcessReaper();
  });

  it("should not start twice (idempotent)", () => {
    startProcessReaper();
    const countBefore = mockExecSync.mock.calls.length;
    startProcessReaper();
    expect(mockExecSync.mock.calls.length).toBe(countBefore);
    stopProcessReaper();
  });
});
