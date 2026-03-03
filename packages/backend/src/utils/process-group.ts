export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function signalProcessGroup(
  processGroupLeaderPid: number,
  signal: "SIGTERM" | "SIGKILL"
): void {
  if (process.platform === "win32") {
    process.kill(processGroupLeaderPid, signal);
    return;
  }

  try {
    process.kill(-processGroupLeaderPid, signal);
  } catch {
    process.kill(processGroupLeaderPid, signal);
  }
}

export async function terminateProcessGroup(
  processGroupLeaderPid: number,
  waitMs = 2000
): Promise<void> {
  try {
    signalProcessGroup(processGroupLeaderPid, "SIGTERM");
  } catch {
    return;
  }

  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  if (!isProcessAlive(processGroupLeaderPid)) return;

  try {
    signalProcessGroup(processGroupLeaderPid, "SIGKILL");
  } catch {
    // Best effort
  }
}
