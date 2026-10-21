import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFile, execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executionOwnershipService } from "../services/execution-ownership.service.js";
import {
  IsolatedRunner,
  dockerRunArguments,
  getIsolatedRunnerConfig,
  isolatedControlEnvironment,
  runIsolatedCommand,
  type IsolatedRunnerBoundary,
} from "../services/agent/isolated-runner.js";

vi.mock("../services/execution-ownership.service.js", () => ({
  executionOwnershipService: {
    assertCurrent: vi.fn().mockResolvedValue(undefined),
    transition: vi.fn().mockResolvedValue(undefined),
    launch: vi.fn(async (_f: unknown, fn: () => unknown) => fn()),
  },
  projectLeadershipService: { getFence: vi.fn() },
}));
vi.mock("../services/worker-artifact-publisher.service.js", () => ({
  publishWorkerArtifact: vi.fn().mockResolvedValue({ commitSha: "a".repeat(40) }),
}));

const pinned = `busybox@sha256:${"a".repeat(64)}`;
const fence = {
  projectId: "p",
  taskId: "t",
  runKey: "t:coding",
  attemptId: "attempt",
  ownerId: "backend",
  generation: 1,
};
describe("isolated runner boundary", () => {
  let root: string, prompt: string;
  beforeEach(async () => {
    vi.stubEnv("OPENSPRINT_ISOLATED_IMAGE", pinned);
    vi.stubEnv("OPENSPRINT_ISOLATED_COMMAND", '["/bin/sh","-c","echo worker"]');
    root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-test-"));
    prompt = path.join(root, ".opensprint", "active", "t", "prompt.md");
    await fs.mkdir(path.dirname(prompt), { recursive: true });
    await fs.writeFile(prompt, "task");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
  it("pins the worker image, validates budgets and never includes backend secrets or canonical mounts", () => {
    vi.stubEnv("DATABASE_URL", "postgres://secret");
    vi.stubEnv("OPENAI_API_KEY", "provider-secret");
    const config = getIsolatedRunnerConfig();
    const args = dockerRunArguments(
      config,
      "run-one",
      "/private/disposable",
      ".opensprint/prompt.md"
    );
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop");
    expect(args).toContain("--pids-limit");
    expect(args).toContain("no-new-privileges:true");
    expect(args).toContain("none");
    expect(args.join(" ")).not.toContain(root);
    expect(args.join(" ")).not.toContain("secret");
    expect(isolatedControlEnvironment()).not.toHaveProperty("DATABASE_URL");
    expect(isolatedControlEnvironment()).not.toHaveProperty("OPENAI_API_KEY");
    vi.stubEnv("OPENSPRINT_ISOLATED_IMAGE", "busybox:latest");
    expect(() => getIsolatedRunnerConfig()).toThrow("digest");
    vi.stubEnv("OPENSPRINT_ISOLATED_IMAGE", pinned);
    vi.stubEnv("OPENSPRINT_ISOLATED_PIDS", "0");
    expect(() => getIsolatedRunnerConfig()).toThrow("budget");
  });
  it("fails closed when Docker is unavailable, without launching a host worker", async () => {
    const exit = vi.fn();
    const output = vi.fn();
    const exec = vi.fn().mockRejectedValue(new Error("Docker unavailable"));
    const spawn = vi.fn();
    new IsolatedRunner({ exec, spawn }).spawn(
      prompt,
      { type: "custom", cliCommand: "dangerous-host-command" },
      {
        cwd: root,
        onOutput: output,
        onExit: exit,
        executionFence: fence,
        projectId: "p",
        tracking: { id: "t", projectId: "p", phase: "coding", role: "coder", label: "Coder" },
      }
    );
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(spawn).not.toHaveBeenCalled();
    expect(exec.mock.calls.every((call) => call[0] === "docker")).toBe(true);
  });
  it("creates a private known container identity and acknowledges stop only after actual removal", async () => {
    const process = new EventEmitter() as ChildProcess;
    process.stdout = new PassThrough();
    process.stderr = new PassThrough();
    process.kill = vi.fn().mockReturnValue(true);
    let acknowledge!: () => void;
    const removal = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      acknowledge = () => resolve({ stdout: "", stderr: "" });
    });
    const exit = vi.fn(),
      spawn = vi.fn(() => process);
    const exec = vi.fn(async (file: string, args: string[]) => {
      if (file === "docker" && args[0] === "info")
        return { stdout: JSON.stringify({ OSType: "linux" }), stderr: "" };
      if (file === "docker" && args[0] === "create") return { stdout: "b".repeat(64), stderr: "" };
      if (file === "docker" && args[0] === "rm") return removal;
      if (file === "git" && args.includes("clone"))
        await fs.mkdir(args.at(-1)!, { recursive: true });
      return { stdout: args.includes("rev-parse") ? "a".repeat(40) : "", stderr: "" };
    });
    const handle = new IsolatedRunner({ exec, spawn } as IsolatedRunnerBoundary).spawn(
      prompt,
      { type: "custom", cliCommand: "no-host" },
      {
        cwd: root,
        onOutput: vi.fn(),
        onExit: exit,
        executionFence: fence,
        projectId: "p",
        tracking: {
          id: "t",
          projectId: "p",
          phase: "coding",
          role: "coder",
          label: "Coder",
          branchName: "task/t",
        },
      }
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(spawn.mock.calls[0]![1]).toEqual(["start", "--attach", "b".repeat(64)]);
    const args = exec.mock.calls.find(
      ([file, args]) => file === "docker" && args[0] === "create"
    )![1];
    const mount = args[args.indexOf("--mount") + 1]!;
    expect(mount).toContain("opensprint-isolated-");
    expect(mount).not.toContain(root);
    expect(handle.pid).toBeNull();
    handle.kill();
    expect(exit).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(exec.mock.calls.some(([file, args]) => file === "docker" && args[0] === "rm")).toBe(
        true
      )
    );
    expect(exit).not.toHaveBeenCalled();
    expect(process.kill).not.toHaveBeenCalled();
    acknowledge();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(null));
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("retains worker evidence and reports uncertainty when the daemon cannot confirm termination", async () => {
    const process = new EventEmitter() as ChildProcess;
    process.stdout = new PassThrough();
    process.stderr = new PassThrough();
    process.kill = vi.fn().mockReturnValue(true);
    const spawn = vi.fn(() => process),
      exit = vi.fn(),
      uncertain = vi.fn();
    let staged = "";
    const exec = vi.fn(async (file: string, args: string[]) => {
      if (file === "docker" && args[0] === "info")
        return { stdout: JSON.stringify({ OSType: "linux" }), stderr: "" };
      if (file === "git" && args.includes("clone"))
        await fs.mkdir(args.at(-1)!, { recursive: true });
      if (file === "docker" && args[0] === "create") {
        const mount = args[args.indexOf("--mount") + 1]!;
        staged = mount.slice("type=bind,source=".length, mount.indexOf(",target="));
        return { stdout: "c".repeat(64), stderr: "" };
      }
      if (file === "docker" && args[0] === "rm") throw new Error("daemon disconnected");
      return { stdout: args.includes("rev-parse") ? "a".repeat(40) : "", stderr: "" };
    });
    const handle = new IsolatedRunner({ exec, spawn }).spawn(
      prompt,
      { type: "custom" },
      {
        cwd: root,
        onOutput: vi.fn(),
        onExit: exit,
        onUncertain: uncertain,
        executionFence: fence,
        projectId: "p",
        tracking: { id: "t", projectId: "p", phase: "coding", role: "coder", label: "Coder" },
      }
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    handle.kill();
    await vi.waitFor(() => expect(uncertain).toHaveBeenCalledOnce());
    expect(exit).not.toHaveBeenCalled();
    expect(process.kill).not.toHaveBeenCalled();
    expect(await fs.stat(staged)).toBeDefined();
    await fs.rm(path.dirname(staged), { recursive: true, force: true });
  });

  it.each([
    ["close", 23],
    ["error", 1],
  ] as const)(
    "observes Docker client %s before the fenced launch transaction commits",
    async (event, expected) => {
      const process = new EventEmitter() as ChildProcess;
      process.stdout = new PassThrough();
      process.stderr = new PassThrough();
      process.kill = vi.fn().mockReturnValue(true);
      const exit = vi.fn(),
        output = vi.fn();
      const exec = vi.fn(async (file: string, args: string[]) => {
        if (file === "docker" && args[0] === "info")
          return { stdout: JSON.stringify({ OSType: "linux" }), stderr: "" };
        if (file === "docker" && args[0] === "create")
          return { stdout: "d".repeat(64), stderr: "" };
        if (file === "docker" && args[0] === "inspect")
          return { stdout: JSON.stringify({ Running: false, ExitCode: 23 }), stderr: "" };
        if (file === "git" && args.includes("clone"))
          await fs.mkdir(args.at(-1)!, { recursive: true });
        return { stdout: args.includes("rev-parse") ? "a".repeat(40) : "", stderr: "" };
      });
      vi.mocked(executionOwnershipService.launch).mockImplementationOnce(async (_f, launch) => {
        const handle = launch();
        if (event === "error") process.emit("error", new Error("early Docker error"));
        else process.emit("close", 23);
        await Promise.resolve();
        return handle;
      });
      new IsolatedRunner({ exec, spawn: () => process }).spawn(
        prompt,
        { type: "custom" },
        {
          cwd: root,
          onOutput: output,
          onExit: exit,
          executionFence: fence,
          projectId: "p",
          tracking: { id: "t", projectId: "p", phase: "coding", role: "coder", label: "Coder" },
        }
      );
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(expected));
      if (event === "error")
        expect(output).toHaveBeenCalledWith(
          expect.stringContaining("Isolated worker failed: early Docker error")
        );
    }
  );
  it("rejects an external Docker network before preparing or launching the worker", async () => {
    vi.stubEnv("OPENSPRINT_ISOLATED_NETWORK", "opensprint-isolated-egress");
    const exec = vi.fn(async (_file: string, args: string[]) => ({
      stdout: JSON.stringify(args[0] === "info" ? { OSType: "linux" } : [{ Internal: false }]),
      stderr: "",
    }));
    const spawn = vi.fn(),
      exit = vi.fn();
    new IsolatedRunner({ exec, spawn }).spawn(
      prompt,
      { type: "custom" },
      {
        cwd: root,
        onOutput: vi.fn(),
        onExit: exit,
        executionFence: fence,
        projectId: "p",
        tracking: { id: "t", projectId: "p", phase: "coding", role: "coder", label: "Coder" },
      }
    );
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(spawn).not.toHaveBeenCalled();
  });

  function commandBoundary(
    options: {
      start?: () => Promise<{ stdout: string; stderr: string }>;
      remove?: () => Promise<{ stdout: string; stderr: string }>;
    } = {}
  ) {
    const kill = vi.fn();
    const exec = vi.fn((args: string[]) => {
      let promise: Promise<{ stdout: string; stderr: string }>;
      if (args[0] === "info")
        promise = Promise.resolve({ stdout: JSON.stringify({ OSType: "linux" }), stderr: "" });
      else if (args[0] === "create")
        promise = Promise.resolve({ stdout: "b".repeat(64), stderr: "" });
      else if (args[0] === "start")
        promise = options.start?.() ?? Promise.resolve({ stdout: "gates passed", stderr: "" });
      else if (args[0] === "inspect")
        promise = Promise.resolve({
          stdout: JSON.stringify({ Running: false, ExitCode: 0 }),
          stderr: "",
        });
      else promise = options.remove?.() ?? Promise.resolve({ stdout: "", stderr: "" });
      return Object.assign(promise, { child: { kill } });
    });
    return { exec, kill };
  }
  it("creates a known identity before start and checks the actual container exit", async () => {
    const boundary = commandBoundary();
    const result = await runIsolatedCommand(
      root,
      "npm test",
      undefined,
      undefined,
      undefined,
      boundary
    );
    expect(result).toEqual({ exitCode: 0, output: "gates passed" });
    expect(boundary.exec.mock.calls.map(([args]) => args[0])).toEqual([
      "info",
      "create",
      "start",
      "inspect",
      "rm",
    ]);
    const mount = boundary.exec.mock.calls[1]![0];
    expect(mount[mount.indexOf("--mount") + 1]).not.toContain(root);
  });
  it("waits for actual container removal before acknowledging cancellation", async () => {
    let acknowledge!: () => void;
    const removal = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      acknowledge = () => resolve({ stdout: "", stderr: "" });
    });
    const boundary = commandBoundary({ start: () => new Promise(() => {}), remove: () => removal });
    const controller = new AbortController();
    let settled = false;
    const running = runIsolatedCommand(
      root,
      "sleep 900",
      undefined,
      controller.signal,
      undefined,
      boundary
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() =>
      expect(boundary.exec.mock.calls.some(([args]) => args[0] === "start")).toBe(true)
    );
    controller.abort();
    await vi.waitFor(() =>
      expect(boundary.exec.mock.calls.some(([args]) => args[0] === "rm")).toBe(true)
    );
    expect(settled).toBe(false);
    expect(boundary.kill).not.toHaveBeenCalled();
    acknowledge();
    expect(await running).toMatchObject({ exitCode: 130, stopped: true });
    expect(boundary.kill).toHaveBeenCalledOnce();
  });
  it("quarantines a container whose cancellation cannot be observed", async () => {
    const boundary = commandBoundary({
      start: () => new Promise(() => {}),
      remove: () => Promise.reject(new Error("daemon disconnected")),
    });
    const controller = new AbortController();
    const running = runIsolatedCommand(
      root,
      "sleep 900",
      undefined,
      controller.signal,
      undefined,
      boundary
    );
    const rejected = expect(running).rejects.toMatchObject({
      code: "ISOLATED_EXECUTION_UNCERTAIN",
    });
    await vi.waitFor(() =>
      expect(boundary.exec.mock.calls.some(([args]) => args[0] === "start")).toBe(true)
    );
    controller.abort();
    await rejected;
    expect(boundary.kill).not.toHaveBeenCalled();
    const args = boundary.exec.mock.calls.find(([args]) => args[0] === "create")![0];
    const mount = args[args.indexOf("--mount") + 1]!;
    const staged = mount.slice("type=bind,source=".length, mount.indexOf(",target="));
    expect(await fs.stat(staged)).toBeDefined();
    await fs.rm(path.dirname(staged), { recursive: true, force: true });
  });
  it("passes only explicitly scoped deployment credentials through a private environment file", async () => {
    vi.stubEnv("DATABASE_URL", "ambient-backend-database-secret");
    let envFile = "";
    const boundary = commandBoundary({
      start: async () => {
        const args = boundary.exec.mock.calls.find(([args]) => args[0] === "create")![0];
        envFile = args[args.indexOf("--env-file") + 1]!;
        expect(await fs.readFile(envFile, "utf8")).toBe(
          "DEPLOY_TOKEN=explicit-deployment-credential\n"
        );
        const mount = args[args.indexOf("--mount") + 1]!;
        expect(mount).not.toContain(envFile);
        expect(args.join(" ")).not.toContain("credential");
        expect(args.join(" ")).not.toContain("ambient-backend");
        return { stdout: "deployed", stderr: "" };
      },
    });
    expect(
      await runIsolatedCommand(
        root,
        "deploy",
        undefined,
        undefined,
        { DEPLOY_TOKEN: "explicit-deployment-credential" },
        boundary
      )
    ).toMatchObject({ exitCode: 0 });
    await expect(fs.stat(envFile)).rejects.toThrow();
    const reserved = commandBoundary();
    await expect(
      runIsolatedCommand(root, "deploy", undefined, undefined, { DOCKER_HOST: "escape" }, reserved)
    ).rejects.toThrow("reserved isolation controls");
    expect(reserved.exec.mock.calls.some(([args]) => args[0] === "start")).toBe(false);
  });
  it("enforces the time budget with observed removal and reports failure rather than user cancellation", async () => {
    const boundary = commandBoundary({ start: () => new Promise(() => {}) });
    const result = await runIsolatedCommand(root, "sleep 900", 25, undefined, undefined, boundary);
    expect(result.exitCode).toBe(124);
    expect(result.stopped).not.toBe(true);
    expect(result.output).toContain("time budget");
    expect(boundary.exec.mock.calls.some(([args]) => args[0] === "rm")).toBe(true);
  });
});

