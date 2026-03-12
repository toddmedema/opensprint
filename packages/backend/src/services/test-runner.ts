import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import type { TestResults, TestResultDetail } from "@opensprint/shared";
import { registerAgentProcess, unregisterAgentProcess } from "./agent-process-registry.js";
import { signalProcessGroup } from "../utils/process-group.js";

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
  /** Actual command executed after scoped/full-suite resolution */
  executedCommand: string | null;
  /** Whether validation ran a scoped command or the full suite command. */
  scope: "scoped" | "full";
}

interface RunTestsOptions {
  timeoutMs?: number;
}

interface VitestJsonAssertionResult {
  fullName?: string;
  title?: string;
  status?: string;
  duration?: number;
  failureMessages?: string[];
}

interface VitestJsonTestResult {
  name?: string;
  assertionResults?: VitestJsonAssertionResult[];
}

interface VitestJsonReport {
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTotalTests?: number;
  testResults?: VitestJsonTestResult[];
}

/**
 * Configurable test execution service.
 * Detects or uses user-configured test framework.
 * Parses test output into TestResults structure.
 */
export class TestRunner {
  private getShellCommand(command: string): { executable: string; args: string[] } {
    if (process.platform === "win32") {
      return { executable: "cmd.exe", args: ["/d", "/s", "/c", command] };
    }
    return { executable: "sh", args: ["-c", command] };
  }

  /**
   * Run only tests related to changed files. Falls back to full suite if
   * no test files were changed or if scoping is not possible.
   * Returns results plus raw output for richer retry context.
   */
  async runScopedTests(
    repoPath: string,
    changedFiles: string[],
    testCommand?: string,
    options?: RunTestsOptions
  ): Promise<ScopedTestResult> {
    const testFiles = changedFiles.filter((f) => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f));
    const detectedFramework = await this.detectScopedFramework(repoPath, testCommand);

    let command: string | undefined;
    let scope: "scoped" | "full" = "full";
    if (testFiles.length > 0 && detectedFramework === "vitest") {
      command = this.buildVitestCommand("run", testFiles);
      scope = "scoped";
    } else if (testFiles.length > 0 && detectedFramework === "jest") {
      command = `npx jest ${testFiles.join(" ")}`;
      scope = "scoped";
    } else if (changedFiles.length > 0 && detectedFramework === "vitest") {
      command = this.buildVitestCommand("related", changedFiles);
      scope = "scoped";
    } else if (changedFiles.length > 0 && detectedFramework === "jest") {
      command = `npx jest --findRelatedTests ${changedFiles.join(" ")}`;
      scope = "scoped";
    } else {
      command = testCommand;
    }

