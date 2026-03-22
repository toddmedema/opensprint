import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMergeQualityGates } from "../services/merge-quality-gate-runner.js";

describe("runMergeQualityGates", () => {
  let previousNodeEnv: string | undefined;
  const tempDirs: string[] = [];

  const commandLabel = (spec: { command: string; args?: string[] }): string =>
    [spec.command, ...(spec.args ?? [])].join(" ");

  const makeCommandResult = (spec: { command: string }, cwd: string) => ({
    stdout: "",
    stderr: "",
    executable: `/mock/bin/${spec.command}`,
    cwd,
    exitCode: 0,
    signal: null,
  });

  const makeCommandFailure = (
    spec: { command: string; args?: string[] },
    cwd: string,
    params: {
      message?: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    }
  ) => ({
    message: params.message ?? `Command failed: ${commandLabel(spec)}`,
    stdout: params.stdout ?? "",
    stderr: params.stderr ?? "",
    executable: `/mock/bin/${spec.command}`,
    cwd,
    exitCode: params.exitCode ?? 1,
    signal: null,
  });

  const getExecutedCommands = (runCommand: ReturnType<typeof vi.fn>): string[] =>
    runCommand.mock.calls
      .map((call) => commandLabel(call[0] as { command: string; args?: string[] }))
      .filter((label) => label !== "git rev-parse --verify HEAD");

  const makeTempWorktree = async (
    scripts?: Record<string, string>,
    includeNodeModules = true
  ): Promise<string> => {
    const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), "merge-quality-gate-runner-"));
    tempDirs.push(worktreePath);
    if (scripts) {
      await fs.writeFile(
        path.join(worktreePath, "package.json"),
        JSON.stringify({ name: "tmp-app", version: "1.0.0", scripts }, null, 2)
      );
    }
    if (includeNodeModules) {
      await fs.mkdir(path.join(worktreePath, "node_modules"), { recursive: true });
    }
    return worktreePath;
  };

  beforeEach(() => {
    previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
  });

  afterEach(async () => {
    process.env.NODE_ENV = previousNodeEnv;
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  it("extracts actionable assertion failures from noisy vitest output", async () => {
    const worktreePath = await makeTempWorktree({ test: "vitest run" });
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
        const label = commandLabel(spec);
        if (label === "git rev-parse --verify HEAD") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm run test") {
          throw makeCommandFailure(spec, options.cwd, {
            message: "Command failed with exit code 1",
            stderr: `
> app@1.0.0 test
> vitest run

RUN  v3.0.0 /tmp/project
stderr | src/example.test.ts > Example > still renders
✓ src/other.test.ts > passes
FAIL  src/example.test.ts > Example > still renders
AssertionError: expected 200 to be 201
Expected: 201
Received: 200
    at src/example.test.ts:42:10
`,
          });
        }
        return makeCommandResult(spec, options.cwd);
      }
    );

    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath: worktreePath,
        worktreePath,
        taskId: "os-1",
        branchName: "opensprint/os-1",
        baseBranch: "main",
      },
      {
        commands: ["npm run test"],
        runCommand,
      }
    );

    expect(failure).toEqual(
      expect.objectContaining({
        command: "npm run test",
        firstErrorLine: "AssertionError: expected 200 to be 201",
        outputSnippet: expect.stringContaining(
          "FAIL  src/example.test.ts > Example > still renders"
        ),
      })
    );
    expect(failure?.outputSnippet).toContain("Expected: 201");
    expect(failure?.outputSnippet).not.toContain("✓ src/other.test.ts > passes");
    expect(getExecutedCommands(runCommand)).toEqual(["npm run test"]);
  });

  it("prefers compiler and lint diagnostics over generic command wrappers", async () => {
    const worktreePath = await makeTempWorktree({ build: "tsc -b" });
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
        const label = commandLabel(spec);
        if (label === "git rev-parse --verify HEAD") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm run build") {
          throw makeCommandFailure(spec, options.cwd, {
            message: "Command failed with exit code 1",
            stderr: `
> app@1.0.0 build
> tsc -b

src/server.ts(18,7): error TS2304: Cannot find name 'missingValue'.
src/server.ts(19,3): error TS2552: Cannot find name 'handler'. Did you mean 'Headers'?
`,
          });
        }
        return makeCommandResult(spec, options.cwd);
      }
    );

    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath: worktreePath,
        worktreePath,
        taskId: "os-2",
        branchName: "opensprint/os-2",
        baseBranch: "main",
      },
      {
        commands: ["npm run build"],
        runCommand,
      }
    );

    expect(failure).toEqual(
      expect.objectContaining({
        firstErrorLine: "src/server.ts(18,7): error TS2304: Cannot find name 'missingValue'.",
      })
    );
    expect(failure?.outputSnippet).toContain("error TS2552");
    expect(failure?.outputSnippet).not.toContain("> app@1.0.0 build");
    expect(getExecutedCommands(runCommand)).toEqual(["npm run build"]);
  });

  it("skips npm run gates when the script is not defined in package.json", async () => {
    const worktreePath = await makeTempWorktree({
      test: "vitest run",
    });
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
        const label = commandLabel(spec);
        if (label === "git rev-parse --verify HEAD") {
          return makeCommandResult(spec, options.cwd);
        }
        return makeCommandResult(spec, options.cwd);
      }
    );

    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath: worktreePath,
        worktreePath,
        taskId: "os-3",
        branchName: "opensprint/os-3",
        baseBranch: "main",
      },
      {
        commands: ["npm run build", "npm run lint", "npm run test"],
        runCommand,
      }
    );

    expect(failure).toBeNull();
    expect(getExecutedCommands(runCommand)).toEqual(["npm run test"]);
  });

  it("falls back to executing gates when package.json is missing", async () => {
    const worktreePath = await makeTempWorktree(undefined, false);
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) =>
        makeCommandResult(spec, options.cwd)
    );
    const symlinkNodeModules = vi.fn(async () => undefined);

    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath: worktreePath,
        worktreePath,
        taskId: "os-4",
        branchName: "opensprint/os-4",
        baseBranch: "main",
      },
      {
        commands: ["npm run build"],
        runCommand,
        symlinkNodeModules,
      }
    );

    expect(failure).toEqual(
      expect.objectContaining({
        command: "npm run build",
      })
    );
    expect(getExecutedCommands(runCommand)).toEqual(["git checkout HEAD -- package.json", "npm ci"]);
  });
});
