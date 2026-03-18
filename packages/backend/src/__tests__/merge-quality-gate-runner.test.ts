import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMergeQualityGates } from "../services/merge-quality-gate-runner.js";

describe("runMergeQualityGates", () => {
  let previousNodeEnv: string | undefined;
  const tempDirs: string[] = [];

  const makeTempWorktree = async (scripts?: Record<string, string>): Promise<string> => {
    const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), "merge-quality-gate-runner-"));
    tempDirs.push(worktreePath);
    if (scripts) {
      await fs.writeFile(
        path.join(worktreePath, "package.json"),
        JSON.stringify({ name: "tmp-app", version: "1.0.0", scripts }, null, 2)
      );
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
    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath: "/tmp/repo",
        worktreePath: "/tmp/worktree",
        taskId: "os-1",
        branchName: "opensprint/os-1",
        baseBranch: "main",
      },
      {
        commands: ["npm run test"],
        shellExec: async () => {
          throw {
            message: "Command failed with exit code 1",
            stderr: `
> app@1.0.0 test
> vitest run

RUN  v3.0.0 /tmp/worktree
stderr | src/example.test.ts > Example > still renders
✓ src/other.test.ts > passes
FAIL  src/example.test.ts > Example > still renders
AssertionError: expected 200 to be 201
Expected: 201
Received: 200
    at src/example.test.ts:42:10
`,
          };
        },
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
  });

  it("prefers compiler and lint diagnostics over generic command wrappers", async () => {
    const failure = await runMergeQualityGates(
      {
        projectId: "proj-1",
        repoPath: "/tmp/repo",
        worktreePath: "/tmp/worktree",
        taskId: "os-2",
        branchName: "opensprint/os-2",
        baseBranch: "main",
      },
      {
        commands: ["npm run build"],
        shellExec: async () => {
          throw {
            message: "Command failed with exit code 1",
            stderr: `
> app@1.0.0 build
> tsc -b

src/server.ts(18,7): error TS2304: Cannot find name 'missingValue'.
src/server.ts(19,3): error TS2552: Cannot find name 'handler'. Did you mean 'Headers'?
`,
          };
        },
      }
    );

    expect(failure).toEqual(
      expect.objectContaining({
        firstErrorLine: "src/server.ts(18,7): error TS2304: Cannot find name 'missingValue'.",
      })
    );
    expect(failure?.outputSnippet).toContain("error TS2552");
    expect(failure?.outputSnippet).not.toContain("> app@1.0.0 build");
  });

  it("skips npm run gates when the script is not defined in package.json", async () => {
    const worktreePath = await makeTempWorktree({
      test: "vitest run",
    });
    const shellExec = vi.fn(async () => ({ stdout: "", stderr: "" }));

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
        shellExec,
      }
    );

    expect(failure).toBeNull();
    expect(shellExec).toHaveBeenCalledTimes(1);
    expect(shellExec).toHaveBeenCalledWith(
      "npm run test",
      expect.objectContaining({ cwd: worktreePath })
    );
  });

  it("falls back to executing gates when package.json is missing", async () => {
    const worktreePath = await makeTempWorktree();

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
        shellExec: async () => {
          throw {
            message: "Command failed with exit code 1",
            stderr: 'Missing script: "build"',
          };
        },
      }
    );

    expect(failure).toEqual(
      expect.objectContaining({
        command: "npm run build",
      })
    );
  });
});
