import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentConfig } from "@opensprint/shared";
import type { CodingAgentHandle, InvokeCodingAgentOptions } from "./agent-types.js";
import {
  executionOwnershipService,
  projectLeadershipService,
} from "../execution-ownership.service.js";
import { getDeploymentMode } from "../deployment-mode.js";
import { publishWorkerArtifact } from "../worker-artifact-publisher.service.js";

const exec = promisify(execFile);
const executableCache = new Map<string, string>();
function trustedExecutable(name: string): string {
  const cached = executableCache.get(name);
  if (cached) return cached;
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    for (const suffix of process.platform === "win32" ? [".exe", ""] : [""]) {
      const candidate = path.join(directory, name + suffix);
      if (existsSync(candidate)) {
        executableCache.set(name, candidate);
        return candidate;
      }
    }
  }
  throw new Error(`Required isolated control executable is unavailable: ${name}`);
}
export { getDeploymentMode };
export interface IsolatedRunnerConfig {
  image: string;
  command: string[];
  network: string;
  cpus: number;
  memoryMb: number;
  pids: number;
  timeoutMs: number;
  outputBytes: number;
}
function budget(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error(`${name} is outside its supported budget`);
  return value;
}
export function getIsolatedRunnerConfig(): IsolatedRunnerConfig {
  const image = process.env.OPENSPRINT_ISOLATED_IMAGE ?? "";
  if (!/^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error("Isolated execution requires a digest-pinned OPENSPRINT_ISOLATED_IMAGE");
  const command: unknown = JSON.parse(process.env.OPENSPRINT_ISOLATED_COMMAND ?? "[]");
  if (
    !Array.isArray(command) ||
    !command.length ||
    command.some((arg) => typeof arg !== "string" || arg.includes("\0"))
  )
    throw new Error("OPENSPRINT_ISOLATED_COMMAND must be a nonempty JSON argv array");
  const network = process.env.OPENSPRINT_ISOLATED_NETWORK ?? "none";
  if (network !== "none" && !/^opensprint-isolated-[a-z0-9-]+$/.test(network))
    throw new Error(
      "Isolated network must be none or an administrator-created opensprint-isolated-* internal network"
    );
  return {
    image,
    command: command as string[],
    network,
    cpus: budget("OPENSPRINT_ISOLATED_CPUS", 1, 0.1, 8),
    memoryMb: budget("OPENSPRINT_ISOLATED_MEMORY_MB", 1024, 64, 8192),
    pids: budget("OPENSPRINT_ISOLATED_PIDS", 128, 8, 512),
    timeoutMs: budget("OPENSPRINT_ISOLATED_TIMEOUT_MS", 30 * 60_000, 1000, 2 * 60 * 60_000),
    outputBytes: budget(
      "OPENSPRINT_ISOLATED_OUTPUT_BYTES",
      10 * 1024 * 1024,
      1024,
      100 * 1024 * 1024
    ),
  };
}

/** Backend-only environment: never spread process.env into a worker or a Git subprocess. */
export function isolatedControlEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? process.env.Path,
    SYSTEMROOT: process.env.SYSTEMROOT,
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : os.devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
  // Docker's local transport needs these controls, never the backend's provider/database credentials.
  if (process.env.DOCKER_HOST) env.DOCKER_HOST = process.env.DOCKER_HOST;
  if (process.env.DOCKER_CONTEXT) env.DOCKER_CONTEXT = process.env.DOCKER_CONTEXT;
  return env;
}
export function dockerRunArguments(
  config: IsolatedRunnerConfig,
  name: string,
  workspace: string,
  prompt: string
): string[] {
  if (workspace.includes(",")) throw new Error("Isolated workspace path cannot contain a comma");
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return [
    "run",
    "--name",
    name,
    "--init",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--user",
    `${uid}:${gid}`,
    "--cpus",
    String(config.cpus),
    "--memory",
    `${config.memoryMb}m`,
    "--memory-swap",
    `${config.memoryMb}m`,
    "--pids-limit",
    String(config.pids),
    "--network",
    config.network,
    "--ipc",
    "private",
    "--ulimit",
    "nofile=1024:1024",
    "--log-driver",
    "none",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=67108864",
    "--mount",
    `type=bind,source=${workspace},target=/workspace`,
    "--workdir",
    "/workspace",
    "--env",
    "HOME=/tmp",
    "--env",
    "GIT_CONFIG_NOSYSTEM=1",
    "--env",
    "GIT_CONFIG_GLOBAL=/dev/null",
    "--env",
    "CI=true",
    "--env",
    "FORCE_COLOR=0",
    "--env",
    `OPENSPRINT_PROMPT_PATH=/workspace/${prompt.replaceAll(path.sep, "/")}`,
    "--entrypoint",
    config.command[0]!,
    config.image,
    ...config.command.slice(1),
  ];
}