    const result = await this.runTestsWithOutput(repoPath, command, options);
    return { ...result, scope };
  }

  /**
   * Run tests and return both structured results and raw output.
   */
  async runTestsWithOutput(
    repoPath: string,
    testCommand?: string,
    options?: RunTestsOptions
  ): Promise<ScopedTestResult> {
    const command = testCommand || (await this.detectTestCommand(repoPath));
    const timeoutMs =
      typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Math.round(options.timeoutMs)
        : TEST_TIMEOUT_MS;

    if (!command) {
      return {
        passed: 0,
        failed: 0,
        skipped: 0,
        total: 0,
        details: [],
        rawOutput: "",
        executedCommand: null,
        scope: "full",
      };
    }

    const { command: preparedCommand, vitestJsonReportPath } =
      this.withVitestJsonReporter(command, repoPath);
    const { stdout, stderr, exitCode } = await this.execWithProcessGroup(
      preparedCommand,
      repoPath,
      timeoutMs
    );
    const rawOutput = stdout + "\n" + stderr;
    const parsedVitestJson = await this.parseVitestJsonReport(vitestJsonReportPath);

    if (exitCode === 0) {
      const parsed = parsedVitestJson ?? this.parseTestOutput(rawOutput, preparedCommand);
      return { ...parsed, rawOutput, executedCommand: preparedCommand, scope: "full" };
    }

    const results = parsedVitestJson ?? this.parseTestOutput(rawOutput, preparedCommand);
    if (results.failed === 0) {
      const fallbackFailure: TestResultDetail = {
        name: "Test execution",
        status: "failed",
        duration: 0,
        error: stderr || "Test command exited with non-zero status",
      };
      return {
        ...results,
        failed: 1,
        total: Math.max(results.total, results.passed + results.skipped + 1),
        details: [...results.details, fallbackFailure],
        rawOutput,
        executedCommand: preparedCommand,
        scope: "full",
      };
    }
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
        executedCommand: preparedCommand,
        scope: "full",
      };
    }

    return { ...results, rawOutput, executedCommand: preparedCommand, scope: "full" };
  }

  /**
   * Run tests for a project and return structured results.
   */
  async runTests(
    repoPath: string,
    testCommand?: string,
    options?: RunTestsOptions
  ): Promise<TestResults> {
    const result = await this.runTestsWithOutput(repoPath, testCommand, options);
    const { rawOutput: _, executedCommand: __, scope: ___, ...testResults } = result;
    return testResults;
  }

  /**
   * Run a shell command in its own process group so the entire tree
   * (including vitest/jest workers) can be killed on timeout or cancellation.
   */
  private execWithProcessGroup(
    command: string,
    cwd: string,
    timeoutMs: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      const shellCommand = this.getShellCommand(command);

      const child = spawn(shellCommand.executable, shellCommand.args, {
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
          signalProcessGroup(child.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            signalProcessGroup(child.pid!, "SIGKILL");
          } catch {
            /* already gone */
          }
        }, SIGKILL_GRACE_MS);
      };

      const timeout = setTimeout(() => {
        killProcessGroup();
      }, timeoutMs);

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
        return "node ./node_modules/vitest/vitest.mjs run";
      }
      if (testScript.includes("jest")) {
        return "npx jest";
      }
    } catch {
      // No package.json
    }

    // Check for common test configs before falling back to a generic package.json test script.
    const configs = [
      { file: "vitest.workspace.ts", cmd: "node ./node_modules/vitest/vitest.mjs run" },
      { file: "vitest.workspace.js", cmd: "node ./node_modules/vitest/vitest.mjs run" },
      { file: "vitest.config.ts", cmd: "node ./node_modules/vitest/vitest.mjs run" },
      { file: "vitest.config.js", cmd: "node ./node_modules/vitest/vitest.mjs run" },
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
    let summaryMatch = output.match(
      /Tests?:\s*(?:(\d+)\s+passed)?(?:,?\s*(\d+)\s+failed)?(?:,?\s*(\d+)\s+skipped)?(?:,?\s*(\d+)\s+total)?/i
    );
    // Vitest v2 summary pattern: "Tests  2010 passed | 9 skipped (2019)"
    if (!summaryMatch) {
      summaryMatch = output.match(
        /Tests?\s+(?:(\d+)\s+passed)?(?:\s*\|\s*(\d+)\s+failed)?(?:\s*\|\s*(\d+)\s+skipped)?(?:\s*\((\d+)\))?/i
      );
    }

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

  private isVitestCommand(command: string): boolean {
    return /\bvitest\b|vitest\.mjs/.test(command);
  }

  private extractOutputFileArg(command: string): string | null {
    const match = command.match(/(?:^|\s)--outputFile(?:=|\s+)("[^"]+"|'[^']+'|\S+)/);
    if (!match || !match[1]) return null;
    const value = match[1].trim();
    return value.replace(/^['"]|['"]$/g, "");
  }

  private withVitestJsonReporter(
    command: string,
    repoPath: string
  ): { command: string; vitestJsonReportPath: string | null } {
    if (!this.isVitestCommand(command)) {
      return { command, vitestJsonReportPath: null };
    }

    const outputFileArg = this.extractOutputFileArg(command);
    const hasJsonReporter = /--reporter(?:=|\s+)json\b/.test(command);

    if (outputFileArg && hasJsonReporter) {
      const reportPath = path.isAbsolute(outputFileArg)
        ? outputFileArg
        : path.join(repoPath, outputFileArg);
      return { command, vitestJsonReportPath: reportPath };
    }

    if (outputFileArg && !hasJsonReporter) {
      // Respect explicit output files from user commands; fall back to text parsing.
      return { command, vitestJsonReportPath: null };
    }

    const reportFile = path.join(os.tmpdir(), `opensprint-vitest-${randomUUID()}.json`);
    const reporterArg = hasJsonReporter ? "" : " --reporter=json";
    return {
      command: `${command}${reporterArg} --outputFile=${reportFile}`,
      vitestJsonReportPath: reportFile,
    };
  }

  private async parseVitestJsonReport(reportPath: string | null): Promise<TestResults | null> {
    if (!reportPath) return null;

    try {
      const raw = await fs.readFile(reportPath, "utf-8");
      const parsed = JSON.parse(raw) as VitestJsonReport;
      const details: TestResultDetail[] = [];
      let derivedPassed = 0;
      let derivedFailed = 0;
      let derivedSkipped = 0;

      for (const suite of parsed.testResults ?? []) {
        for (const assertion of suite.assertionResults ?? []) {
          const rawStatus = assertion.status ?? "passed";
          const status: "passed" | "failed" | "skipped" =
            rawStatus === "passed" ? "passed" : rawStatus === "failed" ? "failed" : "skipped";
          if (status === "passed") derivedPassed += 1;
          else if (status === "failed") derivedFailed += 1;
          else derivedSkipped += 1;

          const failureMessages = (assertion.failureMessages ?? []).filter(Boolean);
          details.push({
            name: assertion.fullName || assertion.title || suite.name || "Unnamed test",
            status,
            duration: typeof assertion.duration === "number" ? assertion.duration : 0,
            ...(status === "failed" && failureMessages.length > 0
              ? { error: failureMessages.join("\n") }
              : {}),
          });
        }
      }

      const passed =
        typeof parsed.numPassedTests === "number" ? parsed.numPassedTests : derivedPassed;
      const failed =
        typeof parsed.numFailedTests === "number" ? parsed.numFailedTests : derivedFailed;
      const skipped =
        typeof parsed.numPendingTests === "number" ? parsed.numPendingTests : derivedSkipped;
      const total =
        typeof parsed.numTotalTests === "number" ? parsed.numTotalTests : passed + failed + skipped;

      if (total === 0 && details.length === 0) return null;
      return { passed, failed, skipped, total, details };
    } catch {
      return null;
    } finally {
      await fs.rm(reportPath, { force: true }).catch(() => {});
    }
  }

  private buildVitestCommand(mode: "run" | "related", files: string[]): string {
    const fileArgs = files.join(" ").trim();
    const base =
      mode === "run"
        ? "node ./node_modules/vitest/vitest.mjs run"
        : "node ./node_modules/vitest/vitest.mjs related --run";
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
