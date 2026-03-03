import { describe, it, expect, vi, afterEach } from "vitest";
import { parseOrphanedProcesses } from "../services/process-reaper.js";

const mockExecSync = vi.fn().mockReturnValue("");
const mockKill = vi.fn();

vi.mock("child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  spawn: vi.fn(),
  exec: vi.fn(),
}));

const originalKill = process.kill;

const { startProcessReaper, stopProcessReaper } = await import("../services/process-reaper.js");

describe("process-reaper", () => {
  afterEach(() => {
    stopProcessReaper();
    mockExecSync.mockClear();
    mockKill.mockClear();
    process.kill = originalKill;
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
    expect(calls.some((cmd) => cmd.includes("pid,ppid,pgid,command"))).toBe(true);
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

describe("parseOrphanedProcesses", () => {
  it("extracts orphaned processes with ppid=1", () => {
    const psOutput = [
      "  PID  PPID  PGID COMMAND",
      "  100     1   100 /Users/x/.local/bin/bd daemon --start --interval 5s",
      "  200    50   200 /usr/bin/node server.js",
      "  300     1   300 /usr/local/bin/node --require tsx src/index.ts",
    ].join("\n");

    const result = parseOrphanedProcesses(psOutput, 999);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      pid: 100,
      pgid: 100,
      command: "/Users/x/.local/bin/bd daemon --start --interval 5s",
    });
    expect(result[1]).toEqual({
      pid: 300,
      pgid: 300,
      command: "/usr/local/bin/node --require tsx src/index.ts",
    });
  });

  it("excludes the current process (ownPid)", () => {
    const psOutput = "  100     1   100 /usr/bin/bd daemon --start";
    const result = parseOrphanedProcesses(psOutput, 100);
    expect(result).toHaveLength(0);
  });

  it("excludes processes with ppid != 1", () => {
    const psOutput = "  100    42   100 /usr/bin/bd daemon --start";
    const result = parseOrphanedProcesses(psOutput, 999);
    expect(result).toHaveLength(0);
  });

  it("handles empty output", () => {
    expect(parseOrphanedProcesses("", 999)).toHaveLength(0);
  });

  it("handles malformed lines gracefully", () => {
    const psOutput = [
      "  PID  PPID  PGID COMMAND",
      "  not a valid line",
      "  100     1   100 /usr/bin/bd daemon --start",
      "",
      "  garbage",
    ].join("\n");

    const result = parseOrphanedProcesses(psOutput, 999);
    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(100);
  });

  it("matches bd processes regardless of install path", () => {
    const psOutput = [
      "36806     1 36806 /Users/todd/.local/bin/bd daemon --start --interval 5s",
      "36857     1 36857 /opt/homebrew/bin/bd daemon --start --interval 5s",
      "37067     1 37067 /usr/local/bin/bd daemon --start --interval 5s",
      "37318     1 37318 bd daemon --start --interval 5s",
    ].join("\n");

    const result = parseOrphanedProcesses(psOutput, 999);
    expect(result).toHaveLength(4);
    for (const p of result) {
      expect(p.command).toContain("bd daemon --start");
    }
  });

  it("matches vitest processes with full paths", () => {
    const psOutput =
      "  500     1   500 /Users/x/.nvm/versions/node/v22.22.0/bin/node /proj/node_modules/.bin/vitest run";
    const result = parseOrphanedProcesses(psOutput, 999);
    expect(result).toHaveLength(1);
    expect(result[0].command).toContain("vitest");
  });
});

describe("reaper kills orphaned processes", () => {
  afterEach(() => {
    stopProcessReaper();
    mockExecSync.mockClear();
    mockKill.mockClear();
    process.kill = originalKill;
  });

  it("does not kill bd daemon processes (daemon subsystem removed)", () => {
    if (process.platform === "win32") return;

    const psOutput = [
      "  PID  PPID  PGID COMMAND",
      "36806     1 36806 /Users/todd/.local/bin/bd daemon --start --interval 5s",
      "36857     1 36857 /Users/todd/.local/bin/bd daemon --start --interval 5s",
      "99999  1234 99999 /usr/bin/node server.js",
    ].join("\n");

    mockExecSync.mockReturnValue(psOutput);
    process.kill = mockKill as unknown as typeof process.kill;

    startProcessReaper();

    const killCalls = mockKill.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    expect(killCalls.length).toBe(0);
  });

  it("kills orphaned claude --print processes", () => {
    if (process.platform === "win32") return;

    const psOutput = [
      "  PID  PPID  PGID COMMAND",
      "50000     1 50000 /usr/local/bin/claude --print some prompt here",
      "50001     1 50001 /usr/bin/unrelated-process",
    ].join("\n");

    mockExecSync.mockReturnValue(psOutput);
    process.kill = mockKill as unknown as typeof process.kill;

    startProcessReaper();

    const killCalls = mockKill.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    expect(killCalls.length).toBe(1);
    expect(killCalls[0][0]).toBe(-50000);
  });

  it("does not kill non-matching orphaned processes", () => {
    if (process.platform === "win32") return;

    const psOutput = [
      "  PID  PPID  PGID COMMAND",
      "60000     1 60000 /usr/bin/some-unrelated-daemon",
      "60001     1 60001 /usr/local/bin/nginx",
    ].join("\n");

    mockExecSync.mockReturnValue(psOutput);
    process.kill = mockKill as unknown as typeof process.kill;

    startProcessReaper();

    const killCalls = mockKill.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    expect(killCalls.length).toBe(0);
  });

  it("kills an orphaned npm test process group once for the whole vitest tree", () => {
    if (process.platform === "win32") return;

    const psOutput = [
      "  PID  PPID  PGID COMMAND",
      "70000     1 70000 npm run test",
      "70001 70000 70000 node /proj/node_modules/.bin/vitest run",
    ].join("\n");

    mockExecSync.mockReturnValue(psOutput);
    process.kill = mockKill as unknown as typeof process.kill;

    startProcessReaper();

    const killCalls = mockKill.mock.calls.filter((c: unknown[]) => c[1] === "SIGKILL");
    expect(killCalls).toEqual([[-70000, "SIGKILL"]]);
  });
});
