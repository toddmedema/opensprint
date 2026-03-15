import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { AppError } from "../../middleware/error-handler.js";
import { ErrorCodes } from "../../middleware/error-codes.js";
import { shellExec } from "../../utils/shell-exec.js";

const GIT_TIMEOUT_MS = 10_000;
const MAX_CHANGED_PATHS_IN_MESSAGE = 8;
const EXCLUDED_PATHSPEC = `":(exclude).opensprint/**"`;

interface RepoSnapshot {
  head: string;
  branch: string;
  worktreeDiff: string;
  stagedDiff: string;
  worktreePaths: string[];
  stagedPaths: string[];
  untrackedFiles: Array<{ path: string; hash: string }>;
}

function normalizeLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

async function runGit(repoPath: string, command: string): Promise<string> {
  const { stdout } = await shellExec(command, {
    cwd: repoPath,
    timeout: GIT_TIMEOUT_MS,
  });
  return stdout.trim();
}

async function hashFile(absolutePath: string): Promise<string> {
  const content = await fs.readFile(absolutePath);
  return createHash("sha256").update(content).digest("hex");
}

async function captureSnapshot(repoPath: string): Promise<RepoSnapshot> {
  const [head, branch, worktreeDiff, stagedDiff, worktreePathsOut, stagedPathsOut, untrackedOut] =
    await Promise.all([
      runGit(repoPath, "git rev-parse HEAD"),
      runGit(repoPath, "git branch --show-current"),
      runGit(repoPath, `git diff --no-ext-diff --binary -- . ${EXCLUDED_PATHSPEC}`),
      runGit(repoPath, `git diff --cached --no-ext-diff --binary -- . ${EXCLUDED_PATHSPEC}`),
      runGit(repoPath, `git diff --name-only -- . ${EXCLUDED_PATHSPEC}`),
      runGit(repoPath, `git diff --cached --name-only -- . ${EXCLUDED_PATHSPEC}`),
      runGit(repoPath, "git ls-files --others --exclude-standard"),
    ]);

  const untrackedFiles: Array<{ path: string; hash: string }> = [];
  for (const relativePath of normalizeLines(untrackedOut)) {
    if (relativePath.startsWith(".opensprint/")) continue;
    const absolutePath = path.join(repoPath, relativePath);
    const stat = await fs.stat(absolutePath).catch(() => null);
    if (!stat?.isFile()) continue;
    untrackedFiles.push({
      path: relativePath,
      hash: await hashFile(absolutePath),
    });
  }

  return {
    head,
    branch,
    worktreeDiff,
    stagedDiff,
    worktreePaths: normalizeLines(worktreePathsOut),
    stagedPaths: normalizeLines(stagedPathsOut),
    untrackedFiles: untrackedFiles.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function snapshotsMatch(before: RepoSnapshot, after: RepoSnapshot): boolean {
  return (
    before.head === after.head &&
    before.branch === after.branch &&
    before.worktreeDiff === after.worktreeDiff &&
    before.stagedDiff === after.stagedDiff &&
    JSON.stringify(before.untrackedFiles) === JSON.stringify(after.untrackedFiles)
  );
}

function collectChangedPaths(before: RepoSnapshot, after: RepoSnapshot): string[] {
  const changed = new Set<string>();

  if (before.worktreeDiff !== after.worktreeDiff || before.stagedDiff !== after.stagedDiff) {
    for (const filePath of [
      ...before.worktreePaths,
      ...after.worktreePaths,
      ...before.stagedPaths,
      ...after.stagedPaths,
    ]) {
      if (!filePath.startsWith(".opensprint/")) changed.add(filePath);
    }
  }

  const beforeUntracked = new Map(before.untrackedFiles.map((entry) => [entry.path, entry.hash]));
  const afterUntracked = new Map(after.untrackedFiles.map((entry) => [entry.path, entry.hash]));
  for (const [filePath, hash] of afterUntracked) {
    if (beforeUntracked.get(filePath) !== hash) changed.add(filePath);
  }
  for (const filePath of beforeUntracked.keys()) {
    if (!afterUntracked.has(filePath)) changed.add(filePath);
  }

  return Array.from(changed).sort((a, b) => a.localeCompare(b));
}

function buildMutationMessage(label: string, before: RepoSnapshot, after: RepoSnapshot): string {
  const changedPaths = collectChangedPaths(before, after);
  const pathSuffix =
    changedPaths.length > 0
      ? ` Changed files: ${changedPaths.slice(0, MAX_CHANGED_PATHS_IN_MESSAGE).join(", ")}${
          changedPaths.length > MAX_CHANGED_PATHS_IN_MESSAGE ? ", ..." : ""
        }.`
      : "";
  const gitSuffix =
    before.head !== after.head || before.branch !== after.branch
      ? ` Git state changed unexpectedly (before: ${before.branch || "(detached)"} ${before.head.slice(0, 7)}, after: ${after.branch || "(detached)"} ${after.head.slice(0, 7)}).`
      : "";
  return (
    `${label} modified the repository unexpectedly. Planning agents must return JSON in their ` +
    `response and must not create, edit, stage, or commit files.${pathSuffix}${gitSuffix} ` +
    "Remove the changes and retry."
  );
}

export async function runPlannerWithRepoGuard<T>(options: {
  repoPath: string;
  label: string;
  run: () => Promise<T>;
}): Promise<T> {
  const before = await captureSnapshot(options.repoPath);
  try {
    const result = await options.run();
    const after = await captureSnapshot(options.repoPath);
    if (!snapshotsMatch(before, after)) {
      throw new AppError(
        400,
        ErrorCodes.DECOMPOSE_PARSE_FAILED,
        buildMutationMessage(options.label, before, after),
        {
          unexpectedRepoChanges: collectChangedPaths(before, after),
          beforeGitState: { head: before.head, branch: before.branch || null },
          afterGitState: { head: after.head, branch: after.branch || null },
        }
      );
    }
    return result;
  } catch (error) {
    const after = await captureSnapshot(options.repoPath).catch(() => null);
    if (after && !snapshotsMatch(before, after)) {
      throw new AppError(
        400,
        ErrorCodes.DECOMPOSE_PARSE_FAILED,
        buildMutationMessage(options.label, before, after),
        {
          unexpectedRepoChanges: collectChangedPaths(before, after),
          beforeGitState: { head: before.head, branch: before.branch || null },
          afterGitState: { head: after.head, branch: after.branch || null },
        }
      );
    }
    throw error;
  }
}
