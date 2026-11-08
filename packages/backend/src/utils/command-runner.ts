import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { normalizeSpawnEnvPath } from "./path-env.js";
import { agentProcessEnvironment } from "./agent-process-env.js";
import { projectNodeEnvironment } from "./project-node-runtime.js";

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
  signal?: AbortSignal;
  /** Durable receipt before the supervised command is allowed to start. */
  onSpawn?: (pid: number) => Promise<void>;
  /** Broker-verified runtime directory; preserve it after generic PATH normalization. */
  trustedPathPrefix?: string;
  trustedPathPrefixes?: string[];
  /** When set, kill the process and reject if accumulated stdout exceeds this byte size (UTF-8). */
  maxStdoutBytes?: number;
  /** When set, kill the process and reject if accumulated stderr exceeds this byte size (UTF-8). */
  maxStderrBytes?: number;
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

function resolvePathCandidate(
  command: string,
  env: NodeJS.ProcessEnv,
  cwd = process.cwd()
): string | null {
  if (commandHasPathSeparator(command)) {
    const candidate = path.isAbsolute(command) ? command : path.resolve(cwd, command);
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
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string
): string | null {
  const normalizedEnv = normalizeSpawnEnvPath(agentProcessEnvironment(env));
  return resolvePathCandidate(
    command,
    cwd ? projectNodeEnvironment(command, cwd, normalizedEnv) : normalizedEnv,
    cwd
  );
}

export async function runCommand(
  spec: CommandSpec,
  options: CommandRunOptions
): Promise<CommandRunResult> {
  if (options.signal?.aborted) throw new Error("Command cancelled before launch");
  const env = projectNodeEnvironment(
    spec.command,
    options.cwd,
    agentProcessEnvironment(normalizeSpawnEnvPath({ ...process.env, ...(options.env ?? {}) }))
  );
  const prefixes = [
    ...new Set([
      ...(options.trustedPathPrefixes ?? []),
      ...(options.trustedPathPrefix ? [options.trustedPathPrefix] : []),
    ]),
  ];
  if (prefixes.length)
    env.PATH = [
      ...prefixes,
      ...(env.PATH ?? "").split(path.delimiter).filter((p) => !prefixes.includes(p)),
    ].join(path.delimiter);
  // Do not re-normalize PATH after selecting the project's Node: NVM's newest
  // version may be incompatible with the declared engine.
  const executable = resolvePathCandidate(spec.command, env, options.cwd);
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
    let outputLimitExceeded = false;
    let terminationRequested = false;
    let killTimer: NodeJS.Timeout | null = null;
    let launchError: unknown;
    let supervisedExitCode: number | undefined;

    const maxStdoutBytes = options.maxStdoutBytes;
    const maxStderrBytes = options.maxStderrBytes;

    let stdoutBytes = 0;
    let stderrBytes = 0;
    const signalTree = (signal: "SIGTERM" | "SIGKILL") => {
      if (process.platform !== "win32" && child.pid != null) {
        try {
          process.kill(-child.pid, signal);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
        }
      } else if (child.pid != null && process.platform === "win32") {
        // npm and shell wrappers have descendants that child.kill() cannot stop.
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("error", () => child.kill(signal));
      } else {
        child.kill(signal);
      }
    };
    const requestTermination = () => {
      if (terminationRequested || settled) return;
      terminationRequested = true;
      signalTree("SIGTERM");
      killTimer = setTimeout(() => {
        signalTree("SIGKILL");
      }, KILL_GRACE_MS);
    };
    const retainChunk = (chunk: string, used: number, limit: number | undefined) => {
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (limit == null || used + bytes <= limit) return { text: chunk, bytes, exceeded: false };
      const available = Math.max(0, limit - used);
      // for...of iterates Unicode code points, so a prefix never splits a surrogate pair.
      let prefix = "";
      let retained = 0;
      for (const character of chunk) {
        const size = Buffer.byteLength(character, "utf8");
        if (retained + size > available) break;
        prefix += character;
        retained += size;
      }
      return { text: prefix, bytes: retained, exceeded: true };
    };

    // The trusted bootstrap waits for a durable ownership receipt before executing
    // project code. A parent crash during the handshake cannot launch unrecorded work.
    const bootstrap = `const {spawn}=require('node:child_process');let child;
process.on('disconnect',()=>{if(!child)process.exit(1)});
process.once('message',({executable,args})=>{
 child=spawn(executable,args,{stdio:['ignore','inherit','inherit']});
 child.on('error',e=>{console.error(e.message);if(process.connected)process.send({complete:1})});
 child.on('close',(code)=>{if(process.connected)process.send({complete:code??1})});
});`;
    const supervised = !!options.onSpawn;
    const child = spawn(
      supervised ? process.execPath : executable,
      supervised ? ["-e", bootstrap] : (spec.args ?? []),
      {
        cwd,
        env,
        shell: false,
        // Own the group so cancellation reaches npm's shells, test runners and workers.
        detached: process.platform !== "win32",
        stdio: supervised ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
      }
    );

    const timeoutMs = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      if (outputLimitExceeded || settled) return;
      timedOut = true;
      requestTermination();
    }, timeoutMs);

    const finalize = (handler: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      // The wrapper can close before children that ignore SIGTERM. Do not cancel
      // escalation while those children still own validation slots or file handles.
      if (terminationRequested && child.pid != null && process.platform !== "win32") {
        signalTree("SIGKILL");
      }
      handler();
    };
    const onAbort = () => {
      launchError = new Error("Command cancelled");
      requestTermination();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    if (supervised) {
      child.on("message", (message: unknown) => {
        const code = (message as { complete?: unknown })?.complete;
        if (typeof code === "number" && !terminationRequested) {
          supervisedExitCode = code;
          signalTree("SIGKILL");
        }
      });
      void Promise.resolve()
        .then(async () => {
          if (!child.pid) throw new Error("Command ownership receipt has no PID");
          await options.onSpawn!(child.pid);
          if (!settled && !terminationRequested) child.send({ executable, args: spec.args ?? [] });
        })
        .catch((err) => {
          launchError = err;
          requestTermination();
        });
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (outputLimitExceeded || settled) return;
      const retained = retainChunk(chunk, stdoutBytes, maxStdoutBytes);
      stdout += retained.text;
      stdoutBytes += retained.bytes;
      if (retained.exceeded) {
        outputLimitExceeded = true;
        requestTermination();
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      if (outputLimitExceeded || settled) return;
      const retained = retainChunk(chunk, stderrBytes, maxStderrBytes);
      stderr += retained.text;
      stderrBytes += retained.bytes;
      if (retained.exceeded) {
        outputLimitExceeded = true;
        requestTermination();
      }
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
      if (supervisedExitCode !== undefined) {
        exitCode = supervisedExitCode;
        signal = null;
      }
      finalize(() => {
        const normalizedSignal = signal ?? null;
        if (!launchError && !timedOut && !outputLimitExceeded && exitCode === 0) {
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
        const message =
          launchError instanceof Error
            ? launchError.message
            : outputLimitExceeded
              ? `Command output exceeded limit: ${commandText}`
              : timedOut
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
