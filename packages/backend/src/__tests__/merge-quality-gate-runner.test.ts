import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/validation-workspace.service.js", () => ({
  ValidationWorkspaceService: class {
    async verifyWorkspaceHealth() {
      return { healthy: true, errors: [] };
    }
  },
  validationWorkspaceService: {
    verifyWorkspaceHealth: async () => ({ healthy: true, errors: [] }),
  },
}));

import {
  looksLikeEnoentOpeningMissingWorktreeSource,
  runMergeQualityGates,
} from "../services/merge-quality-gate-runner.js";
import { runCommand as runRealCommand } from "../utils/command-runner.js";

describe("looksLikeEnoentOpeningMissingWorktreeSource", () => {
  const wt = "/Users/me/proj/.opensprint/runtime/worktrees/os-abc";

  it("returns true for Node-style open path under worktree", () => {
    const msg = `Error: ENOENT: no such file or directory, open '${wt}/packages/frontend/src/lib/mermaidDiagram.ts'`;
    expect(looksLikeEnoentOpeningMissingWorktreeSource(msg, wt)).toBe(true);
  });

  it("returns true for worktrees rooted under /tmp", () => {
    const tmpWorktree = "/tmp/opensprint-worktrees/os-abc";
    const msg = `Error: ENOENT: no such file or directory, open '${tmpWorktree}/packages/backend/src/app.ts'`;
    expect(looksLikeEnoentOpeningMissingWorktreeSource(msg, tmpWorktree)).toBe(true);
  });

  it("returns false for node_modules paths", () => {
    const msg = `ENOENT: no such file or directory, open '${wt}/node_modules/foo/bar.ts'`;
    expect(looksLikeEnoentOpeningMissingWorktreeSource(msg, wt)).toBe(false);
  });

  it("returns false when worktree path does not prefix the opened file", () => {
    const msg = `Error: ENOENT: no such file or directory, open '/other/repo/src/a.ts'`;
    expect(looksLikeEnoentOpeningMissingWorktreeSource(msg, wt)).toBe(false);
  });
});

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
      .filter(
        (label) =>
          label !== "node -v" &&
          label !== "npm -v" &&
          label !== "git rev-parse --verify HEAD" &&
          label !== "git rev-parse --show-toplevel" &&
          label !== "git status --porcelain" &&
          label !== "git diff --name-status HEAD"
      );

  const makeTempWorktree = async (
    scripts?: Record<string, string>,
    includeNodeModules = true
  ): Promise<string> => {
    const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), "merge-quality-gate-runner-"));
    tempDirs.push(worktreePath);
    await fs.writeFile(path.join(worktreePath, ".git"), "gitdir: /tmp/fake-git-dir");
    if (scripts) {
      await fs.writeFile(
        path.join(worktreePath, "package.json"),
        JSON.stringify({ name: "tmp-app", version: "1.0.0", scripts }, null, 2)
      );
      await fs.writeFile(
        path.join(worktreePath, "package-lock.json"),
        JSON.stringify(
          {
            name: "tmp-app",
            version: "1.0.0",
            lockfileVersion: 3,
            requires: true,
            packages: {},
          },
          null,
          2
        )
      );
    }
    if (includeNodeModules) {
      await fs.mkdir(path.join(worktreePath, "node_modules"), { recursive: true });
      await fs.writeFile(path.join(worktreePath, "node_modules", ".package-lock.json"), "{}");
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

  it("adds local-session auth hint when Vitest reports 401/403 vs 200 assertion drift", async () => {
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
            stderr: "AssertionError: expected 401 to be 200",
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
        taskId: "os-auth-hint",
        branchName: "opensprint/os-auth-hint",
        baseBranch: "main",
      },
      {
        commands: ["npm run test"],
        runCommand,
      }
    );

    expect(failure?.classificationReason).toContain("authedSupertest");
    expect(failure?.classificationReason).toContain("withLocalSessionAuth");
  });

  it("prefers native module ABI errors over Vitest skipped-suite lines", async () => {
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
RUN  v3.2.4 /tmp/backend
↓ |backend-unit| src/__tests__/app-db-sqlite.test.ts (4 tests | 4 skipped)
❯ |backend-integration| src/__tests__/schema-tasks-index.integration.test.ts (1 test | 1 failed)
   × tasks composite index (SQLite) > creates idx_tasks_project_id_status on tasks
     → The module '/repo/node_modules/better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using
NODE_MODULE_VERSION 145. This version of Node.js requires
NODE_MODULE_VERSION 137. Please try re-compiling or re-installing
the module (for instance, using \`npm rebuild\` or \`npm install\`).
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
        taskId: "os-native-abi",
        branchName: "opensprint/os-native-abi",
        baseBranch: "main",
      },
      {
        commands: ["npm run test"],
        runCommand,
      }
    );

    expect(failure?.firstErrorLine).toMatch(/compiled against a different Node\.js version/i);
  });

  it("redacts bearer tokens, sk- keys, and integration env assignments from gate failure output", async () => {
    const worktreePath = await makeTempWorktree({ test: "vitest run" });
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const skLeak = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789AB";
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
        const label = commandLabel(spec);
        if (label === "git rev-parse --verify HEAD") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm run test") {
          throw makeCommandFailure(spec, options.cwd, {
            message: `Command failed: npm run test | Authorization: Bearer ${jwt}`,
            stderr: `FAIL src/x.test.ts
Authorization: Bearer ${jwt}
TODOIST_API_TOKEN=td-not-a-real-todoist-token
invalid ${skLeak}
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
        taskId: "os-gate-redact",
        branchName: "opensprint/os-gate-redact",
        baseBranch: "main",
      },
      {
        commands: ["npm run test"],
        runCommand,
      }
    );

    expect(failure).toBeDefined();
    const blob = `${failure!.reason}\n${failure!.output}\n${failure!.outputSnippet ?? ""}\n${failure!.firstErrorLine}`;
    expect(blob).not.toContain(jwt);
    expect(blob).not.toContain(skLeak);
    expect(blob).not.toContain("td-not-a-real-todoist-token");
    expect(blob).toMatch(/TODOIST_API_TOKEN=\[REDACTED\]/i);
    expect(blob).toMatch(/Authorization:\s*\[REDACTED\]/i);
    expect(getExecutedCommands(runCommand)).toEqual(["npm run test"]);
  });

  it("ignores vitest stdout channel lines that embed structured INFO logs when extracting the first error", async () => {
    const worktreePath = await makeTempWorktree({ test: "vitest run" });
    const noisyStdoutLine =
      'stdout | src/__tests__/merge-quality-gate-regression.integration.test.ts > Cross-service quality-gate regression integration > requeues non-environment quality-gate failures without repair and persists structured details 2026-04-05T16:50:37.598Z INFO  [merge-coordinator] Merge failure fingerprint {"taskId":"os-regression-1","fingerprintHash":"8b209c601f34b6c0","failureClass":"code_quality","normalizedMessage":"Quality gate failed (npm run lint): Command failed: npm run lint | src/foo.ts: error TS2304: Cannot find name \'x\'","phase":"quality_gate"}';
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
        const label = commandLabel(spec);
        if (label === "git rev-parse --verify HEAD") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm run test") {
          throw makeCommandFailure(spec, options.cwd, {
            message: "Command failed with exit code 1",
            stdout: `${noisyStdoutLine}\nFAIL  src/real.test.ts > Example > breaks\nAssertionError: expected true to be false\n`,
            stderr: "",
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
        taskId: "os-stdout-noise",
        branchName: "opensprint/os-stdout-noise",
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
        firstErrorLine: "AssertionError: expected true to be false",
      })
    );
    expect(failure?.outputSnippet).not.toContain("Merge failure fingerprint");
    expect(getExecutedCommands(runCommand)).toEqual(["npm run test"]);
  });

  it("ignores bare structured logger lines (split from vitest stdout prefix) when extracting the first error", async () => {
    const worktreePath = await makeTempWorktree({ test: "vitest run" });
    const stdoutBlock =
      "stdout | src/__tests__/merge-quality-gate-regression.integration.test.ts > Cross-service quality-gate regression integration > requeues non-environment quality-gate failures without repair and persists structured details\n" +
      '2026-04-05T17:53:03.975Z INFO  [merge-coordinator] Merge failure fingerprint {"taskId":"os-regression-1","fingerprintHash":"8b209c601f34b6c0","failureClass":"code_quality","normalizedMessage":"Quality gate failed (npm run lint): Command failed: npm run lint | src/foo.ts: error TS2304: Cannot find name \'x\'","phase":"quality_gate"}\n' +
      "FAIL  src/real.test.ts > Example > breaks\nAssertionError: expected true to be false\n";
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
        const label = commandLabel(spec);
        if (label === "git rev-parse --verify HEAD") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm run test") {
          throw makeCommandFailure(spec, options.cwd, {
            message: "Command failed with exit code 1",
            stdout: stdoutBlock,
            stderr: "",
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
        taskId: "os-bare-log-noise",
        branchName: "opensprint/os-bare-log-noise",
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
        firstErrorLine: "AssertionError: expected true to be false",
      })
    );
    expect(failure?.outputSnippet).not.toContain("Merge failure fingerprint");
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
    expect(getExecutedCommands(runCommand)).toEqual([
      "git checkout HEAD -- package.json",
      "npm ci",
    ]);
  });

  it("runs non-npm gates without package.json/node_modules prechecks", async () => {
    const worktreePath = await makeTempWorktree(undefined, false);
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
        if (commandLabel(spec) === "git rev-parse --verify HEAD") {
          return makeCommandResult(spec, options.cwd);
        }
        return makeCommandResult(spec, options.cwd);
      }
    );
    const failure = await runMergeQualityGates(
      {
        projectId: "proj-agnostic",
        repoPath: worktreePath,
        worktreePath,
        taskId: "os-agnostic",
        branchName: "opensprint/os-agnostic",
        baseBranch: "main",
      },
      {
        commands: ["git status --short"],
        runCommand,
      }
    );
    expect(failure).toBeNull();
    expect(getExecutedCommands(runCommand)).toEqual(["git status --short"]);
  });

  it("merged_candidate repair runs npm ci at repo root then symlinks before retry", async () => {
    const repoPath = await makeTempWorktree({ build: "tsc -b" }, true);
    const worktreePath = await makeTempWorktree({ build: "tsc -b" }, true);
    let buildAttempts = 0;
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
        const label = commandLabel(spec);
        if (label === "git rev-parse --verify HEAD") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm ls --depth=0 --include=dev") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm run build") {
          buildAttempts += 1;
          if (buildAttempts === 1) {
            throw makeCommandFailure(spec, options.cwd, {
              message: "Command failed with exit code 1",
              stderr: "Error: spawn tsc ENOENT",
            });
          }
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm ci") {
          return makeCommandResult(spec, options.cwd);
        }
        return makeCommandResult(spec, options.cwd);
      }
    );
    const symlinkNodeModules = vi.fn(async () => undefined);

    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath,
        worktreePath,
        taskId: "os-5",
        branchName: "opensprint/os-5",
        baseBranch: "main",
        validationWorkspace: "merged_candidate",
      },
      {
        commands: ["npm run build"],
        runCommand,
        symlinkNodeModules,
      }
    );

    expect(failure).toBeNull();
    expect(symlinkNodeModules).toHaveBeenCalledWith(
      await fs.realpath(repoPath),
      await fs.realpath(worktreePath)
    );
    const executed = getExecutedCommands(runCommand);
    expect(executed).toContain("npm run build");
    expect(executed.filter((c) => c === "npm run build")).toHaveLength(2);
  });

  it("merged_candidate: symlink succeeds even when npm ci fails in repair", async () => {
    const repoPath = await makeTempWorktree({ build: "tsc -b" }, false);
    const worktreePath = await makeTempWorktree({ build: "tsc -b" }, false);
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
        const label = commandLabel(spec);
        if (label === "git rev-parse --verify HEAD") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm ls --depth=0 --include=dev") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm ci") {
          throw makeCommandFailure(spec, options.cwd, {
            message: "npm ci failed: network error",
            stderr: "npm ERR! network error",
          });
        }
        if (label === "npm run build") {
          return makeCommandResult(spec, options.cwd);
        }
        return makeCommandResult(spec, options.cwd);
      }
    );
    const symlinkNodeModules = vi.fn(async (_repo: string, wtPath: string) => {
      const nm = path.join(wtPath, "node_modules");
      await fs.mkdir(nm, { recursive: true });
      await fs.writeFile(path.join(nm, ".package-lock.json"), "{}");
    });

    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath,
        worktreePath,
        taskId: "os-mc-1",
        branchName: "opensprint/os-mc-1",
        baseBranch: "main",
        validationWorkspace: "merged_candidate",
      },
      {
        commands: ["npm run build"],
        runCommand,
        symlinkNodeModules,
      }
    );

    expect(failure).toBeNull();
    expect(symlinkNodeModules).toHaveBeenCalledWith(
      await fs.realpath(repoPath),
      await fs.realpath(worktreePath)
    );
    const executed = getExecutedCommands(runCommand);
    expect(executed).toContain("npm run build");
  });

  it("merged_candidate: returns actionable error when all repair strategies fail", async () => {
    const repoPath = await makeTempWorktree({ build: "tsc -b" }, false);
    const worktreePath = await makeTempWorktree({ build: "tsc -b" }, false);
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
        const label = commandLabel(spec);
        if (label === "git rev-parse --verify HEAD") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm ci") {
          throw makeCommandFailure(spec, options.cwd, {
            message: "npm ci failed",
            stderr: "npm ERR! code ENOLOCK\nnpm ERR! This command requires an existing lockfile.",
          });
        }
        if (label === "git checkout HEAD -- package.json") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm ls --depth=0 --include=dev") {
          return makeCommandResult(spec, options.cwd);
        }
        return makeCommandResult(spec, options.cwd);
      }
    );
    const symlinkNodeModules = vi.fn(async () => undefined);

    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath,
        worktreePath,
        taskId: "os-mc-2",
        branchName: "opensprint/os-mc-2",
        baseBranch: "main",
        validationWorkspace: "merged_candidate",
      },
      {
        commands: ["npm run build"],
        runCommand,
        symlinkNodeModules,
      }
    );

    expect(failure).not.toBeNull();
    expect(failure!.autoRepairAttempted).toBe(true);
    expect(failure!.autoRepairSucceeded).toBe(false);
    expect(failure!.category).toBe("environment_setup");
    expect(failure!.autoRepairOutput).toMatch(/node_modules.*missing|npm ci/i);
    expect(failure!.autoRepairOutput).toContain("npm ci");
  });

  it("merged_candidate: node_modules assertion catches broken state after repair", async () => {
    const repoPath = await makeTempWorktree({ build: "tsc -b" }, false);
    const worktreePath = await makeTempWorktree({ build: "tsc -b" }, false);
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
        const label = commandLabel(spec);
        if (label === "git rev-parse --verify HEAD") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm ci") {
          return makeCommandResult(spec, options.cwd);
        }
        return makeCommandResult(spec, options.cwd);
      }
    );
    const symlinkNodeModules = vi.fn(async () => undefined);

    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath,
        worktreePath,
        taskId: "os-mc-3",
        branchName: "opensprint/os-mc-3",
        baseBranch: "main",
        validationWorkspace: "merged_candidate",
      },
      {
        commands: ["npm run build"],
        runCommand,
        symlinkNodeModules,
      }
    );

    expect(failure).not.toBeNull();
    expect(failure!.autoRepairAttempted).toBe(true);
    expect(failure!.autoRepairSucceeded).toBe(false);
    expect(failure!.autoRepairOutput).toContain("node_modules is missing, empty, or inaccessible");
    expect(failure!.autoRepairOutput).toContain("npm ci");
  });

  it("merged_candidate: succeeds without repair when node_modules is already healthy", async () => {
    const worktreePath = await makeTempWorktree({ build: "tsc -b" }, true);
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
        const label = commandLabel(spec);
        if (label === "git rev-parse --verify HEAD") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm ls --depth=0 --include=dev") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm run build") {
          return makeCommandResult(spec, options.cwd);
        }
        return makeCommandResult(spec, options.cwd);
      }
    );
    const symlinkNodeModules = vi.fn(async () => undefined);

    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath: worktreePath,
        worktreePath,
        taskId: "os-mc-4",
        branchName: "opensprint/os-mc-4",
        baseBranch: "main",
        validationWorkspace: "merged_candidate",
      },
      {
        commands: ["npm run build"],
        runCommand,
        symlinkNodeModules,
      }
    );

    expect(failure).toBeNull();
    expect(symlinkNodeModules).not.toHaveBeenCalled();
    const commands = getExecutedCommands(runCommand);
    expect(commands).toEqual(["npm ls --depth=0 --include=dev", "npm run build"]);
  });

  it("merged_candidate repair runs npm ci when repo deps are unhealthy even if node_modules exists", async () => {
    const repoPath = await makeTempWorktree({ build: "tsc -b" }, true);
    const worktreePath = await makeTempWorktree({ build: "tsc -b" }, true);
    const resolvedRepoPath = await fs.realpath(repoPath);
    let buildAttempts = 0;
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
        const label = commandLabel(spec);
        if (label === "git rev-parse --verify HEAD") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm ls --depth=0 --include=dev") {
          if (options.cwd === resolvedRepoPath) {
            throw makeCommandFailure(spec, options.cwd, {
              message: "Dependency setup check failed",
              stderr: "Error: Cannot find module 'better-sqlite3'",
            });
          }
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm run build") {
          buildAttempts += 1;
          if (buildAttempts === 1) {
            throw makeCommandFailure(spec, options.cwd, {
              message: "Command failed with exit code 1",
              stderr: "Error: Cannot find module 'better-sqlite3'",
            });
          }
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm ci") {
          return makeCommandResult(spec, options.cwd);
        }
        return makeCommandResult(spec, options.cwd);
      }
    );
    const symlinkNodeModules = vi.fn(async () => undefined);

    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath,
        worktreePath,
        taskId: "os-mc-repo-health",
        branchName: "opensprint/os-mc-repo-health",
        baseBranch: "main",
        validationWorkspace: "merged_candidate",
      },
      {
        commands: ["npm run build"],
        runCommand,
        symlinkNodeModules,
      }
    );

    expect(failure).toBeNull();
    expect(symlinkNodeModules).toHaveBeenCalledWith(
      resolvedRepoPath,
      await fs.realpath(worktreePath)
    );
    const npmCiCalls = runCommand.mock.calls.filter(
      (call) =>
        commandLabel(call[0] as { command: string; args?: string[] }) === "npm ci" &&
        (call[1] as { cwd: string }).cwd === resolvedRepoPath
    );
    expect(npmCiCalls).toHaveLength(1);
  });

  it("marks ambiguous environment fingerprints with low confidence", async () => {
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
            stderr: "Error: Cannot find module '@app/shared' imported from src/server.ts",
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
        taskId: "os-ambiguous",
        branchName: "opensprint/os-ambiguous",
        baseBranch: "main",
      },
      {
        commands: ["npm run build"],
        runCommand,
      }
    );

    expect(failure).toEqual(
      expect.objectContaining({
        category: "environment_setup",
        classificationConfidence: "low",
      })
    );
    expect(failure?.classificationReason).toContain("ambiguous");
  });

  it("classifies project-resolution failures as high-confidence environment setup", async () => {
    const worktreePath = await makeTempWorktree({ build: "tsc -b" });
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
        const label = commandLabel(spec);
        if (label === "git rev-parse --verify HEAD") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm run build") {
          throw makeCommandFailure(spec, options.cwd, {
            message: "Cannot resolve project for repo path /tmp/repo",
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
        taskId: "os-proj-resolution",
        branchName: "opensprint/os-proj-resolution",
        baseBranch: "main",
      },
      {
        commands: ["npm run build"],
        runCommand,
      }
    );

    expect(failure).toEqual(
      expect.objectContaining({
        category: "environment_setup",
        classificationConfidence: "high",
      })
    );
  });

  it("classifies TS compiler diagnostics as quality-gate failures", async () => {
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
            stderr:
              "src/app.ts(1,18): error TS2307: Cannot find module 'path' or its corresponding type declarations.",
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
        taskId: "os-ts2307",
        branchName: "opensprint/os-ts2307",
        baseBranch: "main",
      },
      {
        commands: ["npm run build"],
        runCommand,
      }
    );

    expect(failure).toEqual(
      expect.objectContaining({
        category: "quality_gate",
        classificationConfidence: "high",
      })
    );
    expect(failure?.classificationReason).toContain("compiler/linter diagnostic");
  });

  it("fails precheck with high confidence when package-lock is missing for npm gates", async () => {
    const worktreePath = await makeTempWorktree({ build: "tsc -b" });
    await fs.rm(path.join(worktreePath, "package-lock.json"), { force: true });
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) =>
        makeCommandResult(spec, options.cwd)
    );

    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath: worktreePath,
        worktreePath,
        taskId: "os-lockfile",
        branchName: "opensprint/os-lockfile",
        baseBranch: "main",
      },
      {
        commands: ["npm run build"],
        runCommand,
      }
    );

    expect(failure).toEqual(
      expect.objectContaining({
        category: "environment_setup",
        classificationConfidence: "high",
      })
    );
    expect(failure?.reason).toContain("package-lock.json");
  });

  it("runs watch-by-default npm tests once in a noninteractive environment", async () => {
    const worktreePath = await makeTempWorktree({ test: "node test.cjs" });
    await fs.writeFile(
      path.join(worktreePath, "test.cjs"),
      "if (process.env.CI !== 'true') { console.log('watching'); setInterval(() => {}, 1000); }"
    );
    const runCommand = vi.fn(async (spec, options) => {
      if (commandLabel(spec) === "npm run test") {
        // Catch missing gate env even when this regression itself runs in CI.
        return runRealCommand(spec, {
          ...options,
          timeout: 2000,
          env: { CI: "false", ...options.env, PATH: process.env.PATH },
        });
      }
      return makeCommandResult(spec, options.cwd);
    });
    const failure = await runMergeQualityGates(
      {
        projectId: "proj-ci",
        repoPath: worktreePath,
        worktreePath,
        taskId: "os-ci",
        branchName: "opensprint/os-ci",
        baseBranch: "main",
      },
      { runCommand }
    );
    expect(failure).toBeNull();
  });

  it.each([
    [
      "validation_resource_busy",
      "Command timed out: npm run build",
      "Waiting for validation in /another/checkout (PID 123); running suites remain uninterrupted.",
    ],
    [
      "checkout_reserved",
      "Command failed: npm run build",
      "Checkout reserved by task another-owner. Use its task ID or another worktree.",
    ],
  ])(
    "reports %s without reinstalling dependencies or retrying the gate",
    async (classificationReason, message, stderr) => {
      const worktreePath = await makeTempWorktree({ build: "node build.js" });
      const runCommand = vi.fn(async (spec, options) => {
        if (commandLabel(spec) === "npm run build") {
          throw makeCommandFailure(spec, options.cwd, { message, stderr });
        }
        return makeCommandResult(spec, options.cwd);
      });
      const failure = await runMergeQualityGates(
        {
          projectId: "proj-busy",
          repoPath: worktreePath,
          worktreePath,
          taskId: "os-busy",
          branchName: "opensprint/os-busy",
          baseBranch: "main",
        },
        { runCommand }
      );
      expect(failure).toMatchObject({
        category: "environment_setup",
        classificationReason,
        autoRepairAttempted: false,
      });
      expect(getExecutedCommands(runCommand)).toEqual(["npm run build"]);
    }
  );

  it("repairs a missing dependency manifest even when its require stack has file locations", async () => {
    const worktreePath = await makeTempWorktree({ build: "node build.js" });
    let builds = 0;
    const runCommand = vi.fn(async (spec, options) => {
      if (commandLabel(spec) === "npm run build" && builds++ === 0) {
        throw makeCommandFailure(spec, options.cwd, {
          stderr: `Error: Cannot find module '../package.json'\nRequire stack:\n- ${worktreePath}/node_modules/react-scripts/config/paths.js\n    at Object.<anonymous> (${worktreePath}/node_modules/react-scripts/config/paths.js:135:24)`,
        });
      }
      return makeCommandResult(spec, options.cwd);
    });
    const failure = await runMergeQualityGates(
      {
        projectId: "proj-manifest",
        repoPath: worktreePath,
        worktreePath,
        taskId: "os-manifest",
        branchName: "opensprint/os-manifest",
        baseBranch: "main",
      },
      { runCommand, symlinkNodeModules: vi.fn(async () => undefined) }
    );
    expect(failure).toBeNull();
    expect(getExecutedCommands(runCommand)).toContain("npm ci");
    expect(builds).toBe(2);
  });

  it("injects deterministic merge-gate env for test command runs", async () => {
    const worktreePath = await makeTempWorktree({ test: "vitest run" });
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) =>
        makeCommandResult(spec, options.cwd)
    );

    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath: worktreePath,
        worktreePath,
        taskId: "os-det-env",
        branchName: "opensprint/os-det-env",
        baseBranch: "main",
        validationWorkspace: "task_worktree",
      },
      { runCommand }
    );

    expect(failure).toBeNull();
    const testCall = runCommand.mock.calls.find(
      (call) => commandLabel(call[0] as { command: string; args?: string[] }) === "npm run test"
    );
    expect(testCall).toBeDefined();
    const env = (testCall?.[1] as { env?: Record<string, string> | undefined })?.env;
    expect(env).toEqual(
      expect.objectContaining({
        OPENSPRINT_MERGE_GATE_TEST_MODE: "1",
        OPENSPRINT_VITEST_INTEGRATION_MAX_WORKERS: "2",
        NODE_ENV: "test",
      })
    );
    expect(env?.OPENSPRINT_VITEST_RUN_ID).toMatch(/^mergegate_/);
  });

  it("does not inject deterministic merge-gate env when default profile is requested", async () => {
    const worktreePath = await makeTempWorktree({ test: "vitest run" });
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) =>
        makeCommandResult(spec, options.cwd)
    );

    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath: worktreePath,
        worktreePath,
        taskId: "os-default-env",
        branchName: "opensprint/os-default-env",
        baseBranch: "main",
        qualityGateProfile: "default",
      },
      { runCommand }
    );

    expect(failure).toBeNull();
    const testCall = runCommand.mock.calls.find(
      (call) => commandLabel(call[0] as { command: string; args?: string[] }) === "npm run test"
    );
    expect(testCall).toBeDefined();
    const env = (testCall?.[1] as { env?: Record<string, string> | undefined })?.env;
    expect(env).toEqual({ CI: "true" });
  });

  describe("merged_candidate: missing node_modules precheck regression", () => {
    it("detects absent node_modules and reports environment_setup before running any gate", async () => {
      const repoPath = await makeTempWorktree({ build: "tsc -b" }, true);
      const worktreePath = await makeTempWorktree({ build: "tsc -b" }, false);
      const runCommand = vi.fn(
        async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
          const label = commandLabel(spec);
          if (label === "git rev-parse --verify HEAD") {
            return makeCommandResult(spec, options.cwd);
          }
          if (label === "npm ci") {
            return makeCommandResult(spec, options.cwd);
          }
          if (label === "npm ls --depth=0 --include=dev") {
            return makeCommandResult(spec, options.cwd);
          }
          return makeCommandResult(spec, options.cwd);
        }
      );
      const symlinkNodeModules = vi.fn(async () => undefined);

      const failure = await runMergeQualityGates(
        {
          projectId: "proj-mc-precheck",
          repoPath,
          worktreePath,
          taskId: "os-mc-precheck-1",
          branchName: "opensprint/os-mc-precheck-1",
          baseBranch: "main",
          validationWorkspace: "merged_candidate",
        },
        {
          commands: ["npm run build"],
          runCommand,
          symlinkNodeModules,
        }
      );

      expect(failure).not.toBeNull();
      expect(failure!.category).toBe("environment_setup");
      expect(failure!.reason).toMatch(/node_modules.*missing|empty/i);
      expect(failure!.validationWorkspace).toBe("merged_candidate");
      expect(failure!.autoRepairAttempted).toBe(true);
      const gateCommands = getExecutedCommands(runCommand);
      expect(gateCommands).not.toContain("npm run build");
    });

    it("repair failure with npm ci stderr produces actionable environment_setup message", async () => {
      const repoPath = await makeTempWorktree({ build: "tsc -b" }, false);
      const worktreePath = await makeTempWorktree({ build: "tsc -b" }, false);
      const npmCiStderr =
        "npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree";
      const runCommand = vi.fn(
        async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
          const label = commandLabel(spec);
          if (label === "git rev-parse --verify HEAD") {
            return makeCommandResult(spec, options.cwd);
          }
          if (label === "npm ci") {
            throw makeCommandFailure(spec, options.cwd, {
              message: "npm ci failed: dependency resolution error",
              stderr: npmCiStderr,
            });
          }
          if (label === "git checkout HEAD -- package.json") {
            return makeCommandResult(spec, options.cwd);
          }
          if (label === "npm ls --depth=0 --include=dev") {
            return makeCommandResult(spec, options.cwd);
          }
          return makeCommandResult(spec, options.cwd);
        }
      );
      const symlinkNodeModules = vi.fn(async () => undefined);

      const failure = await runMergeQualityGates(
        {
          projectId: "proj-mc-npmci-fail",
          repoPath,
          worktreePath,
          taskId: "os-mc-npmci-1",
          branchName: "opensprint/os-mc-npmci-1",
          baseBranch: "main",
          validationWorkspace: "merged_candidate",
        },
        {
          commands: ["npm run build"],
          runCommand,
          symlinkNodeModules,
        }
      );

      expect(failure).not.toBeNull();
      expect(failure!.category).toBe("environment_setup");
      expect(failure!.autoRepairAttempted).toBe(true);
      expect(failure!.autoRepairSucceeded).toBe(false);
      expect(failure!.autoRepairOutput).toContain("ERESOLVE");
      expect(failure!.autoRepairOutput).toContain("npm ci");
    });

    it("network failure during npm ci repair surfaces stderr in the output", async () => {
      const repoPath = await makeTempWorktree({ test: "vitest run" }, false);
      const worktreePath = await makeTempWorktree({ test: "vitest run" }, false);
      const networkStderr =
        "npm ERR! code ETIMEDOUT\nnpm ERR! network request to https://registry.npmjs.org failed";
      const runCommand = vi.fn(
        async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
          const label = commandLabel(spec);
          if (label === "git rev-parse --verify HEAD") {
            return makeCommandResult(spec, options.cwd);
          }
          if (label === "npm ci") {
            throw makeCommandFailure(spec, options.cwd, {
              message: "npm ci failed: network timeout",
              stderr: networkStderr,
            });
          }
          if (label === "git checkout HEAD -- package.json") {
            return makeCommandResult(spec, options.cwd);
          }
          return makeCommandResult(spec, options.cwd);
        }
      );
      const symlinkNodeModules = vi.fn(async () => undefined);

      const failure = await runMergeQualityGates(
        {
          projectId: "proj-mc-network",
          repoPath,
          worktreePath,
          taskId: "os-mc-network-1",
          branchName: "opensprint/os-mc-network-1",
          baseBranch: "main",
          validationWorkspace: "merged_candidate",
        },
        {
          commands: ["npm run test"],
          runCommand,
          symlinkNodeModules,
        }
      );

      expect(failure).not.toBeNull();
      expect(failure!.category).toBe("environment_setup");
      expect(failure!.autoRepairAttempted).toBe(true);
      expect(failure!.autoRepairOutput).toContain("ETIMEDOUT");
      expect(failure!.autoRepairOutput).toContain("registry.npmjs.org");
    });

    it("retries npm test after tinypool/emitter worker crash fingerprint", async () => {
      const repoPath = await makeTempWorktree({ test: "vitest run" }, true);
      const worktreePath = await makeTempWorktree({ test: "vitest run" }, true);
      let testAttempts = 0;
      const runCommand = vi.fn(
        async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
          const label = commandLabel(spec);
          if (label === "git rev-parse --verify HEAD") {
            return makeCommandResult(spec, options.cwd);
          }
          if (label === "npm run test") {
            testAttempts += 1;
            if (testAttempts === 1) {
              throw makeCommandFailure(spec, options.cwd, {
                message: "Command failed with exit code 1",
                stderr:
                  "Error: Cannot find module '/tmp/repo/node_modules/tinypool/dist/entry/process.js'\nTypeError: emitter.removeListener is not a function",
              });
            }
            return makeCommandResult(spec, options.cwd);
          }
          if (label === "npm ci") {
            return makeCommandResult(spec, options.cwd);
          }
          return makeCommandResult(spec, options.cwd);
        }
      );
      const symlinkNodeModules = vi.fn(async () => undefined);

      const failure = await runMergeQualityGates(
        {
          projectId: "proj-mc-tinypool",
          repoPath,
          worktreePath,
          taskId: "os-mc-tinypool-1",
          branchName: "opensprint/os-mc-tinypool-1",
          baseBranch: "main",
          validationWorkspace: "task_worktree",
        },
        {
          commands: ["npm run test"],
          runCommand,
          symlinkNodeModules,
        }
      );

      expect(failure).toBeNull();
      const gateCommands = getExecutedCommands(runCommand);
      expect(gateCommands).toContain("npm ci");
      expect(gateCommands.filter((label) => label === "npm run test")).toHaveLength(2);
      expect(symlinkNodeModules).toHaveBeenCalledTimes(1);
    });

    it("lockfile missing triggers different precheck than node_modules missing", async () => {
      const worktreePath = await makeTempWorktree({ build: "tsc -b" }, true);
      await fs.rm(path.join(worktreePath, "package-lock.json"), { force: true });
      const runCommand = vi.fn(
        async (spec: { command: string; args?: string[] }, options: { cwd: string }) =>
          makeCommandResult(spec, options.cwd)
      );

      const lockfileFailure = await runMergeQualityGates(
        {
          projectId: "proj-lockfile-vs-nm",
          repoPath: worktreePath,
          worktreePath,
          taskId: "os-lockfile-vs-nm",
          branchName: "opensprint/os-lockfile-vs-nm",
          baseBranch: "main",
          validationWorkspace: "merged_candidate",
        },
        {
          commands: ["npm run build"],
          runCommand,
        }
      );

      expect(lockfileFailure).not.toBeNull();
      expect(lockfileFailure!.category).toBe("environment_setup");
      expect(lockfileFailure!.reason).toContain("package-lock.json");
      expect(lockfileFailure!.reason).not.toContain("node_modules");

      const worktreePath2 = await makeTempWorktree({ build: "tsc -b" }, false);
      const runCommand2 = vi.fn(
        async (spec: { command: string; args?: string[] }, options: { cwd: string }) =>
          makeCommandResult(spec, options.cwd)
      );

      const nmFailure = await runMergeQualityGates(
        {
          projectId: "proj-lockfile-vs-nm",
          repoPath: worktreePath2,
          worktreePath: worktreePath2,
          taskId: "os-nm-vs-lockfile",
          branchName: "opensprint/os-nm-vs-lockfile",
          baseBranch: "main",
          validationWorkspace: "merged_candidate",
        },
        {
          commands: ["npm run build"],
          runCommand: runCommand2,
        }
      );

      expect(nmFailure).not.toBeNull();
      expect(nmFailure!.category).toBe("environment_setup");
      expect(nmFailure!.reason).toContain("node_modules");
    });
  });

  it("supports language-agnostic gates when dependency strategy is none", async () => {
    const worktreePath = await makeTempWorktree(undefined, false);
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) =>
        makeCommandResult(spec, options.cwd)
    );

    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath: worktreePath,
        worktreePath,
        taskId: "os-lang-agnostic",
        branchName: "opensprint/os-lang-agnostic",
        baseBranch: "main",
        toolchainProfile: {
          dependencyStrategy: "none",
          mergeQualityGateCommands: ["node --version"],
          deterministicTestCommand: "node --version",
          deterministicTestEnv: { PYTEST_ADDOPTS: "--maxfail=1" },
        },
      },
      { runCommand }
    );

    expect(failure).toBeNull();
    expect(getExecutedCommands(runCommand)).toEqual(["node --version"]);
  });

  it("injects deterministic env for custom test command in toolchain profile", async () => {
    const worktreePath = await makeTempWorktree(undefined, false);
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) =>
        makeCommandResult(spec, options.cwd)
    );

    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath: worktreePath,
        worktreePath,
        taskId: "os-custom-det-env",
        branchName: "opensprint/os-custom-det-env",
        baseBranch: "main",
        toolchainProfile: {
          dependencyStrategy: "none",
          mergeQualityGateCommands: ["node --version"],
          deterministicTestCommand: "node --version",
          deterministicTestEnv: { PYTEST_ADDOPTS: "--maxfail=1" },
        },
      },
      { runCommand }
    );

    expect(failure).toBeNull();
    const testCall = runCommand.mock.calls.find(
      (call) => commandLabel(call[0] as { command: string; args?: string[] }) === "node --version"
    );
    expect(testCall).toBeDefined();
    const env = (testCall?.[1] as { env?: Record<string, string> | undefined })?.env;
    expect(env).toEqual(
      expect.objectContaining({
        OPENSPRINT_MERGE_GATE_TEST_MODE: "1",
        PYTEST_ADDOPTS: "--maxfail=1",
        NODE_ENV: "test",
      })
    );
  });

  it("classifies ENOENT opening a worktree .ts file as quality_gate (not environment_setup)", async () => {
    const worktreePath = await makeTempWorktree({ lint: "eslint ." });
    const wt = worktreePath;
    const runCommand = vi.fn(
      async (spec: { command: string; args?: string[] }, options: { cwd: string }) => {
        const label = commandLabel(spec);
        if (label === "git rev-parse --verify HEAD") {
          return makeCommandResult(spec, options.cwd);
        }
        if (label === "npm run lint") {
          throw makeCommandFailure(spec, options.cwd, {
            message: "Command failed: npm run lint",
            stderr: `Error: ENOENT: no such file or directory, open '${wt}/packages/frontend/src/lib/mermaidDiagram.ts'`,
            exitCode: 1,
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
        taskId: "os-enoent-classify",
        branchName: "opensprint/os-enoent-classify",
        baseBranch: "main",
      },
      { runCommand }
    );

    expect(failure?.category).toBe("quality_gate");
    expect(failure?.classificationReason).toContain("missing_worktree_source_file");
    expect(failure?.gitStatusPorcelainSnippet).toBeDefined();
  });
});
