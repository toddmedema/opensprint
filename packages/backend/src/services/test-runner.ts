import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import type { TestResults, TestResultDetail } from "@opensprint/shared";
import { registerAgentProcess, unregisterAgentProcess } from "./agent-process-registry.js";

const TEST_TIMEOUT_MS = 300_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const SIGKILL_GRACE_MS = 3_000;
const VITEST_CONFIG_FILES = [
  "vitest.workspace.ts",
  "vitest.workspace.js",
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.config.mts",
  "vitest.config.mjs",
];
const JEST_CONFIG_FILES = ["jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs"];

export interface ScopedTestResult extends TestResults {
  /** Raw stdout+stderr output from the test run */
  rawOutput: string;
}

/**
 * Configurable test execution service.
 * Detects or uses user-configured test framework.
 * Parses test output into TestResults structure.
 */
export class TestRunner {
  /**
   * Run only tests related to changed files. Falls back to full suite if
   * no test files were changed or if scoping is not possible.
   * Returns results plus raw output for richer retry context.
   */
  async runScopedTests(
    repoPath: string,
    changedFiles: string[],
    testCommand?: string
  ): Promise<ScopedTestResult> {
    const testFiles = changedFiles.filter((f) => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f));
    const detectedFramework = await this.detectScopedFramework(repoPath, testCommand);

    let command: string | undefined;
    if (testFiles.length > 0 && detectedFramework === "vitest") {
      command = this.buildVitestCommand("run", testFiles);
    } else if (testFiles.length > 0 && detectedFramework === "jest") {
      command = `npx jest ${testFiles.join(" ")}`;
    } else if (changedFiles.length > 0 && detectedFramework === "vitest") {
      command = this.buildVitestCommand("related", changedFiles);
    } else if (changedFiles.length > 0 && detectedFramework === "jest") {
      command = `npx jest --findRelatedTests ${changedFiles.join(" ")}`;
    } else {
      command = testCommand;
    }

