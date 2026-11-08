import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initAppDb, type AppDb } from "../db/app-db.js";
import { LocalRecoveryController } from "../services/local-recovery-controller.js";
import { LocalRecoveryStore } from "../services/local-recovery-store.js";
import {
  captureExecutionProfile,
  type ProjectExecutionProfile,
} from "../services/project-execution-profile.service.js";
import type {
  MergeQualityGateFailure,
  MergeQualityGateRunOptions,
} from "../services/merge-quality-gate-runner.js";
import { runMergeQualityGates } from "../services/merge-quality-gate-runner.js";
import { verifyRuntimeBinding } from "../services/local-runtime-binding.js";
import { runCommand as runRealCommand } from "../utils/command-runner.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("local recovery adversarial contracts", () => {
  let db: AppDb;
  let workspace: string;
  let store: LocalRecoveryStore;
  let profile: ProjectExecutionProfile;
  let options: MergeQualityGateRunOptions;

  beforeEach(async () => {
    db = await initAppDb("sqlite://:memory:");
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "local-recovery-adversarial-"));
    store = new LocalRecoveryStore(() => db.getClient(), "fixture-host");
    profile = {
      authorityHash: "approved-authority",
      contextHash: "execution-context",
      head: "retained-head",
      cwd: workspace,
      inputs: [],
    };
    options = {
      projectId: "recovery-fixture",
      taskId: "task-current",
      repoPath: workspace,
      worktreePath: workspace,
      branchName: "opensprint/task-current",
      baseBranch: "main",
      toolchainProfile: {
        dependencyStrategy: "none",
        mergeQualityGateCommands: ["project-verify"],
      },
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await db.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function controller() {
    return new LocalRecoveryController(store, { capture: async () => profile });
  }

  function unknownFailure(): MergeQualityGateFailure {
    return {
      command: "project-verify",
      reason: "Verification stopped before producing evidence",
      output: "Unknown execution condition",
      category: "quality_gate",
      classificationReason: "no environment fingerprint detected",
    };
  }

  it("retains a cancelled command receipt and cleanup protection until observed close", async () => {
    const started = deferred<void>();
    const abortObserved = deferred<void>();
    const closed = deferred<void>();
    const recovery = new LocalRecoveryController(store, {
      capture: async () => profile,
      runCommand: async (_spec, commandOptions) => {
        await commandOptions.onSpawn?.(777777);
        commandOptions.signal?.addEventListener("abort", () => abortObserved.resolve(), {
          once: true,
        });
        started.resolve();
        await closed.promise;
        return {
          stdout: "late success after stop requested",
          stderr: "",
          executable: "project-verify",
          cwd: workspace,
          exitCode: 0,
          signal: null,
        };
      },
    });
    const validation = recovery.run({
      ...options,
      validate: async (execute) => {
        await execute({ command: "project-verify" }, { cwd: workspace });
        return null;
      },
    });
    await started.promise;
    let cancelled = false;
    const cancelling = recovery.cancelTask(options.projectId, options.taskId).then(() => {
      cancelled = true;
    });
    try {
      await abortObserved.promise;
      const run = await store.get(options.projectId, await fs.realpath(workspace));
      expect(run).toMatchObject({ state: "cancelled", data: { activeCommand: { pid: 777777 } } });
      expect(cancelled).toBe(false);
      expect(await store.protectsWorkspace(await fs.realpath(workspace))).toBe(true);
      expect(await store.protectsWorktreeKey(options.taskId)).toBe(true);
      closed.resolve();
      await cancelling;
      expect(await validation).not.toBeNull();
      expect(await store.protectsWorkspace(await fs.realpath(workspace))).toBe(false);
      expect(
        (await store.get(options.projectId, await fs.realpath(workspace)))?.data.activeCommand
      ).toBeUndefined();
      expect(await store.recipe(options.projectId, profile.contextHash)).toBeUndefined();
    } finally {
      closed.resolve();
      await cancelling;
      await validation;
    }
  });

  it("does not start validation cancelled while queued behind another task", async () => {
    const recovery = controller();
    const firstStarted = deferred<void>();
    const finishFirst = deferred<MergeQualityGateFailure | null>();
    const first = recovery.run({
      ...options,
      taskId: "task-first",
      validate: async () => {
        firstStarted.resolve();
        return finishFirst.promise;
      },
    });
    await firstStarted.promise;
    const validateQueued = vi.fn(async () => null);
    const queued = recovery.run({ ...options, taskId: "task-queued", validate: validateQueued });
    const cancellationPersisted = deferred<void>();
    const cancel = store.cancelTask.bind(store);
    vi.spyOn(store, "cancelTask").mockImplementation(async (projectId, taskId) => {
      await cancel(projectId, taskId);
      cancellationPersisted.resolve();
    });
    let cancellationCompleted = false;
    const cancelled = recovery.cancelTask(options.projectId, "task-queued").then(() => {
      cancellationCompleted = true;
    });
    await cancellationPersisted.promise;
    let firstResult: MergeQualityGateFailure | null | undefined;
    try {
      await vi.waitFor(() => expect(cancellationCompleted).toBe(true));
    } finally {
      finishFirst.resolve(null);
      [firstResult] = await Promise.all([first, queued, cancelled]);
    }
    expect(firstResult).toBeNull();
    expect(validateQueued).not.toHaveBeenCalled();
  });

  it("does not let a completed task cancel a later occupant of its workspace", async () => {
    const recovery = controller();
    await recovery.run({ ...options, taskId: "task-complete", validate: async () => null });
    const nextStarted = deferred<void>();
    const finishNext = deferred<MergeQualityGateFailure | null>();
    const next = recovery.run({
      ...options,
      taskId: "task-next",
      validate: async () => {
        nextStarted.resolve();
        return finishNext.promise;
      },
    });
    await nextStarted.promise;
    await recovery.cancelTask(options.projectId, "task-complete");
    finishNext.resolve(null);
    expect(await next).toBeNull();
    expect((await store.get(options.projectId, await fs.realpath(workspace)))?.state).toBe(
      "passed"
    );
  });

  it("retains completed work when validation authority changed before admission", async () => {
    const validate = vi.fn(async () => null);
    const result = await controller().run({
      ...options,
      expectedAuthorityHash: "previous-authority",
      validate,
    });
    expect(validate).not.toHaveBeenCalled();
    expect(result?.recoveryIncidentId).toBeTruthy();
    expect((await store.retained(options.projectId)).map((item) => item.taskId)).toContain(
      options.taskId
    );
  });

  it("protects the physical workspace when a later admission failure uses a separate incident", async () => {
    const recovery = controller();
    expect(
      await recovery.run({
        ...options,
        taskId: "task-previous-validation",
        validate: async () => null,
      })
    ).toBeNull();
    profile = { ...profile, authorityHash: "changed-authority", contextHash: "changed-context" };
    const result = await recovery.run({
      ...options,
      taskId: "task-later-authority-failure",
      expectedAuthorityHash: "approved-authority",
      validate: vi.fn(async () => null),
    });
    expect(result?.recoveryIncidentId).toBeTruthy();
    expect(await store.protectsWorkspace(await fs.realpath(workspace))).toBe(true);
  });

  it("rejects validation success after execution inputs changed during the check", async () => {
    const result = await controller().run({
      ...options,
      diagnose: async () => "retry_validation",
      validate: async () => {
        profile = { ...profile, contextHash: "changed-inputs" };
        return null;
      },
    });
    expect(result).not.toBeNull();
    expect(await store.recipe(options.projectId, "execution-context")).toBeUndefined();
    expect((await store.get(options.projectId, await fs.realpath(workspace)))?.state).toBe("held");
  });

  it("cannot learn a passing recipe from diagnosis when the required check still fails", async () => {
    const failure: MergeQualityGateFailure = {
      ...unknownFailure(),
      reason: "A required assertion is false",
      classificationReason: "compiler/linter diagnostic indicates code-level gate failure",
    };
    const validate = vi.fn().mockResolvedValueOnce(unknownFailure()).mockResolvedValue(failure);
    const result = await controller().run({
      ...options,
      validate,
      diagnose: async () => "retry_validation",
    });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ category: "quality_gate", reason: failure.reason });
    expect(await store.recipe(options.projectId, profile.contextHash)).toBeUndefined();
  });

  it("holds an unfamiliar failure after escalation and retains completed work without another validation attempt", async () => {
    const source = path.join(workspace, "completed-feature.txt");
    await fs.writeFile(source, "Completed coding must survive an unknown execution fault\n");
    const validate = vi.fn(async () => unknownFailure());
    const diagnose = vi.fn(async () => "escalate" as const);
    const recovery = controller();
    const held = await recovery.run({ ...options, validate, diagnose });
    expect(held).toMatchObject({
      preserveWork: true,
      category: "environment_setup",
      classificationReason: "local_recovery_held",
      recoveryIncidentId: expect.any(String),
    });
    expect((await store.get(options.projectId, await fs.realpath(workspace)))?.state).toBe("held");
    expect(await store.retained(options.projectId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: options.taskId })])
    );
    expect(await recovery.run({ ...options, validate, diagnose })).toMatchObject({
      preserveWork: true,
      recoveryIncidentId: held!.recoveryIncidentId,
    });
    expect(validate).toHaveBeenCalledOnce();
    expect(diagnose).toHaveBeenCalledOnce();
    expect(await fs.readFile(source, "utf8")).toContain("Completed coding must survive");
    expect(await store.recipe(options.projectId, profile.contextHash)).toBeUndefined();
    expect(await store.executionProfile(options.projectId, profile.contextHash)).toBeUndefined();
  });

  it("routes an unfamiliar check diagnosed as a code failure without promoting verification or changing the failed check", async () => {
    const failure = {
      ...unknownFailure(),
      reason: "The project-specific assertion rejected the implemented behavior",
      output: "Account balance should equal 5, received 4 at custom checker line 18",
      firstErrorLine: "Account balance should equal 5, received 4",
      exitCode: 1,
    };
    const validate = vi.fn(async () => failure);
    const diagnose = vi.fn(async () => "code_failure" as const);
    const result = await controller().run({ ...options, validate, diagnose });
    expect(result).toBe(failure);
    expect(result?.preserveWork).toBeUndefined();
    expect(validate).toHaveBeenCalledOnce();
    expect(diagnose).toHaveBeenCalledOnce();
    expect((await store.get(options.projectId, await fs.realpath(workspace)))?.state).toBe(
      "failed"
    );
    expect(await store.recipe(options.projectId, profile.contextHash)).toBeUndefined();
    expect(await store.executionProfile(options.projectId, profile.contextHash)).toBeUndefined();
  });

  it("uses an authorized readiness probe when diagnosis identifies an unfamiliar resource wait", async () => {
    let available = false;
    const pause = vi.fn(async () => {
      available = true;
    });
    const runCommand = vi.fn(async (spec, commandOptions) => {
      if (!available) throw new Error("The owner-configured resource is still busy");
      return {
        stdout: "ready",
        stderr: "",
        executable: spec.command,
        cwd: commandOptions.cwd,
        exitCode: 0,
        signal: null,
      };
    });
    const validate = vi.fn().mockResolvedValueOnce(unknownFailure()).mockResolvedValue(null);
    const diagnose = vi.fn(async () => "wait" as const);
    const result = await new LocalRecoveryController(store, {
      capture: async () => profile,
      runCommand,
      wait: pause,
    }).run({
      ...options,
      toolchainProfile: { ...options.toolchainProfile, resourceProbeCommand: "resource-ready" },
      validate,
      diagnose,
    });
    expect(result).toBeNull();
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(runCommand.mock.calls.map(([spec]) => spec.command)).toEqual([
      "resource-ready",
      "resource-ready",
    ]);
  });

  it("remembers a retry only after an independently passing required check", async () => {
    const validate = vi.fn().mockResolvedValueOnce(unknownFailure()).mockResolvedValue(null);
    const result = await controller().run({
      ...options,
      validate,
      diagnose: async () => "retry_validation",
    });
    expect(result).toBeNull();
    expect(validate).toHaveBeenCalledTimes(2);
    expect(await store.recipe(options.projectId, profile.contextHash)).toBe("retry_validation");
  });

  it("falls back to diagnosis when an old dependency recipe no longer has a failing health probe", async () => {
    const toolchainProfile = {
      ...options.toolchainProfile,
      dependencyHealthCheckCommand: "dependency-health",
      dependencyInstallCommand: "repair-owned-dependencies",
    };
    let seedHealthChecks = 0;
    const seedRunner = vi.fn(async (spec, commandOptions) => {
      if (spec.command === "dependency-health" && seedHealthChecks++ === 0) {
        throw new Error("Health probe detected the original dependency failure");
      }
      return {
        stdout: "healthy",
        stderr: "",
        executable: spec.command,
        cwd: commandOptions.cwd,
        exitCode: 0,
        signal: null,
      };
    });
    const seedValidation = vi.fn().mockResolvedValueOnce(unknownFailure()).mockResolvedValue(null);
    expect(
      await new LocalRecoveryController(store, {
        capture: async () => profile,
        runCommand: seedRunner,
      }).run({
        ...options,
        taskId: "task-prior-dependency-failure",
        toolchainProfile,
        validate: seedValidation,
        diagnose: async () => "repair_dependencies",
      })
    ).toBeNull();
    expect(await store.recipe(options.projectId, profile.contextHash)).toBe("repair_dependencies");
    const runCommand = vi.fn(async (_spec, commandOptions) => ({
      stdout: "healthy",
      stderr: "",
      executable: "dependency-health",
      cwd: commandOptions.cwd,
      exitCode: 0,
      signal: null,
    }));
    const validate = vi.fn().mockResolvedValueOnce(unknownFailure()).mockResolvedValue(null);
    const diagnose = vi.fn(async () => "retry_validation" as const);
    const result = await new LocalRecoveryController(store, {
      capture: async () => profile,
      runCommand,
    }).run({
      ...options,
      taskId: "task-different-failure",
      toolchainProfile,
      validate,
      diagnose,
    });
    expect(result).toBeNull();
    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(
      runCommand.mock.calls.every(([spec]) => spec.command !== "repair-owned-dependencies")
    ).toBe(true);
  });

  it("does not relaunch an unreceipted command after its backend owner disappears", async () => {
    const previous = new LocalRecoveryStore(() => db.getClient(), "fixture-host", 12345);
    const workspaceRoot = await fs.realpath(workspace);
    const incident = await previous.create(options.projectId, workspaceRoot, profile.contextHash);
    incident.data.activeCommand = { label: "project-verify" };
    await previous.save(incident);
    const validate = vi.fn(async () => null);
    const result = await new LocalRecoveryController(store, {
      capture: async () => profile,
      isAlive: () => false,
    }).run({ ...options, validate });
    expect(result).not.toBeNull();
    expect(validate).not.toHaveBeenCalled();
    expect((await store.get(options.projectId, workspaceRoot))?.owner).toBe(previous.owner);
  });

  it("bounds the verification command by the remaining recovery wall budget", async () => {
    const wallClock = Date.now();
    const runCommand = vi.fn(async (_spec, commandOptions) => ({
      stdout: "",
      stderr: "",
      executable: "project-verify",
      cwd: commandOptions.cwd,
      exitCode: 0,
      signal: null,
    }));
    let checks = 0;
    const result = await new LocalRecoveryController(store, {
      capture: async () => profile,
      runCommand,
      now: () => wallClock,
      maxWallTimeMs: 100,
    }).run({
      ...options,
      diagnose: async () => "retry_validation",
      validate: async (supervised) => {
        if (checks++ === 0) return unknownFailure();
        await supervised({ command: "project-verify" }, { cwd: workspace, timeout: 5000 });
        return null;
      },
    });
    expect(result).toBeNull();
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0][1].timeout).toBeLessThanOrEqual(100);
  });

  it("invalidates learned context when an arbitrary project validator changes", async () => {
    const git = (args: string[]) =>
      execFileSync("git", args, {
        cwd: workspace,
        stdio: "pipe",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      });
    git(["init", "-b", "main"]);
    const validator = path.join(workspace, "tools", "check.py");
    await fs.mkdir(path.dirname(validator));
    await fs.writeFile(validator, "print('first validator')\n");
    const commit = () => {
      git(["add", "tools/check.py"]);
      git([
        "-c",
        "user.name=Recovery Fixture",
        "-c",
        "user.email=recovery@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        "validator fixture",
      ]);
    };
    commit();
    const toolchainProfile = {
      dependencyStrategy: "none" as const,
      mergeQualityGateCommands: ["python3 tools/check.py"],
    };
    const before = await captureExecutionProfile(workspace, toolchainProfile);
    await fs.writeFile(validator, "raise RuntimeError('new validator')\n");
    commit();
    const after = await captureExecutionProfile(workspace, toolchainProfile);
    expect(after.head).not.toBe(before.head);
    expect(after.contextHash).not.toBe(before.contextHash);
  });

  it("cannot replace an explicit validation directory with a passing root npm script", async () => {
    const git = (args: string[]) => execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
    git(["init", "-b", "main"]);
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({
        name: "root-fixture",
        scripts: { verify: "node root-validation.cjs" },
      })
    );
    await fs.mkdir(path.join(workspace, "backend"));
    git(["add", "package.json"]);
    git([
      "-c",
      "user.name=Recovery Fixture",
      "-c",
      "user.email=recovery@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "root validator fixture",
    ]);
    vi.stubEnv("NODE_ENV", "development");
    const runCommand = vi.fn(async (spec, commandOptions) => ({
      stdout: spec.command === "git" && spec.args?.includes("--show-toplevel") ? workspace : "",
      stderr: "",
      executable: spec.command,
      cwd: commandOptions.cwd,
      exitCode: 0,
      signal: null,
    }));
    const result = await runMergeQualityGates(
      {
        ...options,
        skipEnvironmentRepair: true,
        toolchainProfile: {
          dependencyStrategy: "none",
          workingDirectory: "backend",
          mergeQualityGateCommands: ["npm run verify"],
        },
      },
      { runCommand }
    );
    expect(result).toMatchObject({ category: "environment_setup" });
    expect(
      runCommand.mock.calls.some(
        ([spec]) => spec.command === "npm" && spec.args?.includes("verify")
      )
    ).toBe(false);
  });

  it.each([
    ["Copyright 2026\nfixture-tool 1.0.0\n", false],
    ["fixture-tool 24.1.0\n", true],
  ])(
    "verifies the tool version rather than an unrelated number in %j",
    async (stdout, accepted) => {
      const binding = {
        tool: "fixture-tool",
        executable: "/installed/fixture-tool",
        expectedRange: ">=24.0.0",
        evidencePath: "README.md",
      };
      const execution = vi.fn(async () => ({
        stdout,
        stderr: "",
        executable: binding.executable,
        cwd: workspace,
        exitCode: 0,
        signal: null,
      }));
      expect(
        await verifyRuntimeBinding(
          binding,
          {
            ...profile,
            runtimeCandidates: { "fixture-tool": [binding.executable] },
            documents: { "README.md": "fixture-tool requires >=24.0.0" },
          },
          execution
        )
      ).toBe(accepted);
    }
  );

  it.skipIf(process.platform === "win32")(
    "learns a declared transitive runtime for an unchanged shell gate and reuses it locally",
    async () => {
      const project = path.join(workspace, "project");
      const preferredBin = path.join(workspace, "installed-runtime-2");
      const wrongBin = path.join(workspace, "installed-runtime-1");
      for (const dir of [project, preferredBin, wrongBin]) await fs.mkdir(dir);
      const runtime = "fixture-runtime";
      const executable = path.join(preferredBin, runtime);
      await fs.writeFile(executable, "#!/bin/sh\nprintf '2.0.0\\n'\n", { mode: 0o755 });
      await fs.writeFile(path.join(wrongBin, runtime), "#!/bin/sh\nprintf '1.0.0\\n'\n", {
        mode: 0o755,
      });
      await fs.writeFile(
        path.join(project, "README.md"),
        "fixture-runtime requires >=2.0.0 <3.0.0\n"
      );
      await fs.writeFile(
        path.join(project, "check.sh"),
        '#!/bin/sh\n[ "$(fixture-runtime --version)" = "2.0.0" ]\n'
      );
      const git = (args: string[]) => execFileSync("git", args, { cwd: project, stdio: "pipe" });
      git(["init", "-b", "main"]);
      git(["add", "README.md", "check.sh"]);
      git([
        "-c",
        "user.name=Recovery Fixture",
        "-c",
        "user.email=recovery@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-m",
        "Trusted wrapper and runtime constraint",
      ]);
      vi.stubEnv(
        "PATH",
        [wrongBin, preferredBin, process.env.PATH ?? "/usr/bin:/bin"].join(path.delimiter)
      );
      const request = {
        ...options,
        repoPath: project,
        worktreePath: project,
        toolchainProfile: {
          dependencyStrategy: "none" as const,
          mergeQualityGateCommands: ["sh ./check.sh"],
          runtimeTools: [runtime],
        },
      };
      const diagnose = vi.fn(async () => ({
        action: "bind_runtime" as const,
        binding: {
          tool: runtime,
          executable,
          expectedRange: ">=2.0.0 <3.0.0",
          evidencePath: "README.md",
        },
      }));
      const validate = vi.fn(async (execute: typeof runRealCommand) => {
        try {
          await execute({ command: "sh", args: ["./check.sh"] }, { cwd: project });
          return null;
        } catch {
          return unknownFailure();
        }
      });
      const recovery = new LocalRecoveryController(store);
      expect(await recovery.run({ ...request, diagnose, validate })).toBeNull();
      expect(validate).toHaveBeenCalledTimes(2);
      expect(diagnose).toHaveBeenCalledOnce();
      const captured = await captureExecutionProfile(project, request.toolchainProfile, "main");
      expect(await store.executionProfile(request.projectId, captured.recipeHash!)).toMatchObject({
        runtimeBindings: [{ tool: runtime, executable }],
      });
      validate.mockClear();
      expect(
        await recovery.run({ ...request, taskId: "second-wrapper-task", diagnose, validate })
      ).toBeNull();
      expect(validate).toHaveBeenCalledOnce();
      expect(diagnose).toHaveBeenCalledOnce();
      expect(await fs.readFile(path.join(project, "check.sh"), "utf8")).toBe(
        '#!/bin/sh\n[ "$(fixture-runtime --version)" = "2.0.0" ]\n'
      );
    }
  );

  it.skipIf(process.platform === "win32")(
    "keeps a learned runtime binding in nested tool execution",
    async () => {
      const preferredBin = path.join(workspace, ".nvm", "versions", "node", "v24.0.0", "bin");
      const newerBin = path.join(workspace, ".nvm", "versions", "node", "v26.0.0", "bin");
      await fs.mkdir(preferredBin, { recursive: true });
      await fs.mkdir(newerBin, { recursive: true });
      const executable = path.join(preferredBin, "fixture-tool");
      await fs.writeFile(
        executable,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then printf \'24.0.0\\n\'; else exec fixture-tool --version; fi\n',
        { mode: 0o755 }
      );
      await fs.writeFile(path.join(newerBin, "fixture-tool"), "#!/bin/sh\nprintf '26.0.0\\n'\n", {
        mode: 0o755,
      });
      const binding = {
        tool: "fixture-tool",
        executable,
        expectedRange: "24.0.0",
        evidencePath: "README.md",
      };
      profile = {
        ...profile,
        runtimeCandidates: { "fixture-tool": [executable] },
        documents: { "README.md": "fixture-tool requires 24.0.0" },
      };
      const prior = await store.create(
        options.projectId,
        await fs.realpath(workspace),
        profile.contextHash
      );
      prior.state = "passed";
      prior.data.runtimeBindings = [binding];
      await store.save(prior);
      await store.promote(prior, "Prior required checks passed with the compatible runtime");
      let nestedVersion = "";
      const result = await new LocalRecoveryController(store, {
        capture: async () => profile,
        runCommand: runRealCommand,
      }).run({
        ...options,
        toolchainProfile: {
          dependencyStrategy: "none",
          mergeQualityGateCommands: ["fixture-tool launch"],
        },
        validate: async (execute) => {
          const command = await execute(
            { command: "fixture-tool", args: ["launch"] },
            {
              cwd: workspace,
              env: { PATH: [newerBin, preferredBin, "/usr/bin", "/bin"].join(path.delimiter) },
            }
          );
          nestedVersion = command.stdout.trim();
          return nestedVersion === "24.0.0"
            ? null
            : { ...unknownFailure(), classificationReason: "required runtime assertion failed" };
        },
      });
      expect(nestedVersion).toBe("24.0.0");
      expect(result).toBeNull();
    }
  );

  it("accepts a declared tool whose name contains regular expression characters", async () => {
    const binding = {
      tool: "g++",
      executable: "/installed/g++",
      expectedRange: ">=14.0.0",
      evidencePath: "README.md",
    };
    const execution = vi.fn(async () => ({
      stdout: "g++ 14.1.0\n",
      stderr: "",
      executable: binding.executable,
      cwd: workspace,
      exitCode: 0,
      signal: null,
    }));
    expect(
      await verifyRuntimeBinding(
        binding,
        {
          ...profile,
          runtimeCandidates: { "g++": [binding.executable] },
          documents: { "README.md": "g++ requires >=14.0.0" },
        },
        execution
      )
    ).toBe(true);
  });
});