const dockerAvailable =
  spawnSync("docker", ["info", "--format", "{{.OSType}}"], {
    encoding: "utf8",
    timeout: 10_000,
  }).stdout?.trim() === "linux";
it.skipIf(process.env.OPENSPRINT_REQUIRE_DOCKER_TESTS !== "1")(
  "CI requires the real Linux Docker execution acceptance fixture",
  () => {
    expect(
      dockerAvailable,
      "CI must provide a Linux Docker daemon; acceptance cannot be silently skipped"
    ).toBe(true);
  }
);
let smokeImage: string | undefined = process.env.OPENSPRINT_DOCKER_SMOKE_IMAGE;
function dockerSmokeImage(): string {
  if (!smokeImage) {
    execFileSync("docker", ["pull", "busybox:1.37"], { timeout: 120_000, stdio: "pipe" });
    smokeImage = JSON.parse(
      execFileSync(
        "docker",
        ["image", "inspect", "busybox:1.37", "--format", "{{json .RepoDigests}}"],
        { encoding: "utf8" }
      )
    )[0] as string;
  }
  return smokeImage;
}
it.skipIf(!dockerAvailable)(
  "Docker smoke: read-only root, scoped environment, bounded resources and disposable gate workspace",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "docker-smoke-"));
    try {
      const image = dockerSmokeImage();
      vi.stubEnv("OPENSPRINT_ISOLATED_IMAGE", image);
      vi.stubEnv("OPENSPRINT_ISOLATED_COMMAND", '["/bin/sh"]');
      vi.stubEnv("DATABASE_URL", "backend-secret");
      await fs.writeFile(path.join(root, "input.txt"), "private snapshot");
      const result = await runIsolatedCommand(
        root,
        'test -z "$DATABASE_URL" && test -f input.txt && ! touch /host-escape && echo isolated > output.txt && cat /sys/fs/cgroup/pids.max && cat /sys/fs/cgroup/memory.max && echo smoke-passed'
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain("smoke-passed");
      expect(result.output).toContain("128");
      await expect(fs.stat(path.join(root, "output.txt"))).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  180_000
);

it.skipIf(!dockerAvailable)(
  "Docker smoke: cancellation waits for removal of an actually running container",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "docker-stop-smoke-"));
    const controller = new AbortController();
    const nativeExec = promisify(execFile);
    let containerId = "";
    const control = {
      exec: (
        args: string[],
        options: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }
      ) => {
        const result = nativeExec("docker", args, options);
        if (args[0] === "create")
          void result
            .then((value) => {
              containerId = value.stdout.trim();
            })
            .catch(() => {});
        return result;
      },
    };
    let running: ReturnType<typeof runIsolatedCommand> | undefined;
    try {
      vi.stubEnv("OPENSPRINT_ISOLATED_IMAGE", dockerSmokeImage());
      vi.stubEnv("OPENSPRINT_ISOLATED_COMMAND", '["/bin/sh"]');
      running = runIsolatedCommand(
        root,
        "sleep 120",
        30_000,
        controller.signal,
        undefined,
        control
      );
      void running.catch(() => {});
      await vi.waitFor(
        async () => {
          expect(containerId).toMatch(/^[a-f0-9]{64}$/);
          const state = await nativeExec(
            "docker",
            ["inspect", "--format", "{{.State.Running}}", containerId],
            { timeout: 10_000 }
          );
          expect(state.stdout.trim()).toBe("true");
        },
        { timeout: 20_000, interval: 100 }
      );
      controller.abort();
      expect(await running).toMatchObject({ exitCode: 130, stopped: true });
      await expect(
        nativeExec("docker", ["inspect", containerId], { timeout: 10_000 })
      ).rejects.toThrow();
    } finally {
      controller.abort();
      await running?.catch(() => {});
      if (containerId)
        await nativeExec("docker", ["rm", "--force", containerId], { timeout: 10_000 }).catch(
          () => {}
        );
      vi.unstubAllEnvs();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  180_000
);
