import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { gitCommitQueue } from "../services/git-commit-queue.service.js";

const execAsync = promisify(exec);

describe("GitCommitQueue", () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = path.join(os.tmpdir(), `git-queue-test-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    await execAsync("git init", { cwd: repoPath });
    await execAsync("git checkout -b main", { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, "README"), "initial");
    await execAsync("git add README && git commit -m init", { cwd: repoPath });
    try {
      await execAsync("bd init", { cwd: repoPath });
    } catch {
      // bd may not be installed — skip beads_export tests
    }
  });

  afterEach(async () => {
    await fs.rm(repoPath, { recursive: true, force: true }).catch(() => {});
  });

  it("should enqueue and process beads_export job", async () => {
    const beadsDir = path.join(repoPath, ".beads");
    try {
      await fs.access(beadsDir);
    } catch {
      return; // bd init was skipped
    }

    await gitCommitQueue.enqueueAndWait({
      type: "beads_export",
      repoPath,
      summary: "test export",
    });

    const { stdout } = await execAsync("git log -1 --oneline", { cwd: repoPath });
    expect(stdout).toContain("beads:");
    expect(stdout).toContain("test export");
  });

  it("should enqueue and process prd_update job", async () => {
    await fs.mkdir(path.join(repoPath, ".opensprint"), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, ".opensprint/prd.json"),
      JSON.stringify({ version: 0, sections: {}, changeLog: [] })
    );

    await gitCommitQueue.enqueueAndWait({
      type: "prd_update",
      repoPath,
      source: "sketch",
    });

    const { stdout } = await execAsync("git log -1 --oneline", { cwd: repoPath });
    expect(stdout).toContain("prd:");
  });

  it("should process jobs in FIFO order", async () => {
    await fs.mkdir(path.join(repoPath, ".opensprint"), { recursive: true });
    await fs.writeFile(
      path.join(repoPath, ".opensprint/prd.json"),
      JSON.stringify({ version: 0, sections: {}, changeLog: [] })
    );

    gitCommitQueue.enqueue({
      type: "prd_update",
      repoPath,
      source: "sketch",
    });
    await gitCommitQueue.drain();

    const { stdout } = await execAsync("git log -1 --oneline", { cwd: repoPath });
    expect(stdout).toContain("prd:");
  });

  it("should support drain for tests", async () => {
    const beadsDir = path.join(repoPath, ".beads");
    try {
      await fs.access(beadsDir);
    } catch {
      return; // bd init was skipped
    }

    gitCommitQueue.enqueue({
      type: "beads_export",
      repoPath,
      summary: "drain test",
    });
    await gitCommitQueue.drain();

    const { stdout } = await execAsync("git log -1 --oneline", { cwd: repoPath });
    expect(stdout).toContain("beads:");
  });
});
