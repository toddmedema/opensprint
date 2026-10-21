import { isProcessAlive, signalProcessGroup } from "../../utils/process-group.js";
import type { CodingAgentHandle } from "./agent-types.js";

/**
 * Create an observation handle after restart. A persisted PID is vulnerable to
 * reuse; signalling requires independent ownership verification by the caller.
 */
export function createProcessGroupHandle(
  processGroupLeaderPid: number,
  options: { ownershipVerified?: boolean } = {}
): CodingAgentHandle {
  return {
    pid: processGroupLeaderPid,
    ownership: options.ownershipVerified ? "local" : "recovered_unverified",
    kill() {
      if (!options.ownershipVerified) return;
      try {
        signalProcessGroup(processGroupLeaderPid, "SIGTERM");
      } catch {
        // Process may already be dead
        return;
      }

      const killTimer = setTimeout(() => {
        if (!isProcessAlive(processGroupLeaderPid)) return;
        try {
          signalProcessGroup(processGroupLeaderPid, "SIGKILL");
        } catch {
          // Process may already be dead
        }
      }, 5000);
      killTimer.unref?.();
    },
  };
}
