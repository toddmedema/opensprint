import fs from "fs";
import os from "os";
import path from "path";
import { createLogger } from "./utils/logger.js";
import { getErrorMessage } from "./utils/error-utils.js";

const log = createLogger("startup");

function getPidFilePath(port: number): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
  const pidDir = path.join(home, ".opensprint");
  return path.join(pidDir, `server-${port}.pid`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't actually kill
    return true;
  } catch {
    return false;
  }
}

function waitForProcessExit(pid: number, timeoutMs: number): boolean {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return !isProcessAlive(pid);
}

/**
 * Acquire the PID file for the given port. Exits the process if another server
 * is already running. Removes stale PID files from dead processes.
 */
export function acquirePidFile(port: number): void {
  const pidDir = path.dirname(getPidFilePath(port));
  const pidFile = getPidFilePath(port);

  try {
    const content = fs.readFileSync(pidFile, "utf-8").trim();
    const oldPid = parseInt(content, 10);
    if (!isNaN(oldPid) && isProcessAlive(oldPid)) {
      if (oldPid === process.pid) return; // re-entrant call
      // During tsx watch restarts, the old process may still be in its exit sequence.
      // Wait briefly before giving up.
      log.info("Waiting for previous process to exit", { pid: oldPid });
      if (!waitForProcessExit(oldPid, 3000)) {
        log.error("Another OpenSprint server is already running", {
          port,
          pid: oldPid,
          hint: `Kill it with: kill ${oldPid} or kill -9 ${oldPid}`,
        });
        process.exit(1);
      }
      log.info("Previous process has exited", { pid: oldPid });
    } else if (!isNaN(oldPid)) {
      log.info("Removing stale PID file", { pid: oldPid });
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn("Could not read PID file", { err: getErrorMessage(err) });
    }
  }

  // Write our PID
  fs.mkdirSync(pidDir, { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid), "utf-8");
}

/**
 * Remove the PID file if it contains our PID. Call on shutdown.
 */
export function removePidFile(port: number): void {
  const pidFile = getPidFilePath(port);
  try {
    const content = fs.readFileSync(pidFile, "utf-8").trim();
    // Only remove if it's our PID (guard against race conditions)
    if (parseInt(content, 10) === process.pid) {
      fs.unlinkSync(pidFile);
    }
  } catch {
    // Best effort — file may already be gone
  }
}
