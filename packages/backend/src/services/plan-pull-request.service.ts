import { runGit } from "../utils/git-command.js";
import { runCommand } from "../utils/command-runner.js";

/** Publish only the plan branch. Existing open PRs are reused after retries or follow-up tasks. */
export async function publishPlanPullRequest(input: {
  repoPath: string;
  branchName: string;
  baseBranch: string;
  title: string;
  taskIds: string[];
}): Promise<string> {
  const { repoPath, branchName, baseBranch, title, taskIds } = input;
  const options = { cwd: repoPath, timeout: 120_000 };
  const { stdout: remote } = await runGit(["remote", "get-url", "origin"], options);
  const match = remote
    .trim()
    .match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!match) throw new Error("Pull request delivery requires a GitHub origin remote.");
  if (branchName === baseBranch)
    throw new Error("Cannot publish a pull request from the base branch.");
  const repo = match[1];
  const gh = async (args: string[]) =>
    runCommand({ command: "gh", args: [...args, "--repo", repo] }, options);
  // Check sign-in before publishing any work. No push or merge to the base branch is performed.
  await runCommand(
    { command: "gh", args: ["repo", "view", repo, "--json", "nameWithOwner"] },
    options
  );
  await runGit(["push", "origin", `refs/heads/${branchName}:refs/heads/${branchName}`], options);
  const { stdout: existing } = await gh([
    "pr",
    "list",
    "--head",
    branchName,
    "--base",
    baseBranch,
    "--state",
    "open",
    "--json",
    "url",
    "--limit",
    "1",
  ]);
  const prs = JSON.parse(existing) as Array<{ url: string }>;
  if (prs[0]?.url) return prs[0].url;
  const { stdout } = await gh([
    "pr",
    "create",
    "--head",
    branchName,
    "--base",
    baseBranch,
    "--title",
    title,
    "--body",
    `Completed Open Sprint work.\n\nTasks: ${taskIds.join(", ")}\n\nReview and merge this PR to deliver the plan to ${baseBranch}.`,
  ]);
  const url = stdout.trim();
  if (!/^https:\/\//.test(url)) throw new Error("GitHub did not return a pull request URL.");
  return url;
}
