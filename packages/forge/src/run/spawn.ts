import { spawn } from "node:child_process";
import { sanitizedEnv } from "../redact.js";

export interface RunningProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<number | null>;
  output(): string;
  failedToStart(): boolean;
  detach(): void;
  kill(): void;
}

export interface SpawnSpec {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutSec: number;
}

export type ProcessSpawner = (spec: SpawnSpec) => RunningProcess;

export function spawnProcess(spec: SpawnSpec): RunningProcess {
  const child = spawn(spec.argv[0] ?? "", spec.argv.slice(1), {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const take = (chunk: Buffer) => {
    if (output.length < 8000) output += chunk.toString("utf8");
  };
  child.stdout?.on("data", take);
  child.stderr?.on("data", take);
  let settled = false;
  let startFailed = false;
  let resolveExit: (code: number | null) => void = () => undefined;
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });
  const finish = (code: number | null) => {
    if (settled) return;
    settled = true;
    resolveExit(code);
  };
  const timer = setTimeout(() => child.kill("SIGKILL"), spec.timeoutSec * 1000);
  child.once("error", (error) => {
    startFailed = true;
    output += error.message;
    clearTimeout(timer);
    finish(null);
  });
  child.once("exit", (code) => {
    clearTimeout(timer);
    finish(code);
  });
  return {
    pid: child.pid,
    exited,
    output: () => output,
    failedToStart: () => startFailed,
    detach() {
      clearTimeout(timer);
      child.removeAllListeners("exit");
      child.removeAllListeners("error");
      child.unref();
    },
    kill() {
      child.kill("SIGKILL");
    },
  };
}

export function agentEnv(
  secrets: string[],
  extra: Record<string, string>
): NodeJS.ProcessEnv {
  return sanitizedEnv(process.env, secrets, extra);
}
