import {
  ensureBaseBranchExists,
  ensureGitIdentityConfigured,
  inspectGitRepoState,
} from "../../utils/git-repo-state.js";
import { AppError } from "../../middleware/error-handler.js";
import { runGit } from "../../utils/git-command.js";

export async function prepareRepoForProject(
  repoPath: string,
  preferredBaseBranch?: string,
  gitChangesAction?: "stash" | "commit"
): Promise<{ hadHead: boolean; baseBranch: string }> {
  const repoState = await inspectGitRepoState(repoPath, preferredBaseBranch);
  await ensureGitIdentityConfigured(repoPath);
  const baseBranch = repoState.baseBranch;
  try {
    await ensureBaseBranchExists(repoPath, baseBranch);
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== "GIT_CHECKOUT_CONFLICT" || !gitChangesAction) {
      throw err;
    }
    const options = { cwd: repoPath, timeout: 30_000 };
    if (gitChangesAction === "stash") {
      await runGit(
        ["stash", "push", "--include-untracked", "-m", "Open Sprint: before base branch checkout"],
        options
      );
    } else {
      await runGit(["add", "--all"], options);
      await runGit(
        ["commit", "-m", "chore: save all changes before Open Sprint checkout"],
        options
      );
    }
    await ensureBaseBranchExists(repoPath, baseBranch);
  }
  return { hadHead: repoState.hasHead, baseBranch };
}
