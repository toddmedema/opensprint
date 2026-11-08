import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ValidationWorkspaceService } from "../services/validation-workspace.service.js";

describe("retained merge candidate identity", () => {
  let root: string, repo: string, candidate: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "recovery-merge-identity-"));
    repo = path.join(root, "repo");
    candidate = path.join(root, "candidate");
    await fs.mkdir(repo);
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Fixture");
    git(repo, "config", "user.email", "fixture@example.test");
    await fs.writeFile(path.join(repo, "base.txt"), "base");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "base");
    git(repo, "checkout", "-b", "task");
    await fs.writeFile(path.join(repo, "completed.txt"), "completed code");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "completed");
    git(repo, "checkout", "main");
    git(repo, "worktree", "add", "-b", "opensprint/validation/fixture", candidate, "main");
    git(candidate, "merge", "--no-ff", "--no-commit", "task");
  });
  afterEach(async () => {
    git(repo, "worktree", "remove", "--force", candidate);
    await fs.rm(root, { recursive: true, force: true });
  });
  it("reattaches the exact candidate without changing staged completed work or the merge state", async () => {
    const status = git(candidate, "status", "--porcelain");
    const head = git(candidate, "rev-parse", "HEAD");
    const merging = git(candidate, "rev-parse", "MERGE_HEAD");
    const handle = await new ValidationWorkspaceService().reopenMergeCandidateWorkspace(repo, {
      worktreePath: candidate,
      branchName: "opensprint/validation/fixture",
    });
    expect(handle.worktreePath).toBe(await fs.realpath(candidate));
    expect(git(candidate, "status", "--porcelain")).toBe(status);
    expect(git(candidate, "rev-parse", "HEAD")).toBe(head);
    expect(git(candidate, "rev-parse", "MERGE_HEAD")).toBe(merging);
    expect(await fs.readFile(path.join(candidate, "completed.txt"), "utf8")).toBe("completed code");
  });
  it("rejects a different branch identity or a worktree from another repository", async () => {
    const service = new ValidationWorkspaceService();
    await expect(
      service.reopenMergeCandidateWorkspace(repo, {
        worktreePath: candidate,
        branchName: "opensprint/validation/other",
      })
    ).rejects.toThrow(/identity/);
    const other = path.join(root, "other");
    await fs.mkdir(other);
    git(other, "init", "-b", "main");
    await expect(
      service.reopenMergeCandidateWorkspace(other, {
        worktreePath: candidate,
        branchName: "opensprint/validation/fixture",
      })
    ).rejects.toThrow(/identity/);
  });
});
