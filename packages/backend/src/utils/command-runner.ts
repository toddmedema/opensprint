import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { normalizeSpawnEnvPath } from "./path-env.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;

export interface CommandSpec {
  command: string;
  args?: string[];
}

export interface CommandRunOptions {
  cwd: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CommandRunResult {
  stdout: string;
  stderr: string;
  executable: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export class CommandRunError extends Error {
  code?: string;
  stdout: string;
  stderr: string;
  executable: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;

  constructor(
    message: string,
    params: {
      code?: string;
      stdout?: string;
      stderr?: string;
      executable: string;
      cwd: string;
      exitCode?: number | null;
      signal?: NodeJS.Signals | null;
      timedOut?: boolean;
    }
  ) {
    super(message);
    this.name = "CommandRunError";
    this.code = params.code;
    this.stdout = params.stdout ?? "";
    this.stderr = params.stderr ?? "";
    this.executable = params.executable;
    this.cwd = params.cwd;
    this.exitCode = params.exitCode ?? null;
    this.signal = params.signal ?? null;
    this.timedOut = params.timedOut ?? false;
  }
}

function commandHasPathSeparator(command: string): boolean {
  return command.includes("/") || command.includes("\\");
}

function accessMode(): number {
  return process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK;
}

function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, accessMode());
    return true;
  } catch {
    return false;
  }
}

function resolvePathCandidate(command: string, env: NodeJS.ProcessEnv): string | null {
  if (commandHasPathSeparator(command)) {
    const candidate = path.isAbsolute(command) ? command : path.resolve(command);
    return fileExists(candidate) ? candidate : null;
  }

  const pathValue = env.PATH ?? process.env.PATH ?? "";
  const entries = pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const pathExts =
    process.platform === "win32"
      ? (env.PATHEXT ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];

  for (const entry of entries) {
    for (const ext of pathExts) {
      const candidate = path.join(entry, `${command}${ext}`);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

export function commandSpecToString(spec: CommandSpec): string {
  return [spec.command, ...(spec.args ?? [])].join(" ").trim();
}

export function resolveCommandExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const normalizedEnv = normalizeSpawnEnvPath(env);
  return resolvePathCandidate(command, normalizedEnv);
}

export async function runCommand(
  spec: CommandSpec,
  options: CommandRunOptions
): Promise<CommandRunResult> {
  const env = normalizeSpawnEnvPath({ ...process.env, ...(options.env ?? {}) });
  const executable = resolveCommandExecutable(spec.command, env);
  const cwd = options.cwd;

  if (!executable) {
    throw new CommandRunError(`spawn ${spec.command} ENOENT`, {
      code: "ENOENT",
      executable: spec.command,
      cwd,
    });
  }

  return new Promise<CommandRunResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;

    const child = spawn(executable, spec.args ?? [], {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, KILL_GRACE_MS);
    }, timeoutMs);

    const finalize = (handler: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      handler();
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      const systemErr = err as NodeJS.ErrnoException;
      finalize(() => {
        reject(
          new CommandRunError(systemErr.message, {
            code: systemErr.code,
            stdout,
            stderr,
            executable,
            cwd,
          })
        );
      });
    });

    child.on("close", (exitCode, signal) => {
      finalize(() => {
        const normalizedSignal = signal ?? null;
        if (!timedOut && exitCode === 0) {
          resolve({
            stdout,
            stderr,
            executable,
            cwd,
            exitCode,
            signal: normalizedSignal,
          });
          return;
        }

        const commandText = commandSpecToString(spec);
        const message = timedOut
          ? `Command timed out: ${commandText}`
          : `Command failed: ${commandText}`;
        reject(
          new CommandRunError(message, {
            stdout,
            stderr,
            executable,
            cwd,
            exitCode,
            signal: normalizedSignal,
            timedOut,
          })
        );
      });
    });
  });
}
