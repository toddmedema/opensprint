/**
 * Shell execution utility.
 * Uses an explicit shell path to avoid ENOENT when /bin/sh is unavailable
 * (e.g. in sandboxed test environments). Prefers process.env.SHELL when that
 * path exists, else /bin/bash or /bin/sh so spawn never gets a missing path.
 */

import { exec, execFile, ExecOptions } from "child_process";
import fs from "fs";
import { promisify } from "util";
import { getDeploymentMode } from "../services/deployment-mode.js";
import { parseCustomCliCommandLine } from "./custom-cli-command.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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
  if (getDeploymentMode() === "isolated-hosted") {
    // Git remains a trusted publisher operation, but never pass repository strings to a host shell.
    const argv = parseCustomCliCommandLine(command);
    if (argv[0] === "git" && !/[;&|<>`\r\n]/.test(command)) {
      const result = await execFileAsync(
        "git",
        [
          "-c",
          `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
          "-c",
          "core.fsmonitor=false",
          ...argv.slice(1),
        ],
        {
          cwd: options?.cwd,
          timeout: options?.timeout ?? 30_000,
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024,
        }
      );
      return { stdout: result.stdout, stderr: result.stderr };
    }
    const { runIsolatedCommand } = await import("../services/agent/isolated-runner.js");
    if (typeof options?.cwd !== "string")
      throw new Error("Isolated commands require an explicit workspace");
    const result = await runIsolatedCommand(options.cwd, command, options.timeout);
    if (result.exitCode !== 0) throw new Error(`Isolated command failed: ${result.output}`);
    return { stdout: result.output, stderr: "" };
  }
  const opts: ExecOptions = {
    ...options,
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
