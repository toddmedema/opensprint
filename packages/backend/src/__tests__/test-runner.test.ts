import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import os from "os";
import fsSync from "fs";
import fs from "fs/promises";
import { TestRunner } from "../services/test-runner.js";

const mockSpawn = vi.fn();
const mockRegisterAgentProcess = vi.fn();
const mockUnregisterAgentProcess = vi.fn();

vi.mock("child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

vi.mock("../services/agent-process-registry.js", () => ({
  registerAgentProcess: (...args: unknown[]) => mockRegisterAgentProcess(...args),
  unregisterAgentProcess: (...args: unknown[]) => mockUnregisterAgentProcess(...args),
}));

function createMockChild(stdout: string, stderr: string, exitCode: number) {
  const listeners: { event: string; cb: (arg?: unknown) => void }[] = [];
  const stdoutListeners: ((data: Buffer) => void)[] = [];
  const stderrListeners: ((data: Buffer) => void)[] = [];
  let scheduled = false;

  const emitAndClose = () => {
    if (scheduled) return;
    scheduled = true;
    setImmediate(() => {
      if (stdout) stdoutListeners.forEach((cb) => cb(Buffer.from(stdout)));
      if (stderr) stderrListeners.forEach((cb) => cb(Buffer.from(stderr)));
      listeners.filter((l) => l.event === "close").forEach((l) => l.cb(exitCode));
    });
  };

  const child = {
    pid: 12345,
    stdout: {
      on: (event: string, cb: (data: Buffer) => void) => {
        if (event === "data") stdoutListeners.push(cb);
        emitAndClose();
      },
    },
    stderr: {
      on: (event: string, cb: (data: Buffer) => void) => {
        if (event === "data") stderrListeners.push(cb);
        emitAndClose();
      },
    },
    on: (event: string, cb: (arg?: unknown) => void) => {
      listeners.push({ event, cb });
      emitAndClose();
    },
    unref: () => {},
  };

  return child;
}

describe("TestRunner", () => {
  let runner: TestRunner;

  beforeEach(() => {
    runner = new TestRunner();
    mockSpawn.mockClear();
    mockRegisterAgentProcess.mockClear();
    mockUnregisterAgentProcess.mockClear();
  });

  describe("runTestsWithOutput", () => {
    it("parses Vitest JSON reporter output when available", async () => {
      mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
        const command = args[1] ?? "";
        const outputFileMatch = command.match(/--outputFile=(\S+)/);
        const outputFile = outputFileMatch?.[1];
        expect(outputFile).toBeTruthy();
        const report = {
          numPassedTests: 2,
          numFailedTests: 1,
          numPendingTests: 1,
          numTotalTests: 4,
          testResults: [
            {
              name: "sample.test.ts",
              assertionResults: [
                { fullName: "a", status: "passed", duration: 1 },
                { fullName: "b", status: "failed", duration: 2, failureMessages: ["boom"] },
                { fullName: "c", status: "pending", duration: 0 },
                { fullName: "d", status: "passed", duration: 1 },
              ],
            },
          ],
        };
        fsSync.writeFileSync(outputFile!, JSON.stringify(report), "utf-8");
        return createMockChild("", "", 1);
      });

      const result = await runner.runTestsWithOutput(
        "/tmp/repo",
        "node ./node_modules/vitest/vitest.mjs run"
      );

      expect(result.passed).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.total).toBe(4);
      expect(result.details.some((d) => d.status === "failed" && d.error?.includes("boom"))).toBe(true);

      const invoked = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined)?.[1] ?? "";
      expect(invoked).toContain("--reporter=json");
      expect(invoked).toContain("--outputFile=");
    });

    it("parses Vitest-style output and returns structured results on success", async () => {
      const output =
        "Tests: 5 passed, 0 failed, 2 skipped, 7 total\n✓ test one (10 ms)\n✓ test two (5 ms)";
      mockSpawn.mockReturnValue(createMockChild(output, "", 0));

      const result = await runner.runTestsWithOutput("/tmp/repo", "npm test");

      expect(result.passed).toBe(5);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(2);
      expect(result.total).toBe(7);
      expect(result.rawOutput).toContain(output);
      expect(result.executedCommand).toBe("npm test");
      expect(mockSpawn).toHaveBeenCalledWith("sh", ["-c", "npm test"], expect.any(Object));
    });

    it("parses Vitest v2 summary format", async () => {
      const output = "Tests  10 passed | 2 failed | 1 skipped (13)";
      mockSpawn.mockReturnValue(createMockChild(output, "", 1));

      const result = await runner.runTestsWithOutput("/tmp/repo", "npm test");

      expect(result.passed).toBe(10);
      expect(result.failed).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.total).toBe(13);
    });

    it("uses cmd.exe shell invocation on Windows", async () => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const output = "Tests: 1 passed, 0 failed, 0 skipped, 1 total";
      mockSpawn.mockReturnValue(createMockChild(output, "", 0));
      try {
        await runner.runTestsWithOutput("C:\\repo", "npm test");
      } finally {
        platformSpy.mockRestore();
      }

      expect(mockSpawn).toHaveBeenCalledWith(
        "cmd.exe",
        ["/d", "/s", "/c", "npm test"],
        expect.any(Object)
      );
    });

    it("parses Jest-style summary and handles failed tests", async () => {
      const output = "Tests: 3 passed, 2 failed, 1 skipped, 6 total";
      mockSpawn.mockReturnValue(createMockChild(output, "Some error", 1));

      const result = await runner.runTestsWithOutput("/tmp/repo", "npx jest");

      expect(result.passed).toBe(3);
      expect(result.failed).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.total).toBe(6);
      expect(result.rawOutput).toContain(output);
    });

    it("returns fallback failure when exit code non-zero and no parseable output", async () => {
      mockSpawn.mockReturnValue(createMockChild("", "Command not found", 127));

      const result = await runner.runTestsWithOutput("/tmp/repo", "nonexistent-command");

      expect(result.passed).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.total).toBe(1);
      expect(result.details[0]?.status).toBe("failed");
      expect(result.details[0]?.error).toContain("Command not found");
      expect(result.executedCommand).toBe("nonexistent-command");
    });

    it("returns empty results when no test command is provided and no package.json", async () => {
      mockSpawn.mockClear();
      const emptyDir = path.join(os.tmpdir(), `opensprint-test-runner-${Date.now()}`);
      await fs.mkdir(emptyDir, { recursive: true });
      try {
        const result = await runner.runTestsWithOutput(emptyDir);

        expect(result.passed).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.total).toBe(0);
        expect(result.rawOutput).toBe("");
        expect(result.executedCommand).toBeNull();
        expect(mockSpawn).not.toHaveBeenCalled();
      } finally {
        await fs.rm(emptyDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("parses pytest-style output", async () => {
      const output = "3 passed, 1 failed, 0 skipped";
      mockSpawn.mockReturnValue(createMockChild(output, "", 1));

      const result = await runner.runTestsWithOutput("/tmp/repo", "pytest");

      expect(result.passed).toBe(3);
      expect(result.failed).toBe(1);
      expect(result.skipped).toBe(0);
    });
  });

  describe("runScopedTests", () => {
    it("scopes vitest to changed test files when test command includes vitest", async () => {
      const output = "Tests: 2 passed, 0 failed, 0 skipped, 2 total";
      mockSpawn.mockReturnValue(createMockChild(output, "", 0));

      const result = await runner.runScopedTests(
        "/tmp/repo",
        ["src/foo.test.ts", "src/bar.ts"],
        "node ./node_modules/vitest/vitest.mjs run"
      );

      const invoked = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined)?.[1] ?? "";
      expect(invoked).toContain("node ./node_modules/vitest/vitest.mjs run src/foo.test.ts");
      expect(invoked).toContain("--reporter=json");
      expect(invoked).toContain("--outputFile=");
      expect(result.passed).toBe(2);
      expect(result.executedCommand).toContain(
        "node ./node_modules/vitest/vitest.mjs run src/foo.test.ts"
      );
    });

    it("uses vitest related for changed source files", async () => {
      const output = "Tests: 3 passed, 0 failed, 0 skipped, 3 total";
      mockSpawn.mockReturnValue(createMockChild(output, "", 0));

      await runner.runScopedTests(
        "/tmp/repo",
        ["src/foo.ts", "src/bar.ts"],
        "node ./node_modules/vitest/vitest.mjs run"
      );

      const invoked = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined)?.[1] ?? "";
      expect(invoked).toContain(
        "node ./node_modules/vitest/vitest.mjs related --run src/foo.ts src/bar.ts"
      );
      expect(invoked).toContain("--reporter=json");
      expect(invoked).toContain("--outputFile=");
    });

    it("scopes jest to changed test files when test command includes jest", async () => {
      const output = "Tests: 1 passed, 0 failed, 0 skipped, 1 total";
      mockSpawn.mockReturnValue(createMockChild(output, "", 0));

      await runner.runScopedTests("/tmp/repo", ["src/a.test.ts", "src/b.spec.js"], "npx jest");

      expect(mockSpawn).toHaveBeenCalledWith(
        "sh",
        ["-c", "npx jest src/a.test.ts src/b.spec.js"],
        expect.any(Object)
      );
    });

    it("uses related jest tests for changed source files", async () => {
      const output = "Tests: 2 passed, 0 failed, 0 skipped, 2 total";
      mockSpawn.mockReturnValue(createMockChild(output, "", 0));

      await runner.runScopedTests("/tmp/repo", ["src/foo.ts", "src/bar.ts"], "npx jest");

      expect(mockSpawn).toHaveBeenCalledWith(
        "sh",
        ["-c", "npx jest --findRelatedTests src/foo.ts src/bar.ts"],
        expect.any(Object)
      );
    });

    it("infers vitest from repo config even when the configured command is npm test", async () => {
      const repoPath = path.join(os.tmpdir(), `opensprint-vitest-related-${Date.now()}`);
      const output = "Tests: 1 passed, 0 failed, 0 skipped, 1 total";
      mockSpawn.mockReturnValue(createMockChild(output, "", 0));
      await fs.mkdir(repoPath, { recursive: true });
      await fs.writeFile(path.join(repoPath, "vitest.workspace.ts"), "export default []");

      try {
        await runner.runScopedTests(repoPath, ["src/foo.ts"], "npm test");
      } finally {
        await fs.rm(repoPath, { recursive: true, force: true }).catch(() => {});
      }

      const invoked = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined)?.[1] ?? "";
      expect(invoked).toContain("node ./node_modules/vitest/vitest.mjs related --run src/foo.ts");
      expect(invoked).toContain("--reporter=json");
      expect(invoked).toContain("--outputFile=");
    });

    it("uses full test command when no scoped runner can be inferred", async () => {
      const output = "Tests: 5 passed, 0 failed, 0 skipped, 5 total";
      mockSpawn.mockReturnValue(createMockChild(output, "", 0));

      await runner.runScopedTests("/tmp/repo", ["src/foo.ts", "src/bar.ts"], "npm test");

      expect(mockSpawn).toHaveBeenCalledWith("sh", ["-c", "npm test"], expect.any(Object));
    });
  });

  describe("runTests", () => {
    it("returns TestResults without rawOutput", async () => {
      const output = "Tests: 1 passed, 0 failed, 0 skipped, 1 total";
      mockSpawn.mockReturnValue(createMockChild(output, "", 0));

      const result = await runner.runTests("/tmp/repo", "npm test");

      expect(result.passed).toBe(1);
      expect(result).not.toHaveProperty("rawOutput");
      expect(result).not.toHaveProperty("executedCommand");
    });
  });
});