export interface IsolatedRunnerBoundary {
  exec: (
    file: string,
    args: string[],
    options: { cwd?: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }
  ) => Promise<{ stdout: string; stderr: string }>;
  spawn: (
    file: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] }
  ) => ChildProcess;
}
const boundary: IsolatedRunnerBoundary = {
  exec: async (file, args, options) => exec(trustedExecutable(file), args, options),
  spawn: (file, args, options) => spawn(trustedExecutable(file), args, options),
};
async function validateDockerIsolation(
  config: IsolatedRunnerConfig,
  control: (file: string, args: string[]) => Promise<{ stdout: string }>
): Promise<void> {
  const info = JSON.parse((await control("docker", ["info", "--format", "{{json .}}"])).stdout) as {
    OSType?: string;
    Warnings?: string[];
  };
  if (info.OSType !== "linux") throw new Error("Isolated runner requires a Linux Docker daemon");
  if (info.Warnings?.some((w) => /no (memory|swap|cpu|pids).*support/i.test(w)))
    throw new Error("Docker daemon cannot enforce required resource budgets");
  if (config.network !== "none") {
    const network = JSON.parse(
      (await control("docker", ["network", "inspect", config.network])).stdout
    ) as Array<{ Internal?: boolean }>;
    if (network[0]?.Internal !== true)
      throw new Error(
        "Isolated worker network must be internal; public/host networking is forbidden"
      );
  }
}

