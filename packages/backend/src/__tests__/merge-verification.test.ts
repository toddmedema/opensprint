import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMergeGateVerificationArtifact,
  isTaskWorktreeMergeGateArtifactCurrent,
} from "../services/merge-verification.service.js";
import type { ToolchainProfile } from "@opensprint/shared";

describe("merge verification execution evidence", () => {
  let root: string;
  let profile: ToolchainProfile;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "verification-evidence-"));
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    await fs.writeFile(path.join(root, "check.sh"), "exit 0\n");
    git("add", ".");
    git("commit", "-qm", "Fixture");
    profile = { dependencyStrategy: "none", mergeQualityGateCommands: ["sh check.sh"] };
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const bm = {
    getGitRev: async (_cwd: string, rev: string) => {
      try {
        return git("rev-parse", "--verify", rev);
      } catch {
        return null;
      }
    },
  };
  async function fixture() {
    const params = { repoPath: root, wtPath: root, baseBranch: "main", toolchainProfile: profile };
    const artifact = await buildMergeGateVerificationArtifact(bm, {
      ...params,
      validationWorkspace: "task_worktree",
    });
    return {
      artifact,
      current: () => isTaskWorktreeMergeGateArtifactCurrent(bm, { ...params, artifact }),
    };
  }
  it("reuses matching evidence and invalidates dirty validator and untracked source changes", async () => {
    const { artifact, current } = await fixture();
    expect(artifact.executionContextHash).toBeTruthy();
    expect(await current()).toBe(true);
    await fs.writeFile(path.join(root, "check.sh"), "exit 1\n");
    expect(await current()).toBe(false);
    git("checkout", "--", "check.sh");
    expect(await current()).toBe(true);
    await fs.writeFile(path.join(root, "new-source.txt"), "new source");
    expect(await current()).toBe(false);
  });
  it("invalidates changed execution environment, cwd and gate authority", async () => {
    const { artifact } = await fixture();
    for (const toolchainProfile of [
      { ...profile, executionEnvironment: { VERIFY_MODE: "other" } },
      { ...profile, mergeQualityGateCommands: ["sh check.sh --skip"] },
    ]) {
      expect(
        await isTaskWorktreeMergeGateArtifactCurrent(bm, {
          repoPath: root,
          wtPath: root,
          baseBranch: "main",
          artifact,
          toolchainProfile,
        })
      ).toBe(false);
    }
    delete artifact.executionContextHash;
    expect(
      await isTaskWorktreeMergeGateArtifactCurrent(bm, {
        repoPath: root,
        wtPath: root,
        baseBranch: "main",
        artifact,
        toolchainProfile: profile,
      })
    ).toBe(false);
  });
});
