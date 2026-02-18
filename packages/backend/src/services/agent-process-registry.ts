/**
 * Tracks spawned agent child processes so they can be killed on backend shutdown.
 * Prevents orphaned zombie processes when the backend restarts (e.g. tsx watch).
 */

const trackedPids = new Set<number>();
/** Process group IDs (negative PIDs) for detached spawns that use process groups */
const trackedProcessGroups = new Set<number>();

export function registerAgentProcess(pid: number, options?: { processGroup?: boolean }): void {
  if (options?.processGroup && pid > 0) {
    trackedProcessGroups.add(-pid);
  } else {
    trackedPids.add(pid);
  }
}

export function unregisterAgentProcess(pid: number, options?: { processGroup?: boolean }): void {
  if (options?.processGroup && pid > 0) {
    trackedProcessGroups.delete(-pid);
  } else {
    trackedPids.delete(pid);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill all tracked agent processes. Called on backend SIGTERM/SIGINT.
 * Sends SIGTERM first, waits briefly, then SIGKILLs any still alive.
 * Returns a Promise that resolves when cleanup is done.
 * @param waitMs - Time to wait before SIGKILL fallback (default 2000). Use 0 in tests.
 */
export async function killAllTrackedAgentProcesses(waitMs = 2000): Promise<void> {
  const pgids = [...trackedProcessGroups];
  const pids = [...trackedPids];
  trackedProcessGroups.clear();
  trackedPids.clear();

  for (const pgid of pgids) {
    try {
      process.kill(pgid, "SIGTERM");
    } catch {
      /* process already exited */
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* process already exited */
    }
  }

  if (waitMs > 0) {
    await new Promise((r) => setTimeout(r, waitMs));
  }

  for (const pgid of pgids) {
    try {
      const leaderPid = -pgid;
      if (isProcessAlive(leaderPid)) process.kill(pgid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
  for (const pid of pids) {
    try {
      if (isProcessAlive(pid)) process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  }
}