/** No host fallback. Workers receive a disposable clone; only a validated immutable bundle crosses back. */
export class IsolatedRunner {
  constructor(private readonly processBoundary: IsolatedRunnerBoundary = boundary) {}
  spawn(
    promptPath: string,
    _agentConfig: AgentConfig,
    options: InvokeCodingAgentOptions
  ): CodingAgentHandle {
    const config = getIsolatedRunnerConfig();
    const name = `opensprint-run-${randomUUID()}`;
    const env = isolatedControlEnvironment();
    let child: ChildProcess | null = null,
      stopped = false,
      finished = false,
      workspaceRoot: string | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let leaseTimer: NodeJS.Timeout | undefined;
    let totalOutput = 0;
    let containerId: string | undefined;
    let containerMayExist = false;
    let exitObserved = false;
    let quarantined = false;
    let removal: Promise<boolean> | undefined;
    let fenceSnapshot: import("../execution-ownership.service.js").ExecutionFence | undefined;
    let standaloneFence: import("../execution-ownership.service.js").ExecutionFence | undefined;
    const control = (file: string, args: string[], cwd?: string) =>
      this.processBoundary.exec(file, args, {
        cwd,
        env,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      });
    const quarantine = (error: unknown) => {
      if (quarantined || finished) return;
      quarantined = true;
      if (timeout) clearTimeout(timeout);
      const message = "Container ownership is uncertain for " + name + ": " + String(error);
      options.onOutput(message + "\n");
      options.onUncertain?.(message);
      if (fenceSnapshot)
        void executionOwnershipService.transition(fenceSnapshot, "uncertain").catch(() => {});
    };
    const terminate = (): Promise<boolean> => {
      if (exitObserved) return Promise.resolve(true);
      if (!containerId) return Promise.resolve(false);
      if (removal) return removal;
      removal = control("docker", ["rm", "--force", containerId])
        .then(() => {
          exitObserved = true;
          // The exact container was removed. Only then may its Docker client be signalled.
          child?.kill("SIGTERM");
          return true;
        })
        .catch((error) => {
          removal = undefined;
          quarantine(error);
          return false;
        });
      return removal;
    };
    const stop = () => {
      stopped = true;
      if (containerId)
        void terminate().then((observed) => {
          if (observed) void finish(null);
        });
    };
    const finish = async (code: number | null) => {
      if (finished) return;
      if (containerMayExist && !exitObserved) {
        quarantine("Container exit has not been observed");
        return;
      }
      finished = true;
      if (timeout) clearTimeout(timeout);
      if (leaseTimer) clearInterval(leaseTimer);
      await control("docker", ["rm", "--force", name]).catch(() => {});
      if (workspaceRoot)
        await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
      if (standaloneFence)
        await executionOwnershipService
          .transition(standaloneFence, stopped ? "stopped" : "completed")
          .catch(() => {});
      options.onExit(code);
    };
    const emit = (data: Buffer | string) => {
      if (finished || stopped) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      totalOutput += chunk.length;
      if (totalOutput > config.outputBytes) {
        options.onOutput("\nIsolated worker output budget exceeded.\n");
        stop();
        return;
      }
      options.onOutput(chunk.toString("utf8"));
    };
    void (async () => {
      const projectId = options.tracking?.projectId ?? options.projectId;
      const taskId = options.tracking?.taskId ?? options.tracking?.id;
      if (!projectId || !taskId)
        throw new Error("Isolated execution requires project and task identity");
      const fence =
        options.executionFence ??
        (await executionOwnershipService.acquire({
          projectId,
          taskId,
          runKey: `${taskId}:${options.agentRole ?? "agent"}`,
          attemptId: options.tracking?.attemptId ?? randomUUID(),
          leaderGeneration: projectLeadershipService.getFence(projectId)?.generation,
        }));
      if (!fence) throw new Error("Another backend owns this isolated invocation");
      fenceSnapshot = fence;
      if (!options.executionFence) {
        standaloneFence = fence;
        await executionOwnershipService.transition(fence, "running");
        leaseTimer = setInterval(() => {
          void executionOwnershipService
            .heartbeat(fence)
            .then((current) => {
              if (!current) stop();
            })
            .catch(stop);
        }, 10_000);
      }
      // Fail closed on missing Docker, unsupported Linux isolation, or a non-internal network.
      await validateDockerIsolation(config, control);
      if (stopped) return finish(null);
      await executionOwnershipService.assertCurrent(fence);
      workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-isolated-"));
      const workspace = path.join(workspaceRoot, "repository");
      const expectedBase = (
        await control(
          "git",
          ["-c", "core.hooksPath=" + os.devNull, "rev-parse", "HEAD"],
          options.cwd
        )
      ).stdout.trim();
      await control("git", [
        "-c",
        "core.hooksPath=" + os.devNull,
        "clone",
        "--no-local",
        "--no-hardlinks",
        "--no-checkout",
        "--",
        options.cwd,
        workspace,
      ]);
      await control("git", ["config", "--local", "--remove-section", "remote.origin"], workspace);
      await control("git", ["config", "--local", "core.hooksPath", "/dev/null"], workspace);
      await control("git", ["config", "--local", "core.autocrlf", "false"], workspace);
      await control(
        "git",
        ["-c", "core.hooksPath=" + os.devNull, "checkout", "--detach", expectedBase],
        workspace
      );
      const relativePrompt = path.relative(options.cwd, promptPath);
      if (relativePrompt.startsWith("..") || path.isAbsolute(relativePrompt))
        throw new Error("Isolated prompt must be inside the task worktree");
      const promptTarget = path.join(workspace, relativePrompt);
      await fs.mkdir(path.dirname(promptTarget), { recursive: true });
      await fs.copyFile(promptPath, promptTarget);
      // Only this attempt's prompt is copied. No backend settings, HOME, auth store or Git socket is mounted.
      await executionOwnershipService.assertCurrent(fence);
      if (stopped) return finish(null);
      const createArgs = dockerRunArguments(config, name, workspace, relativePrompt);
      createArgs[0] = "create";
      containerMayExist = true;
      containerId = (await control("docker", createArgs)).stdout.trim();
      if (!/^[a-f0-9]{12,64}$/.test(containerId))
        throw new Error("Docker did not return a container identity");
      if (stopped) {
        if (await terminate()) await finish(null);
        return;
      }
      let observedClientClose = false;
      let observedClientError: Error | undefined;
      const clientHandlers: { close?: () => void; error?: (error: Error) => void } = {};
      child = await executionOwnershipService.launch(fence, () => {
        const started = this.processBoundary.spawn("docker", ["start", "--attach", containerId!], {
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child = started;
        started.stdout?.on("data", emit);
        started.stderr?.on("data", emit);
        // The SQL commit can wait after spawn. Install observers synchronously so
        // a fast Docker client cannot exit or report an unhandled error in that gap.
        started.once("error", (error) => {
          observedClientError = error;
          clientHandlers.error?.(error);
        });
        started.once("close", () => {
          observedClientClose = true;
          clientHandlers.close?.();
        });
        timeout = setTimeout(
          stop,
          Math.min(config.timeoutMs, _agentConfig.timeoutMs ?? config.timeoutMs)
        );
        return started;
      });
      if (stopped) {
        if (await terminate()) await finish(null);
        return;
      }
      clientHandlers.error = (err) => {
        options.onOutput(`Isolated worker failed: ${err.message}\n`);
        void terminate().then((observed) => {
          if (observed) void finish(1);
        });
      };
      clientHandlers.close = () => {
        void (async () => {
          if (finished) return;
          if (stopped) {
            if (await terminate()) await finish(null);
            return;
          }
          const state = JSON.parse(
            (await control("docker", ["inspect", "--format", "{{json .State}}", containerId!]))
              .stdout
          ) as { Running?: boolean; ExitCode?: number };
          if (state.Running !== false || !Number.isInteger(state.ExitCode))
            throw new Error("Docker client closed without observed container exit");
          exitObserved = true;
          const code = state.ExitCode!;
          if (code !== 0) return finish(code);
          await executionOwnershipService.assertCurrent(fence);
          const bundlePath = path.join(workspace, "worker.bundle");
          // Never run worker Git config/hooks on the trusted backend. Bundle construction occurs inside the container command.
          const bundleStat = await fs.lstat(bundlePath);
          if (
            !bundleStat.isFile() ||
            bundleStat.isSymbolicLink() ||
            bundleStat.size > 100 * 1024 * 1024
          )
            throw new Error(
              "Worker must submit a regular immutable worker.bundle within its artifact budget"
            );
          const resultPath = path.join(path.dirname(promptPath), "result.json");
          const workerResult = path.join(path.dirname(promptTarget), "result.json");
          const realResult = await fs.realpath(workerResult);
          if (!realResult.startsWith(`${await fs.realpath(workspace)}${path.sep}`))
            throw new Error("Worker result escaped its private workspace");
          const resultStat = await fs.lstat(workerResult);
          if (!resultStat.isFile() || resultStat.isSymbolicLink() || resultStat.size > 1024 * 1024)
            throw new Error("Worker result must be a regular result.json under 1MB");
          const result = await fs.readFile(workerResult, "utf8");
          const parsed = JSON.parse(result) as { status?: unknown };
          if (!["success", "failed", "approved", "rejected"].includes(String(parsed?.status)))
            throw new Error("Invalid isolated worker result contract");
          await publishWorkerArtifact({
            fence,
            bundlePath,
            expectedBase,
            branchName: options.tracking?.branchName ?? "",
            targetWorktreePath: options.cwd,
          });
          await executionOwnershipService.assertCurrent(fence);
          await fs.writeFile(resultPath, result, "utf8");
          await finish(code);
        })().catch(async (err) => {
          options.onOutput(`Isolated artifact rejected: ${String(err)}\n`);
          if (!exitObserved && containerId) await terminate();
          await finish(1);
        });
      };
      if (observedClientError) clientHandlers.error(observedClientError);
      if (observedClientClose) clientHandlers.close();
    })().catch(async (err) => {
      options.onOutput(`Isolated execution unavailable: ${String(err)}\n`);
      if (containerId && !exitObserved) await terminate();
      await finish(1);
    });
    // The Docker CLI PID is not the execution identity and may exit while artifact validation runs.
    return { kill: stop, pid: null, ownership: "local" };
  }
}
export const isolatedRunner = new IsolatedRunner();

export interface IsolatedCommandBoundary {
  exec(
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }
  ): Promise<{ stdout: string; stderr: string }> & { child?: Pick<ChildProcess, "kill"> };
}

/** Execute repository-controlled gates only inside the same resource and network boundary. */
export async function runIsolatedCommand(
  workspace: string,
  command: string,
  timeoutMs?: number,
  signal?: AbortSignal,
  environment?: Record<string, string>,
  processBoundary?: IsolatedCommandBoundary
): Promise<{ exitCode: number; output: string; stopped?: boolean }> {
  signal?.throwIfAborted();
  const config = getIsolatedRunnerConfig();
  const name = "opensprint-gate-" + randomUUID();
  const env = isolatedControlEnvironment();
  const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-gate-"));
  const copy = path.join(privateRoot, "repository");
  const control = (args: string[], timeout = 30_000, maxBuffer = 2 * 1024 * 1024) =>
    processBoundary
      ? processBoundary.exec(args, { env, timeout, maxBuffer })
      : exec(trustedExecutable("docker"), args, { env, timeout, maxBuffer });
  let containerId: string | undefined;
  let exitObserved = false;
  let preserveEvidence = false;
  const uncertain = (cause: unknown) =>
    Object.assign(
      new Error(
        "Isolated execution ownership is uncertain for container " + name + ": " + String(cause)
      ),
      { code: "ISOLATED_EXECUTION_UNCERTAIN" }
    );
  try {
    await validateDockerIsolation(config, async (_file, args) => control(args));
    await fs.cp(workspace, copy, {
      recursive: true,
      dereference: false,
      filter: (source) => !/[\\/]\.git(?:[\\/]|$)/.test(source),
    });
    signal?.throwIfAborted();
    const runConfig = { ...config, command: ["/bin/sh", "-lc", command] };
    const args = dockerRunArguments(runConfig, name, copy, ".opensprint/prompt.md");
    if (environment && Object.keys(environment).length) {
      const lines = Object.entries(environment).map(([key, value]) => {
        if (
          !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ||
          /^(?:HOME|PATH|DOCKER_.*|GIT_.*|OPENSPRINT_.*)$/i.test(key)
        )
          throw new Error(
            "Deployment environment cannot override reserved isolation controls: " + key
          );
        if (typeof value !== "string" || /[\r\n\0]/.test(value))
          throw new Error("Deployment environment must contain single-line string values");
        return key + "=" + value;
      });
      // Docker reads this backend-owned file; it is outside the mount and credentials never enter argv.
      const envFile = path.join(privateRoot, "deployment.env");
      await fs.writeFile(envFile, lines.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
      args.splice(args.indexOf("--entrypoint"), 0, "--env-file", envFile);
    }
    // Create cannot execute. Persist its returned identity before start or cancellation can race.
    args[0] = "create";
    try {
      containerId = (await control(args)).stdout.trim();
    } catch (error) {
      preserveEvidence = true;
      throw uncertain(error);
    }
    if (!/^[a-f0-9]{12,64}$/.test(containerId)) {
      preserveEvidence = true;
      throw uncertain("Docker did not return a container identity");
    }
    if (signal?.aborted) {
      await control(["rm", "--force", containerId]);
      exitObserved = true;
      return { exitCode: 130, output: "Execution cancelled before launch.", stopped: true };
    }
    let resolveStop!: (value: { stdout: string; stderr: string }) => void;
    let rejectStop!: (error: Error) => void;
    let reason: "abort" | "timeout" | "failure" | undefined;
    let removal: Promise<void> | undefined;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const termination = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    const limit = Math.min(timeoutMs ?? config.timeoutMs, config.timeoutMs);
    const execution = control(
      ["start", "--attach", containerId],
      limit + 20_000,
      config.outputBytes
    );
    const stop = (nextReason: "abort" | "timeout" | "failure") => {
      if (removal) return removal;
      reason = nextReason;
      stopTimer = setTimeout(
        () => rejectStop(uncertain("Container removal was not confirmed after stop request")),
        15_000
      );
      removal = control(["rm", "--force", containerId!], 10_000)
        .then(() => {
          exitObserved = true;
          // Signal only our Docker client handle, after Docker acknowledges actual container removal.
          execution.child?.kill("SIGTERM");
          resolveStop({
            stdout: "",
            stderr: nextReason === "timeout" ? "Isolated execution time budget exceeded." : "",
          });
        })
        .catch((error) => {
          rejectStop(uncertain(error));
        });
      return removal;
    };
    const abort = () => {
      void stop("abort");
    };
    const budgetTimer = setTimeout(() => {
      void stop("timeout");
    }, limit);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let output = "";
    let commandError: unknown;
    const stoppedResult = () => ({
      exitCode: reason === "abort" ? 130 : reason === "timeout" ? 124 : 1,
      output,
      ...(reason === "abort" ? { stopped: true } : {}),
    });
    try {
      try {
        const result = await Promise.race([execution, termination]);
        output = result.stdout + result.stderr;
      } catch (error) {
        commandError = error;
        const result = error as { stdout?: string; stderr?: string; message?: string };
        output = (result.stdout ?? "") + (result.stderr ?? "") + (result.message ?? "");
      }
      if (exitObserved) return stoppedResult();
      if ((commandError as { code?: string })?.code === "ISOLATED_EXECUTION_UNCERTAIN") {
        preserveEvidence = true;
        throw commandError;
      }
      if (commandError) {
        await stop("failure");
        await termination;
        return stoppedResult();
      }
      try {
        const state = JSON.parse(
          (await control(["inspect", "--format", "{{json .State}}", containerId], 10_000)).stdout
        ) as { Running?: boolean; ExitCode?: number };
        if (exitObserved) return stoppedResult();
        if (state.Running !== false || !Number.isInteger(state.ExitCode))
          throw new Error("Container exit was not observed");
        exitObserved = true;
        return { exitCode: state.ExitCode!, output };
      } catch (error) {
        if (exitObserved && reason) return stoppedResult();
        preserveEvidence = true;
        throw uncertain(error);
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      clearTimeout(budgetTimer);
      if (stopTimer) clearTimeout(stopTimer);
    }
  } catch (error) {
    if (containerId && !exitObserved) {
      preserveEvidence = true;
      if ((error as { code?: string })?.code !== "ISOLATED_EXECUTION_UNCERTAIN")
        throw uncertain(error);
    }
    throw error;
  } finally {
    if (!preserveEvidence) {
      await Promise.resolve()
        .then(() => control(["rm", "--force", containerId ?? name], 10_000))
        .catch(() => {});
      await fs.rm(privateRoot, { recursive: true, force: true });
    }
  }
}
