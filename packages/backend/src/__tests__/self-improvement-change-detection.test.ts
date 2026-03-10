import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { hasCodeChangesSince } from "../services/self-improvement-change-detection.js";
import * as shellExecMod from "../utils/shell-exec.js";

vi.mock("../utils/shell-exec.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../utils/shell-exec.js")>();
  const real = mod.shellExec;
  const mockFn = vi.fn((...args: unknown[]) => real(...args));
  return { shellExec: mockFn, __realShellExec: real };
});

describe("hasCodeChangesSince", () => {
  let repoPath: string;

  async function initRepo() {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-change-detection-"));
    execSync("git init", { cwd: repoPath });
    execSync("git config user.email test@test.com", { cwd: repoPath });
    execSync("git config user.name Test", { cwd: repoPath });
  }

  function commitAt(isoDate: string, message: string = "commit") {
    const env = {
      ...process.env,
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
    };
    execSync("git add -A", { cwd: repoPath });
    execSync(`git commit --allow-empty -m "${message}"`, { cwd: repoPath, env });
  }

  afterEach(async () => {
    if (repoPath) {
      await fs.rm(repoPath, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("returns true when lastRunAt is missing (no sinceTimestamp or sinceCommitSha)", async () => {
    await initRepo();
    commitAt("2024-06-01T12:00:00Z", "first");
    const result = await hasCodeChangesSince(repoPath, {});
    expect(result).toBe(true);
  });

  it("returns true for empty repo (no commits)", async () => {
    await initRepo();
    const result = await hasCodeChangesSince(repoPath, {
      sinceTimestamp: "2024-01-01T00:00:00Z",
    });
    expect(result).toBe(true);
  });

  it("returns true when there are commits after sinceTimestamp", async () => {
    await initRepo();
    commitAt("2024-06-01T10:00:00Z", "old");
    commitAt("2024-06-01T14:00:00Z", "new");
    const result = await hasCodeChangesSince(repoPath, {
      sinceTimestamp: "2024-06-01T12:00:00Z",
    });
    expect(result).toBe(true);
  });

  it("returns false when there are no commits after sinceTimestamp", async () => {
    await initRepo();
    commitAt("2024-06-01T10:00:00Z", "old");
    const result = await hasCodeChangesSince(repoPath, {
      sinceTimestamp: "2024-06-01T12:00:00Z",
    });
    expect(result).toBe(false);
  });

  it("returns true when HEAD is after sinceCommitSha", async () => {
    await initRepo();
    commitAt("2024-06-01T10:00:00Z", "first");
    const firstSha = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();
    commitAt("2024-06-01T11:00:00Z", "second");
    const result = await hasCodeChangesSince(repoPath, {
      sinceTimestamp: "2024-06-01T09:00:00Z",
      sinceCommitSha: firstSha,
    });
    expect(result).toBe(true);
  });

  it("returns false when HEAD equals sinceCommitSha", async () => {
    await initRepo();
    commitAt("2024-06-01T10:00:00Z", "only");
    const headSha = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" }).trim();
    const result = await hasCodeChangesSince(repoPath, {
      sinceTimestamp: "2024-06-01T09:00:00Z",
      sinceCommitSha: headSha,
    });
    expect(result).toBe(false);
  });

  it("respects baseBranch when provided", async () => {
    await initRepo();
    commitAt("2024-06-01T10:00:00Z", "on main");
    execSync("git checkout -b other", { cwd: repoPath });
    commitAt("2024-06-01T14:00:00Z", "on other");
    const result = await hasCodeChangesSince(repoPath, {
      sinceTimestamp: "2024-06-01T12:00:00Z",
      baseBranch: "other",
    });
    expect(result).toBe(true);
  });

  it("falls back to sinceTimestamp when sinceCommitSha is unknown or invalid", async () => {
    await initRepo();
    commitAt("2024-06-01T10:00:00Z", "first");
    commitAt("2024-06-01T14:00:00Z", "second");
    const unknownSha = "deadbeef0000000000000000000000000000000000";
    const result = await hasCodeChangesSince(repoPath, {
      sinceTimestamp: "2024-06-01T12:00:00Z",
      sinceCommitSha: unknownSha,
    });
    expect(result).toBe(true);
  });

  it("returns true when sinceTimestamp triggers git error (e.g. invalid date)", async () => {
    const real = (shellExecMod as typeof shellExecMod & { __realShellExec: typeof shellExecMod.shellExec })
      .__realShellExec;
    vi.mocked(shellExecMod.shellExec).mockImplementation((cmd: string, opts?: unknown) =>
      cmd.includes("--after")
        ? Promise.reject(new Error("invalid date"))
        : real(cmd, opts as Parameters<typeof real>[1])
    );
    await initRepo();
    commitAt("2024-06-01T10:00:00Z", "only");
    const result = await hasCodeChangesSince(repoPath, {
      sinceTimestamp: "not-a-valid-date",
    });
    expect(result).toBe(true);
  });

  it("returns false and does not throw when sinceCommitSha is invalid", async () => {
    await execAsync("git init", { cwd: tempDir });
    await execAsync("git config user.email test@test.com", { cwd: tempDir });
    await execAsync("git config user.name Test", { cwd: tempDir });
    await execAsync("git checkout -b main", { cwd: tempDir });
    await fs.writeFile(path.join(tempDir, "f"), "a");
    await execAsync("git add f && git commit -m first", { cwd: tempDir });

    await expect(
      hasRepoChangedSince(tempDir, { sinceCommitSha: "deadbeef1234567890" })
    ).resolves.toBe(false);
  });

  it("returns false and does not throw when baseBranch does not exist", async () => {
    await execAsync("git init", { cwd: tempDir });
    await execAsync("git config user.email test@test.com", { cwd: tempDir });
    await execAsync("git config user.name Test", { cwd: tempDir });
    await execAsync("git checkout -b main", { cwd: tempDir });
    await fs.writeFile(path.join(tempDir, "f"), "a");
    await execAsync("git add f && git commit -m first", { cwd: tempDir });
    const sha = await runGit(tempDir, "git rev-parse HEAD");

    await expect(
      hasRepoChangedSince(tempDir, {
        sinceCommitSha: sha,
        baseBranch: "branch-does-not-exist",
      })
    ).resolves.toBe(false);
  });
});
