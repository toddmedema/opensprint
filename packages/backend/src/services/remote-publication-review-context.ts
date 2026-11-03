import type { StoredTask } from "./task-store.service.js";
import { governanceService } from "./governance.service.js";

/** Task extras are a routing hint; only the immutable request event and task pin supply authority. */
export async function getTrustedRemoteReviewRequest(projectId: string, task: StoredTask) {
  if (!task.remotePublicationReview && task.source !== "governance-remote-review") return null;
  const { remotePublicationGovernanceService } =
    await import("./remote-publication-governance.service.js");
  const request = await remotePublicationGovernanceService.getRemoteReviewRequest(
    projectId,
    task.id
  );
  const pin = await governanceService.getTaskPin(projectId, task.id);
  if (
    !request ||
    !pin ||
    request.taskId !== task.id ||
    pin.baseSha !== request.baseSha ||
    pin.baseBranch !== request.baseSha ||
    pin.branchName !== request.branchName ||
    pin.worktreePath !== request.worktreePath
  )
    throw new Error(
      "Remote publication review requires its original durable request and pinned workspace."
    );
  return request;
}

/** Recover only from retained Git refs before the dispatcher claims a slot. No root-main fallback is permitted. */
export async function restoreRemoteReviewWorkspace(
  projectId: string,
  task: StoredTask,
  repoPath: string
): Promise<void> {
  if (!(await getTrustedRemoteReviewRequest(projectId, task))) return;
  const { remotePublicationGovernanceService } =
    await import("./remote-publication-governance.service.js");
  await governanceService.withPublicationLock(projectId, async (assertLease) => {
    if (await governanceService.hasTaskHold(projectId, task.id))
      throw new Error("A remote governance hold prevents workspace recovery.");
    await assertLease();
    await remotePublicationGovernanceService.prepareRemoteReview(projectId, task.id, repoPath);
    await assertLease();
  });
}

/** Review the remote contribution against the immutable remote base, even when local main already contains it. */
export async function resolveTaskReviewBase(
  projectId: string,
  task: StoredTask,
  ordinaryBase: string
): Promise<string> {
  return (await getTrustedRemoteReviewRequest(projectId, task))?.baseSha ?? ordinaryBase;
}

/** Called only after the existing coordinator joins all reviewers and hard checks successfully. */
export async function acceptRemoteReviewIfRequested(input: {
  projectId: string;
  task: StoredTask;
  repoPath: string;
  cwd: string;
  branchName: string;
}): Promise<void> {
  if (!(await getTrustedRemoteReviewRequest(input.projectId, input.task))) return;
  const { remotePublicationGovernanceService } =
    await import("./remote-publication-governance.service.js");
  const { governanceExecutionService } = await import("./governance-execution.service.js");
  await governanceService.withPublicationLock(input.projectId, async (assertLease) => {
    await governanceExecutionService.assertPublicationAuthority({
      projectId: input.projectId,
      taskId: input.task.id,
      repoPath: input.repoPath,
      branchName: input.branchName,
    });
    await assertLease();
    await remotePublicationGovernanceService.acceptRemoteReview({
      projectId: input.projectId,
      taskId: input.task.id,
      repoPath: input.repoPath,
      cwd: input.cwd,
      branchName: input.branchName,
    });
    await assertLease();
  });
}
