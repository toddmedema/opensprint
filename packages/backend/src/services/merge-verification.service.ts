/**
 * Merge gate verification artifact: single fingerprint + SHAs for deduplicating
 * orchestrator vs merge-coordinator task_worktree gate runs.
 */

import { createHash } from "crypto";
import type { ToolchainProfile } from "@opensprint/shared";
import { resolveToolchainProfile } from "./toolchain-profile.service.js";
import type { MergeQualityGateProfile } from "./merge-quality-gates.js";
import type {
  MergeQualityGateFailure,
  MergeQualityGateRunOptions,
} from "./merge-quality-gate-runner.js";

export interface MergeGateVerificationArtifact {
  taskBranchHead: string;
  baseBranchTip: string;
  commandsFingerprint: string;
  qualityGateProfile: MergeQualityGateProfile;
  validationWorkspace: "task_worktree" | "merged_candidate";
  passedAt: string;
  executionContextHash?: string;
}

/** No artifact may bypass gates when workspace/runtime/profile evidence is unavailable. */
async function executionStamp(
  wtPath: string,
  profile?: ToolchainProfile | null,
  baseBranch = "HEAD",
  projectId?: string
): Promise<string | undefined> {
  try {
    const { captureExecutionProfile } = await import("./project-execution-profile.service.js");
    const captured = await captureExecutionProfile(wtPath, profile ?? undefined, baseBranch);
    const { localRecoveryStore } = await import("./local-recovery.service.js");
    const learned = projectId
      ? await localRecoveryStore.executionProfile(
          projectId,
          captured.recipeHash ?? captured.contextHash
        )
      : undefined;
    return createHash("sha256")
      .update(captured.contextHash)
      .update(JSON.stringify(learned?.runtimeBindings ?? []))
      .digest("hex");
  } catch {
    return undefined;
  }
}

export interface BranchManagerLikeForVerification {
  getGitRev(cwd: string, rev: string): Promise<string | null>;
}

export function computeMergeGateCommandsFingerprint(
  toolchainProfile?: ToolchainProfile | null,
  qualityGateProfile: MergeQualityGateProfile = "deterministic"
): string {
  const contract = resolveToolchainProfile(toolchainProfile);
  return createHash("sha256")
    .update(JSON.stringify({ contract, qualityGateProfile }))
    .digest("hex")
    .slice(0, 40);
}

export async function resolveRecordedBaseBranchTip(
  bm: BranchManagerLikeForVerification,
  repoPath: string,
  wtPath: string,
  baseBranch: string
): Promise<string | null> {
  const originTip = await bm.getGitRev(repoPath, `origin/${baseBranch}`);
  if (originTip) return originTip;
  return bm.getGitRev(wtPath, baseBranch);
}

export function artifactMatchesToolchainFingerprint(
  artifact: MergeGateVerificationArtifact,
  toolchainProfile?: ToolchainProfile | null,
  qualityGateProfile: MergeQualityGateProfile = "deterministic"
): boolean {
  return (
    artifact.commandsFingerprint ===
    computeMergeGateCommandsFingerprint(toolchainProfile, qualityGateProfile)
  );
}

/**
 * True when task HEAD and base tip match the artifact (main has not moved; branch unchanged).
 */
export async function isTaskWorktreeMergeGateArtifactCurrent(
  bm: BranchManagerLikeForVerification,
  params: {
    projectId?: string;
    repoPath: string;
    wtPath: string;
    baseBranch: string;
    artifact: MergeGateVerificationArtifact;
    toolchainProfile?: ToolchainProfile | null;
    qualityGateProfile?: MergeQualityGateProfile;
  }
): Promise<boolean> {
  const stamp = await executionStamp(
    params.wtPath,
    params.toolchainProfile,
    params.baseBranch,
    params.projectId
  );
  const head = await bm.getGitRev(params.wtPath, "HEAD");
  const baseTip = await resolveRecordedBaseBranchTip(
    bm,
    params.repoPath,
    params.wtPath,
    params.baseBranch
  );
  if (!head || !baseTip) return false;
  const profile = params.qualityGateProfile ?? "deterministic";
  if (!artifactMatchesToolchainFingerprint(params.artifact, params.toolchainProfile, profile)) {
    return false;
  }
  return (
    !!stamp &&
    stamp === params.artifact.executionContextHash &&
    head === params.artifact.taskBranchHead &&
    baseTip === params.artifact.baseBranchTip &&
    params.artifact.validationWorkspace === "task_worktree" &&
    params.artifact.qualityGateProfile === profile
  );
}

export async function buildMergeGateVerificationArtifact(
  bm: BranchManagerLikeForVerification,
  params: {
    projectId?: string;
    repoPath: string;
    wtPath: string;
    baseBranch: string;
    toolchainProfile?: ToolchainProfile | null;
    qualityGateProfile?: MergeQualityGateProfile;
    validationWorkspace: "task_worktree" | "merged_candidate";
  }
): Promise<MergeGateVerificationArtifact> {
  const stamp = await executionStamp(
    params.wtPath,
    params.toolchainProfile,
    params.baseBranch,
    params.projectId
  );
  const head = await bm.getGitRev(params.wtPath, "HEAD");
  const baseTip = await resolveRecordedBaseBranchTip(
    bm,
    params.repoPath,
    params.wtPath,
    params.baseBranch
  );
  if (!head || !baseTip) {
    throw new Error("Could not resolve HEAD or base branch tip for merge gate artifact");
  }
  const qualityGateProfile = params.qualityGateProfile ?? "deterministic";
  return {
    executionContextHash: stamp,
    taskBranchHead: head,
    baseBranchTip: baseTip,
    commandsFingerprint: computeMergeGateCommandsFingerprint(
      params.toolchainProfile,
      qualityGateProfile
    ),
    qualityGateProfile,
    validationWorkspace: params.validationWorkspace,
    passedAt: new Date().toISOString(),
  };
}

export async function runMergeQualityGatesWithArtifact(
  runMergeQualityGates: (
    options: MergeQualityGateRunOptions
  ) => Promise<MergeQualityGateFailure | null>,
  bm: BranchManagerLikeForVerification,
  options: MergeQualityGateRunOptions & {
    toolchainProfile?: ToolchainProfile | null;
  }
): Promise<{
  failure: MergeQualityGateFailure | null;
  artifact: MergeGateVerificationArtifact | null;
}> {
  const qualityGateProfile = options.qualityGateProfile ?? "deterministic";
  const before = await executionStamp(
    options.worktreePath,
    options.toolchainProfile,
    options.baseBranch,
    options.projectId
  );
  const failure = await runMergeQualityGates({
    ...options,
    qualityGateProfile,
  });
  if (failure) return { failure, artifact: null };
  const validationWorkspace: "task_worktree" | "merged_candidate" =
    options.validationWorkspace === "merged_candidate" ? "merged_candidate" : "task_worktree";
  const artifact = await buildMergeGateVerificationArtifact(bm, {
    projectId: options.projectId,
    repoPath: options.repoPath,
    wtPath: options.worktreePath,
    baseBranch: options.baseBranch,
    toolchainProfile: options.toolchainProfile,
    qualityGateProfile,
    validationWorkspace,
  });
  return {
    failure: null,
    artifact: before && artifact.executionContextHash === before ? artifact : null,
  };
}
