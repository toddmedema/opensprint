import { agentProcessEnvironment } from "../utils/agent-process-env.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProjectSettings } from "@opensprint/shared";
import { governanceService } from "./governance.service.js";
import { remotePublicationGovernanceService } from "./remote-publication-governance.service.js";
import { resolveBaseBranch } from "../utils/git-repo-state.js";
import { governanceError } from "./policy-context.js";

const git = promisify(execFile);
export interface GovernedDeploymentOptions {
  /**
   * A durable auto-deploy job claimed under the lock. Its long run holds no lock: each admission
   * check briefly reacquires it, so a deployment cannot stall merges or other projects.
   */
  claimedJob?: true;
  expectedCommitHash?: string;
}

/** Manual delivery and automatic delivery share the exact reviewed publication authority. */
export async function withGovernedDeployment<T>(
  projectId: string,
  repoPath: string,
  settings: ProjectSettings,
  run: (assertAdmission: () => Promise<void>) => Promise<T>,
  options?: GovernedDeploymentOptions
): Promise<T> {
  if (await governanceService.isGovernanceInactive(projectId)) return run(async () => {});
  const admit = async (assertLease: () => Promise<void>): Promise<void> => {
    await assertLease();
    const baseBranch = await resolveBaseBranch(repoPath, settings.worktreeBaseBranch);
    const [published, current] = await Promise.all([
      remotePublicationGovernanceService.getDeployableHead(projectId, repoPath, baseBranch),
      git("git", ["rev-parse", "HEAD"], {
        env: agentProcessEnvironment(),
        cwd: repoPath,
        timeout: 10_000,
      }),
    ]);
    const head = current.stdout.trim();
    if (
      !published ||
      head !== published ||
      (options?.expectedCommitHash && head !== options.expectedCommitHash)
    )
      governanceError(
        "Delivery requires the exact reviewed and successfully published revision. Complete the retained governance review and publication first.",
        "GOVERNANCE_DEPLOYMENT_HOLD"
      );
    const status = await git("git", ["status", "--porcelain", "--untracked-files=all"], {
      env: agentProcessEnvironment(),
      cwd: repoPath,
      timeout: 10_000,
    });
    if (status.stdout.trim())
      governanceError(
        "Unreviewed working-tree changes prevent delivery. Commit and review the changes before publishing.",
        "GOVERNANCE_DEPLOYMENT_HOLD"
      );
    await assertLease();
  };
  if (options?.claimedJob) {
    if (!options.expectedCommitHash)
      governanceError("A claimed auto-deployment requires its exact published revision.");
    const assertAdmission = (): Promise<void> =>
      governanceService.withPublicationLock(projectId, admit);
    await assertAdmission();
    return run(assertAdmission);
  }
  return governanceService.withPublicationLock(projectId, async (assertLease) => {
    const assertAdmission = (): Promise<void> => admit(assertLease);
    await assertAdmission();
    return run(assertAdmission);
  });
}
