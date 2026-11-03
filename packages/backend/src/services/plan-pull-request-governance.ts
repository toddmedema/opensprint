import { governanceService } from "./governance.service.js";
import { GOVERNANCE_INVALID_INPUT, governanceError } from "./policy-context.js";

export const PR_GOVERNANCE_INCOMPATIBLE =
  "Pull request delivery requires a project without active or retained review governance. Use direct code delivery for governed projects.";

/** PR delivery does not yet carry governed publication receipts. Serialize its admission
 * with policy activation, including the first activation of a previously inactive project. */
export async function withUngovernedPullRequestDelivery<T>(
  projectId: string,
  operation: () => Promise<T>
): Promise<T> {
  return governanceService.withPublicationLock(
    projectId,
    async (assertLease) => {
      if (!(await governanceService.isGovernanceInactive(projectId))) {
        governanceError(PR_GOVERNANCE_INCOMPATIBLE, GOVERNANCE_INVALID_INPUT);
      }
      await assertLease();
      const result = await operation();
      await assertLease();
      return result;
    },
    { durable: true }
  );
}