    const result = await this.runTestsWithOutput(repoPath, command);
    return result;
  }

  /**
   * Run tests and return both structured results and raw output.
   */
  async runTestsWithOutput(repoPath: string, testCommand?: string): Promise<ScopedTestResult> {
    const command = testCommand || (await this.detectTestCommand(repoPath));

    if (!command) {
      return {
        passed: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        details: [],
        rawOutput: "",
      };
    }

    const { stdout, stderr, exitCode } = await this.execWithProcessGroup(command, repoPath);
    const rawOutput = stdout + "\n" + stderr;

    if (exitCode === 0) {
      const parsed = this.parseTestOutput(rawOutput, command);
      return { ...parsed, rawOutput };
    }

    const results = this.parseTestOutput(rawOutput, command);
    if (results.total === 0) {
      return {
        passed: 0,
        failed: 1,
        skipped: 0,
        total: 1,
        details: [
          {
            name: "Test execution",
            status: "failed",
            duration: 0,
            error: stderr || "Test command failed with no output",
          },
        ],
        rawOutput,
      };
    }

    return { ...results, rawOutput };
  }

  /**
   * Run tests for a project and return structured results.
   */
  async runTests(repoPath: string, testCommand?: string): Promise<TestResults> {
    const result = await this.runTestsWithOutput(repoPath, testCommand);
    const { rawOutput: _, ...testResults } = result;
    return testResults;
  }

  /**
   * Run a shell command in its own process group so the entire tree
   * (including vitest/jest workers) can be killed on timeout or cancellation.
   */
  private execWithProcessGroup(
    command: string,
    cwd: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const child = spawn("sh", ["-c", command], {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
      });

      if (child.pid) {
        registerAgentProcess(child.pid, { processGroup: true });
      }

      const killProcessGroup = () => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            /* already gone */
          }
        }, SIGKILL_GRACE_MS);
      };

      const timeout = setTimeout(() => {
        killProcessGroup();
      }, TEST_TIMEOUT_MS);

      child.stdout.on("data", (data: Buffer) => {
        if (stdout.length < MAX_BUFFER_BYTES) stdout += data.toString();
      });

      child.stderr.on("data", (data: Buffer) => {
        if (stderr.length < MAX_BUFFER_BYTES) stderr += data.toString();
      });

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (child.pid) {
          unregisterAgentProcess(child.pid, { processGroup: true });
        }
        resolve({ stdout, stderr, exitCode });
      };

      child.on("close", (code) => finish(code));
      child.on("error", () => finish(1));

      child.unref();
    });
  }

  /**
   * Detect the test command from project configuration.
   */
  private async detectTestCommand(repoPath: string): Promise<string | null> {
    try {
      const pkgPath = path.join(repoPath, "package.json");
      const raw = await fs.readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      const testScript =
        typeof pkg.scripts?.test === "string" ? pkg.scripts.test.trim().toLowerCase() : "";

      if (testScript.includes("vitest")) {
        return "npx vitest run";
      }
      if (testScript.includes("jest")) {
        return "npx jest";
      }
    } catch {
      // No package.json
    }

    // Check for common test configs before falling back to a generic package.json test script.
    const configs = [
      { file: "vitest.workspace.ts", cmd: "npx vitest run" },
      { file: "vitest.workspace.js", cmd: "npx vitest run" },
      { file: "vitest.config.ts", cmd: "npx vitest run" },
      { file: "vitest.config.js", cmd: "npx vitest run" },
      { file: "jest.config.js", cmd: "npx jest" },
      { file: "jest.config.ts", cmd: "npx jest" },
      { file: "pytest.ini", cmd: "pytest" },
      { file: "setup.py", cmd: "python -m pytest" },
    ];

    for (const { file, cmd } of configs) {
      try {
        await fs.access(path.join(repoPath, file));
        return cmd;
      } catch {
        // Config not found
      }
    }

    try {
      const pkgPath = path.join(repoPath, "package.json");
      const raw = await fs.readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);

      if (pkg.scripts?.test && pkg.scripts.test !== 'echo "Error: no test specified" && exit 1') {
        return "npm test";
      }
    } catch {
      // No package.json
    }

    return null;
  }

  /**
   * Parse test output into structured results.
   * Handles Vitest, Jest, and generic patterns.
   */
  private parseTestOutput(output: string, _command: string): TestResults {
    const details: TestResultDetail[] = [];
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    // Vitest/Jest summary pattern: "Tests: X passed, Y failed, Z skipped, W total"
    const summaryMatch = output.match(
      /Tests?:\s*(?:(\d+)\s+passed)?(?:,?\s*(\d+)\s+failed)?(?:,?\s*(\d+)\s+skipped)?(?:,?\s*(\d+)\s+total)?/i
    );

    if (summaryMatch) {
      passed = parseInt(summaryMatch[1] || "0", 10);
      failed = parseInt(summaryMatch[2] || "0", 10);
      skipped = parseInt(summaryMatch[3] || "0", 10);
    }

    // Parse individual test results (Vitest/Jest format)
    const testLineRegex = /\s*(✓|✗|○|PASS|FAIL|SKIP)\s+(.+?)(?:\s+\((\d+)\s*ms\))?$/gm;
    let match;
    while ((match = testLineRegex.exec(output)) !== null) {
      const indicator = match[1];
      const name = match[2].trim();
      const duration = match[3] ? parseInt(match[3], 10) : 0;

      let status: "passed" | "failed" | "skipped";
      if (indicator === "✓" || indicator === "PASS") {
        status = "passed";
      } else if (indicator === "✗" || indicator === "FAIL") {
        status = "failed";
      } else {
        status = "skipped";
      }

      details.push({ name, status, duration });
    }

    // If we couldn't parse individual tests but have a summary
    const total = passed + failed + skipped;
    if (total === 0 && details.length === 0) {
      // Check for pytest-style output
      const pytestMatch = output.match(/(\d+) passed(?:,\s*(\d+) failed)?(?:,\s*(\d+) skipped)?/);
      if (pytestMatch) {
        passed = parseInt(pytestMatch[1] || "0", 10);
        failed = parseInt(pytestMatch[2] || "0", 10);
        skipped = parseInt(pytestMatch[3] || "0", 10);
      }
    }

    return {
      passed,
      failed,
      skipped,
      total: passed + failed + skipped || details.length,
      details,
    };
  }

  private buildVitestCommand(mode: "run" | "related", files: string[]): string {
    const fileArgs = files.join(" ").trim();
    const base =
      mode === "run"
        ? "npx vitest run --maxWorkers=1"
        : "npx vitest related --run --maxWorkers=1";
    return fileArgs ? `${base} ${fileArgs}` : base;
  }

  private async detectScopedFramework(
    repoPath: string,
    testCommand?: string
  ): Promise<"vitest" | "jest" | null> {
    const normalized = testCommand?.trim().toLowerCase() ?? "";
    if (normalized.includes("vitest")) return "vitest";
    if (normalized.includes("jest")) return "jest";

    if (await this.hasAnyConfigFile(repoPath, VITEST_CONFIG_FILES)) {
      return "vitest";
    }
    if (await this.hasPackageDependency(repoPath, "vitest")) {
      return "vitest";
    }
    if (await this.hasAnyConfigFile(repoPath, JEST_CONFIG_FILES)) {
      return "jest";
    }
    if (await this.hasPackageDependency(repoPath, "jest")) {
      return "jest";
    }

    return null;
  }

  private async hasAnyConfigFile(repoPath: string, files: string[]): Promise<boolean> {
    for (const file of files) {
      try {
        await fs.access(path.join(repoPath, file));
        return true;
      } catch {
        // File not present.
      }
    }
    return false;
  }

  private async hasPackageDependency(repoPath: string, dependencyName: string): Promise<boolean> {
    try {
      const pkgPath = path.join(repoPath, "package.json");
      const raw = await fs.readFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return Boolean(pkg.dependencies?.[dependencyName] || pkg.devDependencies?.[dependencyName]);
    } catch {
      return false;
    }
  }
}

export const testRunner = new TestRunner();
