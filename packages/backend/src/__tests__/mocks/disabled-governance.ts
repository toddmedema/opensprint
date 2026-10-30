/** Legacy orchestration unit tests exercise their host contract with governance disabled. */
export const disabledGovernanceService = {
  getConfig: async () => ({ mode: "disabled", version: 0 }),
  getTaskPin: async () => null,
  isReleaseRevoked: async () => false,
  getActiveRelease: async () => null,
  getActiveReleaseId: async () => null,
  assertProjectRemovalAllowed: async () => {},
  getTrustedScope: async () => null,
  captureTrustedScope: async (_projectId: string, _taskId: string, scope: string) => scope,
  hasTaskHold: async () => false,
  retainsTaskWorktree: async () => false,
  retainsWorktree: async () => false,
  hasPendingResume: async () => false,
  listCases: async () => [],
  getTaskCases: async () => [],
  getPromptSnapshots: async () => [],
  assertMergeAdmission: async () => {},
  recordReviewApproval: async () => {},
  deliverOutbox: async () => {},
  withPublicationLock: async <T>(
    _projectId: string,
    fn: (assertLease: () => Promise<void>) => Promise<T>
  ): Promise<T> => fn(async () => {}),
};
