import { execSync } from "child_process";
import { createLogger } from "../utils/logger.js";

const log = createLogger("reaper");
const REAP_INTERVAL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

const ORPHAN_TEST_CMD_SIGNATURES = ["vitest", "npm test", "npm run test", "pnpm test", "yarn test"];
const ORPHAN_CLAUDE_SIGNATURES = ["claude", "--print"];

/**
 * Parse `ps -eo pid,ppid,pgid,command` output into structured records.
 * Using the full `command` field (not `comm`) avoids macOS path-matching
 * issues where `comm` shows the full binary path (e.g. /Users/x/.local/bin/bd)
 * instead of just the base name.
 */
export function parseOrphanedProcesses(
  psOutput: string,
  ownPid: number
): Array<{ pid: number; pgid: number; command: string }> {
  const results: Array<{ pid: number; pgid: number; command: string }> = [];
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Format: "  PID  PPID  PGID COMMAND..." — first three tokens are numbers
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = parseInt(match[1], 10);
    const ppid = parseInt(match[2], 10);
    const pgid = parseInt(match[3], 10);
    const command = match[4];
    if (ppid !== 1 || pid === ownPid) continue;
    results.push({ pid, pgid, command });
  }
  return results;
}

function collectMatchingProcessGroups(
  orphans: Array<{ pid: number; pgid: number; command: string }>,
  matcher: (command: string) => boolean
): number[] {
  const groups = new Set<number>();
  for (const orphan of orphans) {
    if (!matcher(orphan.command)) continue;
    groups.add(orphan.pgid > 0 ? orphan.pgid : orphan.pid);
  }
  return [...groups];
}

function killProcessGroups(pgids: number[]): number {
  let killed = 0;
  for (const pgid of pgids) {
    try {
      process.kill(-pgid, "SIGKILL");
      killed++;
    } catch {
      try {
        process.kill(pgid, "SIGKILL");
        killed++;
      } catch {
        /* process group already exited or no permission */
      }
    }
  }
  return killed;
}

/**
 * Finds and kills orphaned test process groups (ppid=1) that were abandoned when
 * their parent was killed. Targets npm/vitest test trees that can accumulate and
 * exhaust CPU and memory over time.
 *
 * Uses `ps -eo pid,ppid,pgid,command` so we can kill the entire process group,
 * not just an individual orphaned leaf process.
 */
function reapOrphanedWorkers(): void {
  if (process.platform === "win32") return;

  try {
    const output = execSync("ps -eo pid,ppid,pgid,command 2>/dev/null", {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();

    if (!output) return;

    const orphans = parseOrphanedProcesses(output, process.pid);
    const pgids = collectMatchingProcessGroups(orphans, (command) =>
      ORPHAN_TEST_CMD_SIGNATURES.some((sig) => command.includes(sig))
    );
    const killed = killProcessGroups(pgids);

    if (killed > 0) {
      log.info("Killed orphaned test process groups", { killed, pgids });
    }
  } catch {
    /* ps not available or timed out — skip silently */
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
    const output = execSync("ps -eo pid,ppid,pgid,command 2>/dev/null", {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();

    if (!output) return;

    const orphans = parseOrphanedProcesses(output, process.pid);
    const pgids = collectMatchingProcessGroups(orphans, (command) =>
      ORPHAN_CLAUDE_SIGNATURES.every((sig) => command.includes(sig))
    );
    const killed = killProcessGroups(pgids);

    if (killed > 0) {
      log.info("Killed orphaned claude process groups", { killed, pgids });
    }
  } catch {
    /* ps not available or timed out — skip silently */
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
