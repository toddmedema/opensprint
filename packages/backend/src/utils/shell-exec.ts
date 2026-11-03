/**
 * Shell execution utility.
 * Uses an explicit shell path to avoid ENOENT when /bin/sh is unavailable
 * (e.g. in sandboxed test environments). Prefers process.env.SHELL when that
 * path exists, else /bin/bash or /bin/sh so spawn never gets a missing path.
 */

import { exec, ExecOptions } from "child_process";
import fs from "fs";
import { promisify } from "util";
import { agentProcessEnvironment } from "./agent-process-env.js";

const execAsync = promisify(exec);

/** Resolve shell path for exec: only use paths that exist to avoid ENOENT. */
function resolveShell(): string | undefined {
  if (process.platform === "win32") return undefined;
  const envShell = process.env.SHELL;
  if (envShell && fs.existsSync(envShell)) return envShell;
  if (fs.existsSync("/bin/bash")) return "/bin/bash";
  if (fs.existsSync("/bin/sh")) return "/bin/sh";
  return undefined;
}

const SHELL = resolveShell();

/**
 * Execute a shell command. Uses SHELL when available to avoid ENOENT on spawn.
 */
export async function shellExec(
  command: string,
  options?: ExecOptions & { timeout?: number }
): Promise<{ stdout: string; stderr: string }> {
  const opts: ExecOptions = {
    ...options,
    env: agentProcessEnvironment(options?.env ?? process.env),
    timeout: options?.timeout ?? 30_000,
    encoding: "utf8",
  };
  if (SHELL && process.platform !== "win32") {
    opts.shell = SHELL;
  }
  const result = await execAsync(command, opts);
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : result.stdout.toString("utf8"),
    stderr: typeof result.stderr === "string" ? result.stderr : result.stderr.toString("utf8"),
  };
}
