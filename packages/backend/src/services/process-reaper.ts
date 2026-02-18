import { execSync } from "child_process";

const REAP_INTERVAL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Finds and kills orphaned vitest/node worker processes (ppid=1) that were
 * abandoned when their parent was killed. These leak memory indefinitely.
 *
 * Only targets processes whose ppid is 1 (adopted by init/launchd), meaning
 * the original parent is already gone — safe to kill.
 */
function reapOrphanedWorkers(): void {
  if (process.platform === "win32") return;

  try {
    const output = execSync(
      `ps -eo pid,ppid,comm 2>/dev/null | awk '$2 == 1 && $3 == "node"' | awk '{print $1}'`,
      { encoding: "utf-8", timeout: 5_000 }
    ).trim();

    if (!output) return;

    const pids = output
      .split("\n")
      .map((p) => parseInt(p.trim(), 10))
      .filter((p) => !isNaN(p) && p !== process.pid);

    if (pids.length === 0) return;

    let killed = 0;
    for (const pid of pids) {
      try {
        // Verify this is actually a vitest worker before killing
        const cmdline = execSync(`ps -p ${pid} -o command=`, {
          encoding: "utf-8",
          timeout: 2_000,
        }).trim();

        if (!cmdline.includes("vitest")) continue;

        process.kill(pid, "SIGKILL");
        killed++;
      } catch {
        /* process already exited or no permission */
      }
    }

    if (killed > 0) {
      console.log(`[reaper] Killed ${killed} orphaned vitest worker(s)`);
    }
  } catch {
    /* ps/awk not available or timed out — skip silently */
  }
}

/**
 * Kills orphaned claude CLI processes (ppid=1) from previous backend runs.
 * These accumulate when the backend restarts (e.g. tsx watch) and the parent
 * dies before killing spawned children.
 */
function reapOrphanedClaudeProcesses(): void {
  if (process.platform === "win32") return;

  try {
    const output = execSync(
      `ps -eo pid,ppid,comm 2>/dev/null | awk '$2 == 1 && $3 == "claude"' | awk '{print $1}'`,
      { encoding: "utf-8", timeout: 5_000 }
    ).trim();

    if (!output) return;

    const pids = output
      .split("\n")
      .map((p) => parseInt(p.trim(), 10))
      .filter((p) => !isNaN(p) && p !== process.pid);

    if (pids.length === 0) return;

    let killed = 0;
    for (const pid of pids) {
      try {
        const cmdline = execSync(`ps -p ${pid} -o command=`, {
          encoding: "utf-8",
          timeout: 2_000,
        }).trim();

        if (!cmdline.includes("claude") || !cmdline.includes("--print")) continue;

        process.kill(pid, "SIGKILL");
        killed++;
      } catch {
        /* process already exited or no permission */
      }
    }

    if (killed > 0) {
      console.log(`[reaper] Killed ${killed} orphaned claude process(es)`);
    }
  } catch {
    /* ps/awk not available or timed out — skip silently */
  }
}

export function startProcessReaper(): void {
  if (timer) return;
  reapOrphanedWorkers();
  reapOrphanedClaudeProcesses();
  timer = setInterval(() => {
    reapOrphanedWorkers();
    reapOrphanedClaudeProcesses();
  }, REAP_INTERVAL_MS);
  timer.unref();
}

export function stopProcessReaper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
