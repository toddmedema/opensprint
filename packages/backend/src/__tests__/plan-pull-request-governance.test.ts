import { beforeEach, describe, expect, it, vi } from "vitest";
import { governanceService } from "../services/governance.service.js";
import { withUngovernedPullRequestDelivery } from "../services/plan-pull-request-governance.js";

vi.mock("../services/governance.service.js", () => ({
  governanceService: { isGovernanceInactive: vi.fn(), withPublicationLock: vi.fn() },
}));
const assertLease = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(governanceService.isGovernanceInactive).mockResolvedValue(true);
  vi.mocked(governanceService.withPublicationLock).mockImplementation(
    async (_projectId, operation) => operation(assertLease)
  );
});
describe("PR delivery governance compatibility", () => {
  it("serializes ungoverned publication with first policy activation and verifies lease ownership", async () => {
    const publish = vi.fn().mockResolvedValue("PR URL");
    await expect(withUngovernedPullRequestDelivery("project", publish)).resolves.toBe("PR URL");
    expect(governanceService.withPublicationLock).toHaveBeenCalledWith(
      "project",
      expect.any(Function),
      { durable: true }
    );
    expect(assertLease).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledOnce();
  });
  it("rejects active or retained governance before publication or local reconciliation", async () => {
    vi.mocked(governanceService.isGovernanceInactive).mockResolvedValue(false);
    const mutation = vi.fn();
    await expect(withUngovernedPullRequestDelivery("project", mutation)).rejects.toMatchObject({
      code: "GOVERNANCE_INVALID_INPUT",
    });
    expect(mutation).not.toHaveBeenCalled();
  });
  it("fails closed if lease ownership is lost before mutation", async () => {
    assertLease.mockRejectedValue(new Error("Lease lost"));
    const mutation = vi.fn();
    await expect(withUngovernedPullRequestDelivery("project", mutation)).rejects.toThrow(
      "Lease lost"
    );
    expect(mutation).not.toHaveBeenCalled();
  });
});
