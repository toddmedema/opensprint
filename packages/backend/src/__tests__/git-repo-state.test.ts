import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { exec as execCallback } from "child_process";
import { promisify } from "util";
import { resolveBaseBranch } from "../utils/git-repo-state.js";
import { prepareRepoForProject } from "../services/project/project-repo-prepare.js";

const execAsync = promisify(execCallback);

describe("resolveBaseBranch", () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await fs.mkdtemp(path.join(os.tmpdir(), "git-repo-state-"));
    await execAsync("git init", { cwd: repoPath });
    await execAsync("git branch -M main", { cwd: repoPath });
    await execAsync('git config user.email "test@test.com"', { cwd: repoPath });
    await execAsync('git config user.name "Test"', { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README.md"), "initial\n");
    await execAsync('git add README.md && git commit -m "initial"', { cwd: repoPath });
  });

  afterEach(async () => {
    await fs.rm(repoPath, { recursive: true, force: true }).catch(() => {});
  });

  it("prefers main over an Open Sprint task branch checkout", async () => {
    await execAsync("git checkout -b opensprint/os-test-1", { cwd: repoPath });

    await expect(resolveBaseBranch(repoPath)).resolves.toBe("main");
  });

  it.each(["stash", "commit"] as const)(
    "preserves all changes with %s before retrying checkout",
    async (action) => {
      await execAsync("git checkout -b feature", { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README.md"), "feature\n");
      await execAsync('git commit -am "feature"', { cwd: repoPath });
      await fs.writeFile(path.join(repoPath, "README.md"), "unsaved\n");
      await fs.writeFile(path.join(repoPath, "new.txt"), "untracked\n");
      await expect(prepareRepoForProject(repoPath, "main")).rejects.toMatchObject({
        code: "GIT_CHECKOUT_CONFLICT",
      });
      await expect(prepareRepoForProject(repoPath, "main", action)).resolves.toMatchObject({
        baseBranch: "main",
      });
      expect((await execAsync("git branch --show-current", { cwd: repoPath })).stdout.trim()).toBe(
        "main"
      );
      expect((await execAsync("git status --porcelain", { cwd: repoPath })).stdout.trim()).toBe("");
      if (action === "stash") {
        await execAsync("git checkout feature && git stash pop", { cwd: repoPath });
      } else {
        await execAsync("git checkout feature", { cwd: repoPath });
      }
      expect(await fs.readFile(path.join(repoPath, "README.md"), "utf8")).toBe("unsaved\n");
      expect(await fs.readFile(path.join(repoPath, "new.txt"), "utf8")).toBe("untracked\n");
    }
  );

  it("falls back to the current branch when no main or master branch exists", async () => {
    await execAsync("git checkout -b develop", { cwd: repoPath });
    await execAsync("git branch -D main", { cwd: repoPath });

    await expect(resolveBaseBranch(repoPath)).resolves.toBe("develop");
  });
});
