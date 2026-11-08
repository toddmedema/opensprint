/** Waiting retains workspace ownership, while completed workers need not occupy coding admission. */
export function isLocalRecoveryCapacityReleased(slot: unknown): boolean {
  const s = slot as {
    localRecoveryWaiting?: boolean;
    agent?: { activeProcess?: unknown };
    reviewAgents?: Map<unknown, { agent: { activeProcess?: unknown } }>;
  };
  return (
    !!s?.localRecoveryWaiting &&
    !s.agent?.activeProcess &&
    ![...(s.reviewAgents?.values() ?? [])].some((r) => r.agent.activeProcess)
  );
}
