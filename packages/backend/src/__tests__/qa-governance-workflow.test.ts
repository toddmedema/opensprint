import { describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GovernanceTaskPin } from "@opensprint/shared";

const calls = vi.hoisted(() => ({
  isGovernanceInactive: async () => false,
  getTaskPinsForBranch: vi.fn(),
  listCases: vi.fn(),
  getReviewApproval: vi.fn(),
  getTrustedScope: vi.fn(),
  getGrantedScope: vi.fn(),
  getTaskPin: vi.fn(),
  getConfig: vi.fn(),
  audit: vi.fn(),
  assertMergeAdmission: vi.fn(),
  getRelease: vi.fn(),
  isReleaseRevoked: vi.fn(),
  sourceApproval: vi.fn(),
  sensitivePaths: vi.fn(),
}));
vi.mock("../services/governance.service.js", () => ({ governanceService: calls }));
vi.mock("../services/governance-source-hashes.js", () => ({
  readGovernanceSourceHashes: async () => ({}),
  governanceSourceDrift: () => [],
  assertGovernanceSensitiveSourceApproval: (input: unknown) => calls.sourceApproval(input),
  governanceSensitiveSourcePaths: (paths: string[]) => calls.sensitivePaths(paths) ?? [],
  resolveGovernanceCandidateSensitiveSourcePaths: async (input: { changedPaths: string[] }) =>
    calls.sensitivePaths(input.changedPaths) ?? [],
  resolveGovernanceSensitiveSourcePaths: async (input: { changedPaths: string[] }) =>
    calls.sensitivePaths(input.changedPaths) ?? [],
}));
vi.mock("../services/agent-instructions.service.js", () => ({
  getCombinedInstructions: async () => "",
}));
import {
  GovernanceExecutionService,
  governanceCodeSnapshot,
} from "../services/governance-execution.service.js";
const exec = promisify(execFile);

describe("fresh end-to-end governance QA", () => {
  it("shadow governance permits an ordinarily valid upstream same-file merge", async () => {
    vi.resetAllMocks();
    calls.getConfig.mockResolvedValue({ mode: "shadow" });
    calls.getGrantedScope.mockResolvedValue("Ordinary feature");
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "qa-shadow-publication-"));
    try {
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.name", "QA"], { cwd: repo });
      await exec("git", ["config", "user.email", "qa@example.test"], { cwd: repo });
      await fs.mkdir(path.join(repo, "src"));
      const file = path.join(repo, "src/x.ts");
      const original =
        "export const feature = 0;\n\n// Existing unrelated implementation\n\nexport const upstream = 0;\n";
      await fs.writeFile(file, original);
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "base"], { cwd: repo });
      const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
      await exec("git", ["checkout", "-b", "task"], { cwd: repo });
      await fs.writeFile(file, original.replace("feature = 0", "feature = 1"));
      await exec("git", ["commit", "-am", "task implementation"], { cwd: repo });
      const reviewed = await governanceCodeSnapshot(repo, base);
      await exec("git", ["checkout", "main"], { cwd: repo });
      await fs.writeFile(file, original.replace("upstream = 0", "upstream = 1"));
      await exec("git", ["commit", "-am", "independent upstream implementation"], { cwd: repo });
      await exec("git", ["merge", "--no-ff", "--no-commit", "task"], { cwd: repo });
      const pin: GovernanceTaskPin = {
        projectId: "p",
        taskId: "t",
        releaseId: "r",
        mode: "shadow",
        baseSha: base,
        trustedScope: "Implement feature",
        instructionsByRole: {},
        worktreePath: repo,
        branchName: "task",
        createdAt: new Date().toISOString(),
      };
      calls.getTaskPinsForBranch.mockResolvedValue([pin]);
      calls.listCases.mockResolvedValue([]);
      calls.getTrustedScope.mockResolvedValue(pin.trustedScope);
      calls.getReviewApproval.mockResolvedValue({ ...reviewed, releaseId: pin.releaseId });
      calls.getRelease.mockResolvedValue({
        id: pin.releaseId,
        sourceHashes: {},
        enforcementRevision: base,
      });
      const service = new GovernanceExecutionService();
      await expect(
        service.assertPublication({
          projectId: "p",
          taskId: "t",
          repoPath: repo,
          candidatePath: repo,
          branchName: "task",
          baseBranch: "main",
        })
      ).resolves.toBeUndefined();
      expect(calls.assertMergeAdmission).not.toHaveBeenCalled();
      expect(calls.getRelease).not.toHaveBeenCalled();
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
  // Shadow promises ordinary review, so a missing source approval is recorded rather than refusing
  // the merge. This test used to expect the refusal; enforced mode keeps it.
  it("records an unapproved policy source after a shadow review without blocking", async () => {
    vi.resetAllMocks();
    calls.getConfig.mockResolvedValue({ mode: "shadow" });
    calls.getGrantedScope.mockResolvedValue("Ordinary feature");
    calls.sensitivePaths.mockImplementation((paths: string[]) =>
      paths.filter((file) => file === "AGENTS.md")
    );
    calls.sourceApproval.mockImplementation(async (input: { changedPaths: string[] }) => {
      if (input.changedPaths.includes("AGENTS.md"))
        throw new Error("Human source approval required");
    });
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "qa-shadow-source-"));
    try {
      await exec("git", ["init", "-b", "main"], { cwd: repo });
      await exec("git", ["config", "user.name", "QA"], { cwd: repo });
      await exec("git", ["config", "user.email", "qa@example.test"], { cwd: repo });
      await fs.writeFile(path.join(repo, "x.ts"), "export const x = 0;\n");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "base"], { cwd: repo });
      const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
      await exec("git", ["checkout", "-b", "task"], { cwd: repo });
      await fs.writeFile(path.join(repo, "x.ts"), "export const x = 1;\n");
      await exec("git", ["commit", "-am", "reviewed code"], { cwd: repo });
      const reviewed = await governanceCodeSnapshot(repo, base);
      await fs.writeFile(path.join(repo, "AGENTS.md"), "New unsupported authority\n");
      await exec("git", ["add", "."], { cwd: repo });
      await exec("git", ["commit", "-m", "unreviewed policy edit"], { cwd: repo });
      await exec("git", ["checkout", "main"], { cwd: repo });
      await exec("git", ["merge", "--no-ff", "--no-commit", "task"], { cwd: repo });
      const pin: GovernanceTaskPin = {
        projectId: "p",
        taskId: "t",
        releaseId: "r",
        mode: "shadow",
        baseSha: base,
        trustedScope: "Ordinary feature",
        instructionsByRole: {},
        worktreePath: repo,
        branchName: "task",
        createdAt: new Date().toISOString(),
      };
      calls.getTaskPinsForBranch.mockResolvedValue([pin]);
      calls.listCases.mockResolvedValue([]);
      calls.getTrustedScope.mockResolvedValue(pin.trustedScope);
      calls.getReviewApproval.mockResolvedValue({ ...reviewed, releaseId: pin.releaseId });
      await expect(
        new GovernanceExecutionService().assertPublication({
          projectId: "p",
          taskId: "t",
          repoPath: repo,
          candidatePath: repo,
          branchName: "task",
          baseBranch: "main",
        })
      ).resolves.toBeUndefined();
      expect(calls.audit).toHaveBeenCalledWith(
        "p",
        "shadow_source_approval_missing",
        "system",
        expect.objectContaining({ taskId: "t" })
      );
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});
