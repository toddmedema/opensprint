import path from "path";
import { OPENSPRINT_PATHS } from "@opensprint/shared";

function isPathInsideResolved(
  parentResolved: string,
  candidateResolved: string,
  allowEqual: boolean
): boolean {
  if (parentResolved === candidateResolved) return allowEqual;
  const relative = path.relative(parentResolved, candidateResolved);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function isPathInside(
  parentPath: string,
  candidatePath: string,
  options?: { allowEqual?: boolean }
): boolean {
  return isPathInsideResolved(
    path.resolve(parentPath),
    path.resolve(candidatePath),
    options?.allowEqual ?? true
  );
}

export function assertPathInside(
  parentPath: string,
  candidatePath: string,
  label: string,
  options?: { allowEqual?: boolean }
): string {
  const parentResolved = path.resolve(parentPath);
  const candidateResolved = path.resolve(candidatePath);
  if (!isPathInsideResolved(parentResolved, candidateResolved, options?.allowEqual ?? true)) {
    throw new Error(
      `${label} escapes its allowed root: target=${candidateResolved}, root=${parentResolved}`
    );
  }
  return candidatePath;
}

export function getSafeTaskActiveDir(repoPath: string, taskId: string): string {
  const activeRoot = path.join(repoPath, OPENSPRINT_PATHS.active);
  const activeDir = path.join(activeRoot, taskId);
  return assertPathInside(activeRoot, activeDir, `active dir for task ${taskId}`, {
    allowEqual: false,
  });
}

export function isTaskWorktreePath(taskId: string, candidatePath: string): boolean {
  const resolved = path.resolve(candidatePath);
  return (
    path.basename(resolved) === taskId &&
    path.basename(path.dirname(resolved)) === "opensprint-worktrees"
  );
}

export function assertSafeTaskWorktreePath(
  repoPath: string,
  taskId: string,
  candidatePath: string
): string {
  const resolvedRepo = path.resolve(repoPath);
  const resolvedCandidate = path.resolve(candidatePath);
  if (resolvedRepo === resolvedCandidate) {
    throw new Error(
      `Refusing to treat the repository root as a disposable worktree: ${resolvedCandidate}`
    );
  }
  if (!isTaskWorktreePath(taskId, resolvedCandidate)) {
    throw new Error(
      `Refusing to clean up a path outside opensprint worktrees for task ${taskId}: ${resolvedCandidate}`
    );
  }
  return candidatePath;
}
