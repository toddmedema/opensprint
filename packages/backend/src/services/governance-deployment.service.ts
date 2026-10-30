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
  /** Server-internal continuation of a serialized, durable auto-deploy job. */
  publicationLeaseHeld?: true;
  expectedCommitHash?: string;
  assertPublicationLease?: () => Promise<void>;
}

/** Manual delivery and automatic delivery share the exact reviewed publication authority. */
export async function withGovernedDeployment<T>(
  projectId: string,
  repoPath: string,
  settings: ProjectSettings,
  run: (assertAdmission: () => Promise<void>) => Promise<T>,
  options?: GovernedDeploymentOptions
): Promise<T> {
  const config = await governanceService.getConfig(projectId);
  if (config.mode === "disabled" && !(await governanceService.getActiveReleaseId(projectId)))
    return run(async () => {});
  const execute = async (assertLease: () => Promise<void>): Promise<T> => {
    const assertAdmission = async (): Promise<void> => {
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
    await assertAdmission();
    return run(assertAdmission);
  };
  if (options?.publicationLeaseHeld) {
    if (!options.expectedCommitHash || !options.assertPublicationLease)
      governanceError(
        "A durable deployment continuation requires its publication lease and exact revision."
      );
    return execute(options.assertPublicationLease);
  }
  return governanceService.withPublicationLock(projectId, execute);
}
