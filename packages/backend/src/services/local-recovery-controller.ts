import { DEFAULT_REPAIR_LOOP_CONFIG } from "@opensprint/shared";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { runCommand, type CommandSpec } from "../utils/command-runner.js";
import { redactSecretsForUserDisplay } from "../utils/secret-redaction.js";
import {
  captureExecutionProfile,
  type ProjectExecutionProfile,
} from "./project-execution-profile.service.js";
import { resolveToolchainProfile } from "./toolchain-profile.service.js";
import {
  LocalRecoveryStore,
  type RecoveryIncident,
  type RecoveryRecipe,
} from "./local-recovery-store.js";
import type {
  MergeQualityGateFailure,
  MergeQualityGateRunOptions,
} from "./merge-quality-gate-runner.js";
import { verifyRuntimeBinding } from "./local-runtime-binding.js";

export type RecoveryCommandRunner = typeof runCommand;
export type RecoveryDiagnosis = RecoveryRecipe | "wait" | "escalate" | "code_failure";
export interface LocalRecoveryRequest extends MergeQualityGateRunOptions {
  requestId?: string;
  checkpoint?: Partial<import("./local-recovery-store.js").RecoveryCheckpoint>;
  validate: (runner: RecoveryCommandRunner) => Promise<MergeQualityGateFailure | null>;
  isCurrent?: () => Promise<boolean>;
  onWaiting?: (waiting: boolean) => void;
  diagnose?: (
    failure: MergeQualityGateFailure,
    profile: ProjectExecutionProfile,
    signal: AbortSignal
  ) => Promise<RecoveryDiagnosis>;
  expectedAuthorityHash?: string;
}
export interface LocalRecoveryDependencies {
  runCommand?: RecoveryCommandRunner;
  capture?: typeof captureExecutionProfile;
  wait?: (signal: AbortSignal, delayMs?: number) => Promise<void>;
  isAlive?: (pid: number, group?: boolean) => boolean;
  now?: () => number;
  maxIterations?: number;
  maxCommands?: number;
  maxWallTimeMs?: number;
  maxWaitMs?: number;
}
const ACTIVE = new Set(["validating", "diagnosing", "repairing", "waiting"]);

function alive(pid: number, group = false): boolean {
  try {
    process.kill(group && process.platform !== "win32" ? -pid : pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function wait(signal: AbortSignal, delayMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Local recovery cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** A local execution fault suspends the validation call, retaining its review join and task artifacts. */
export class LocalRecoveryController {
  private running = new Map<string, Promise<MergeQualityGateFailure | null>>();
  private cancellations = new Map<string, Set<AbortController>>();
  private completions = new Map<string, Set<Promise<MergeQualityGateFailure | null>>>();
  constructor(
    readonly store: LocalRecoveryStore,
    private readonly deps: LocalRecoveryDependencies = {}
  ) {}

  async cancelTask(projectId: string, taskId: string): Promise<void> {
    await this.store.cancelTask(projectId, taskId);
    this.cancellations.get(`${projectId}:${taskId}`)?.forEach((c) => c.abort());
    await Promise.all(
      [...(this.completions.get(`${projectId}:${taskId}`) ?? [])].map((p) => p.catch(() => {}))
    );
  }

  async run(request: LocalRecoveryRequest): Promise<MergeQualityGateFailure | null> {
    const requestId = request.requestId ?? randomUUID();
    const abort = new AbortController();
    const taskKey = `${request.projectId}:${request.taskId}`;
    const cancellations = this.cancellations.get(taskKey) ?? new Set<AbortController>();
    cancellations.add(abort);
    this.cancellations.set(taskKey, cancellations);
    await this.store.beginRequest(request.projectId, request.taskId, requestId);
    const key = `${request.projectId}:${await fs.realpath(request.worktreePath).catch(() => path.resolve(request.worktreePath))}`;
    const previous = this.running.get(key);
    if (previous) request.onWaiting?.(true);
    let started = false;
    const queued = (previous ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        request.onWaiting?.(false);
        if (
          abort.signal.aborted ||
          (await this.store.requestCancelled(request.projectId, request.taskId, requestId))
        )
          return this.failure(request, "Queued recovery was cancelled");
        started = true;
        return this.execute({ ...request, requestId }, abort);
      });
    // A cancelled waiter can finish immediately, while the serialization tail still
    // waits for its predecessor. A third request must not jump that predecessor.
    const promise = new Promise<MergeQualityGateFailure | null>((resolve, reject) => {
      const cancel = () => {
        if (!started) resolve(this.failure(request, "Queued recovery was cancelled"));
      };
      abort.signal.addEventListener("abort", cancel, { once: true });
      queued.then(resolve, reject).finally(() => abort.signal.removeEventListener("abort", cancel));
    });
    this.running.set(key, queued);
    void queued
      .finally(() => {
        if (this.running.get(key) === queued) this.running.delete(key);
      })
      .catch(() => {});
    const completions =
      this.completions.get(taskKey) ?? new Set<Promise<MergeQualityGateFailure | null>>();
    completions.add(promise);
    this.completions.set(taskKey, completions);
    try {
      return await promise;
    } finally {
      completions.delete(promise);
      if (!completions.size) this.completions.delete(taskKey);
      cancellations.delete(abort);
      if (!cancellations.size) this.cancellations.delete(taskKey);
    }
  }

  private async execute(
    request: LocalRecoveryRequest,
    abort: AbortController
  ): Promise<MergeQualityGateFailure | null> {
    const capture = this.deps.capture ?? captureExecutionProfile;
    const runner = this.deps.runCommand ?? runCommand;
    const now = this.deps.now ?? Date.now;
    const isAlive = this.deps.isAlive ?? alive;
    const pause = this.deps.wait ?? wait;
    const budget = {
      iterations: this.deps.maxIterations ?? DEFAULT_REPAIR_LOOP_CONFIG.maxIterations,
      commands: this.deps.maxCommands ?? DEFAULT_REPAIR_LOOP_CONFIG.maxCommands,
      wall: this.deps.maxWallTimeMs ?? DEFAULT_REPAIR_LOOP_CONFIG.maxWallTimeMs,
      wait: this.deps.maxWaitMs ?? 24 * 60 * 60_000,
    };
    const retainAdmissionFailure = async (reason: string, profile?: ProjectExecutionProfile) => {
      const workspace = await fs
        .realpath(request.worktreePath)
        .catch(() => path.resolve(request.worktreePath));
      const hash = profile?.contextHash ?? request.expectedAuthorityHash ?? "unavailable-profile";
      let retained = await this.store.create(request.projectId, workspace, hash);
      if (
        retained.owner !== this.store.owner ||
        retained.data.activeCommand ||
        retained.data.contextHash !== hash
      ) {
        retained = await this.store.create(
          request.projectId,
          `${workspace}#admission:${request.taskId}:${hash}`,
          hash
        );
      }
      if (await this.store.owns(retained)) {
        retained.state = "held";
        retained.data.history.push({
          at: new Date(now()).toISOString(),
          event: redactSecretsForUserDisplay(reason),
        });
        await this.store.save(retained);
      }
      await this.store.checkpoint(retained, request.taskId, {
        worktreePath: workspace,
        branchName: request.branchName,
        baseBranch: request.baseBranch,
        head: profile?.head ?? "",
        contextHash: hash,
        ...request.checkpoint,
      });
      return this.failure(request, reason, retained);
    };
    let profile: ProjectExecutionProfile;
    try {
      profile = await capture(request.worktreePath, request.toolchainProfile, request.baseBranch);
    } catch (err) {
      return retainAdmissionFailure(`Execution profile unavailable: ${String(err)}`);
    }
    if (request.expectedAuthorityHash && request.expectedAuthorityHash !== profile.authorityHash)
      return retainAdmissionFailure(
        "Required validation authority changed after assignment",
        profile
      );
    if (request.isCurrent && !(await request.isCurrent()))
      return this.failure(request, "Task stopped before recovery admission");
    const workspace = await fs.realpath(request.worktreePath);
    let run = await this.store.create(request.projectId, workspace, profile.contextHash);
    const resolved = resolveToolchainProfile(request.toolchainProfile);
    const checkpoint = {
      worktreePath: workspace,
      branchName: request.branchName,
      baseBranch: request.baseBranch,
      head: profile.head,
      contextHash: profile.contextHash,
      validationWorkspacePath: workspace,
      ...request.checkpoint,
    };

    const waitOnce = async () => {
      request.onWaiting?.(true);
      try {
        await pause(abort.signal);
      } finally {
        request.onWaiting?.(false);
      }
    };
    try {
      // Never steal a live owner's work. Expiry alone cannot prove that its commands ended.
      while (run.owner !== this.store.owner && ACTIVE.has(run.state)) {
        if (now() > run.data.startedAt + budget.wait)
          return this.failure(
            request,
            "Recovery owner wait deadline reached; retained without takeover",
            run
          );
        if (run.ownerHost !== this.store.host || isAlive(run.ownerPid)) {
          await waitOnce();
        } else if (
          run.data.activeCommand &&
          (!run.data.activeCommand.pid || isAlive(run.data.activeCommand.pid, true))
        ) {
          return this.failure(
            request,
            "Previous validation command ownership is uncertain; retained without relaunch",
            run
          );
        } else {
          const claimed = await this.store.claim(run);
          if (claimed) run = claimed;
        }
        run = (await this.store.get(request.projectId, workspace))!;
      }
      if (
        ["held", "cancelled"].includes(run.state) &&
        run.data.contextHash === profile.contextHash
      ) {
        return this.failure(
          request,
          "Local recovery is held or cancelled; its budget and work are retained",
          run
        );
      }
      if (!ACTIVE.has(run.state)) {
        if (
          run.data.activeCommand &&
          (!run.data.activeCommand.pid || isAlive(run.data.activeCommand.pid, true))
        )
          return this.failure(
            request,
            "Previous command has not been observed stopped; refusing relaunch",
            run
          );
        const claimed = await this.store.claim(run, true, profile.contextHash);
        if (!claimed)
          return this.failure(request, "Recovery ownership changed before validation", run);
        run = claimed;
      }
      if (run.data.contextHash !== profile.contextHash)
        return this.failure(request, "Execution inputs changed during retained recovery", run);
      if (run.data.head && run.data.head !== profile.head)
        return this.failure(
          request,
          "Retained code revision changed; refusing stale recovery",
          run
        );
      run.data.head = profile.head;
      run.data.recipeHash = profile.recipeHash;
      run.data.executionContract = {
        authorityHash: profile.authorityHash,
        workingDirectory: resolved.workingDirectory,
        commands: resolved.mergeQualityGateCommands,
        dependencyHealthCheckCommand: resolved.dependencyHealthCheckCommand,
        dependencyInstallCommand: resolved.dependencyInstallCommand,
        resourceProbeCommand: resolved.resourceProbeCommand,
        environmentHash: createHash("sha256")
          .update(JSON.stringify(resolved.executionEnvironment))
          .digest("hex"),
      };
      await this.store.save(run);
      await this.store.checkpoint(run, request.taskId, checkpoint);

      const current = async () => {
        if (
          abort.signal.aborted ||
          !(await this.store.owns(run)) ||
          (await this.store.requestCancelled(
            request.projectId,
            request.taskId,
            request.requestId ?? "default"
          )) ||
          (request.isCurrent && !(await request.isCurrent()))
        )
          throw new Error("Local recovery cancelled or replaced");
      };
      const unchanged = async () => {
        await current();
        const latest = await capture(workspace, request.toolchainProfile, request.baseBranch);
        if (latest.head !== profile.head || latest.contextHash !== profile.contextHash)
          throw new Error("Execution inputs changed; refusing a stale recovery result");
      };
      const journal = async (state: RecoveryIncident["state"], event: string) => {
        await current();
        run.state = state;
        run.data.history.push({ at: new Date(now()).toISOString(), event });
        run.data.history = run.data.history.slice(-40);
        await this.store.save(run);
      };
      const execute: RecoveryCommandRunner = async (spec, options) => {
        await current();
        if (run.data.recoveryStartedAt && run.state !== "waiting") {
          if (now() > (run.data.deadlineAt ?? 0) || run.data.commands >= budget.commands)
            throw new Error("Local recovery command/time budget exhausted");
          run.data.commands++;
        }
        run.data.activeCommand = {
          label: redactSecretsForUserDisplay([spec.command, ...(spec.args ?? [])].join(" ")),
        };
        await this.store.save(run);
        try {
          const binding = run.data.runtimeBindings?.find((b) => b.tool === spec.command);
          const prefixes = [
            ...new Set((run.data.runtimeBindings ?? []).map((b) => path.dirname(b.executable))),
          ];
          const effective = binding ? { ...spec, command: binding.executable } : spec;
          return await runner(effective, {
            ...options,
            ...(prefixes.length
              ? {
                  trustedPathPrefixes: prefixes,
                  env: {
                    ...options.env,
                    PATH: [...prefixes, options.env?.PATH ?? process.env.PATH ?? ""].join(
                      path.delimiter
                    ),
                  },
                }
              : {}),
            ...(run.data.recoveryStartedAt && run.state !== "waiting"
              ? {
                  timeout: Math.min(
                    options.timeout ?? budget.wall,
                    Math.max(1, (run.data.deadlineAt ?? 0) - now())
                  ),
                }
              : {}),
            signal: abort.signal,
            onSpawn: async (pid) => {
              await current();
              run.data.activeCommand!.pid = pid;
              await this.store.save(run);
            },
          });
        } finally {
          // runCommand observes close (including descendant cleanup) before settling.
          if (await this.store.owns(run)) {
            run.data.activeCommand = undefined;
            await this.store.save(run);
          } else {
            await this.store.observedCommandClosed(run);
          }
        }
      };
      const configured = async (command: string) => {
        const { parseCommandSpec } = await import("./merge-quality-gate-runner.js");
        const spec: CommandSpec = parseCommandSpec(command);
        return execute(spec, {
          cwd: profile.cwd,
          timeout: Math.min(
            budget.wall,
            Math.max(1, (run.data.deadlineAt ?? now() + budget.wall) - now())
          ),
          env: {
            NPM_CONFIG_INCLUDE: "dev",
            npm_config_include: "dev",
            NPM_CONFIG_OMIT: "",
            npm_config_omit: "",
            ...resolved.executionEnvironment,
            CI: "true",
          },
        });
      };
      const health = async () => {
        if (!resolved.dependencyHealthCheckCommand) return false;
        try {
          await configured(resolved.dependencyHealthCheckCommand);
          return true;
        } catch {
          return false;
        }
      };
      const waitForResource = async (
        failure: MergeQualityGateFailure
      ): Promise<MergeQualityGateFailure | null> => {
        if (run.state !== "waiting")
          run.data.remainingRepairMs = Math.max(
            0,
            (run.data.deadlineAt ?? now() + budget.wall) - now()
          );
        await journal("waiting", "resource_wait");
        const pid = /Waiting for validation in .+\(PID (\d+)\)/i.exec(failure.output)?.[1];
        if (!pid && !resolved.resourceProbeCommand) {
          await journal("held", "resource_probe_required");
          return this.failure(
            request,
            "Resource ownership is retained; configure an authorized readiness probe",
            run
          );
        }
        const waitUntil = (run.data.recoveryStartedAt ?? now()) + budget.wait;
        for (;;) {
          await current();
          if (now() > waitUntil || (run.data.waitProbes ?? 0) >= 2048) {
            await journal("held", "resource_wait_budget_exhausted");
            return this.failure(
              request,
              "Resource wait budget reached; completed work retained",
              run
            );
          }
          run.data.waitProbes = (run.data.waitProbes ?? 0) + 1;
          let ready = pid ? !isAlive(Number(pid)) : false;
          if (resolved.resourceProbeCommand) {
            const { parseCommandSpec } = await import("./merge-quality-gate-runner.js");
            try {
              await execute(parseCommandSpec(resolved.resourceProbeCommand), {
                cwd: profile.cwd,
                timeout: 10_000,
                env: resolved.executionEnvironment,
              });
              ready = true;
            } catch {
              ready = false;
            }
          }
          if (ready) break;
          await this.store.save(run);
          request.onWaiting?.(true);
          try {
            await pause(
              abort.signal,
              Math.min(60000, 3000 * 2 ** Math.min(5, run.data.waitProbes - 1))
            );
          } finally {
            request.onWaiting?.(false);
          }
        }
        run.data.deadlineAt = now() + (run.data.remainingRepairMs ?? budget.wall);
        if (run.data.attempts++ >= budget.iterations) {
          await journal("held", "retry_budget_exhausted");
          return this.failure(
            request,
            "Validation retries exhausted; completed work retained",
            run
          );
        }
        await journal("validating", "resource_ready");
        return null;
      };
      const learned = await this.store.executionProfile(
        request.projectId,
        profile.recipeHash ?? profile.contextHash
      );
      for (const binding of learned?.runtimeBindings ?? []) {
        if (await verifyRuntimeBinding(binding, profile, execute))
          run.data.runtimeBindings = [
            ...(run.data.runtimeBindings ?? []).filter((b) => b.tool !== binding.tool),
            binding,
          ];
      }
      if (run.state === "waiting" && run.data.failure) {
        const held = await waitForResource(run.data.failure);
        if (held) return held;
      }
      let failure: MergeQualityGateFailure | null;
      for (;;) {
        await unchanged();
        await journal("validating", "validation_started");
        failure = await request.validate(execute);
        await unchanged();
        if (!failure) {
          await journal("passed", "independent_validation_passed");
          await this.store.promote(
            run,
            `Required gates passed at ${profile.head}; authority ${profile.authorityHash}`
          );
          await current();
          return null;
        }
        run.data.failure = {
          ...failure,
          output: redactSecretsForUserDisplay(failure.output).slice(0, 4000),
        };
        run.data.failureKey = createHash("sha256")
          .update(
            JSON.stringify({
              command: failure.command,
              category: failure.category,
              reason: failure.classificationReason,
              firstError: failure.firstErrorLine ?? failure.reason,
            })
          )
          .digest("hex");
        // Explicit compiler/linter/source errors always retain the normal coding/review path.
        if (
          failure.category === "quality_gate" &&
          failure.classificationReason !== "no environment fingerprint detected"
        ) {
          await journal("failed", "code_failure");
          return failure;
        }
        if (!run.data.recoveryStartedAt) {
          run.data.recoveryStartedAt = now();
          run.data.deadlineAt = now() + budget.wall;
        }
        const contention = ["validation_resource_busy", "checkout_reserved"].includes(
          failure.classificationReason ?? ""
        );
        if (contention) {
          const held = await waitForResource(failure);
          if (held) return held;
          continue;
        }
        if (run.data.attempts >= budget.iterations || now() > (run.data.deadlineAt ?? 0)) {
          await journal("held", "repair_budget_exhausted");
          return this.failure(
            request,
            "Local recovery exhausted its bounded attempts; completed work retained",
            run
          );
        }
        let recipe = await this.store.recipe(
          request.projectId,
          profile.recipeHash ?? profile.contextHash,
          run.data.failureKey
        );
        const healthy = await health();
        if (recipe === "repair_dependencies" && healthy) recipe = undefined;
        if (!recipe && request.diagnose && run.data.diagnoses === 0) {
          run.data.diagnoses++;
          await journal("diagnosing", "diagnosis_requested");
          const diagnosis = await request
            .diagnose(
              failure,
              profile,
              AbortSignal.any([
                abort.signal,
                AbortSignal.timeout(
                  Math.max(1, Math.min(60000, (run.data.deadlineAt ?? now()) - now()))
                ),
              ])
            )
            .catch(() => "escalate" as const);
          await current();
          if (diagnosis === "code_failure" && failure.category === "quality_gate") {
            await journal("failed", "diagnosed_code_failure");
            return failure;
          }
          if (diagnosis === "wait" && resolved.resourceProbeCommand) {
            const held = await waitForResource(failure);
            if (held) return held;
            continue;
          }
          if (
            diagnosis === "repair_dependencies" ||
            diagnosis === "retry_validation" ||
            (typeof diagnosis === "object" && diagnosis.action === "bind_runtime")
          )
            recipe = diagnosis;
        }
        if (
          !recipe &&
          !healthy &&
          resolved.dependencyInstallCommand &&
          failure.category === "environment_setup"
        )
          recipe = "repair_dependencies";
        if (
          recipe === "repair_dependencies" &&
          (healthy || !resolved.dependencyHealthCheckCommand || !resolved.dependencyInstallCommand)
        )
          recipe = undefined;
        if (!recipe) {
          await journal("held", "no_authorized_repair");
          return this.failure(
            request,
            "No verified local repair is authorized; completed work retained",
            run
          );
        }
        await unchanged();
        run.data.attempts++;
        run.data.recipe = recipe;
        await journal("repairing", typeof recipe === "object" ? recipe.action : recipe);
        if (typeof recipe === "object") {
          if (!(await verifyRuntimeBinding(recipe.binding, profile, execute))) {
            await journal("held", "runtime_binding_not_verified");
            return this.failure(
              request,
              "Discovered runtime does not satisfy trusted project evidence",
              run
            );
          }
          run.data.runtimeBindings = [
            ...(run.data.runtimeBindings ?? []).filter((b) => b.tool !== recipe.binding.tool),
            recipe.binding,
          ];
        }
        if (recipe === "repair_dependencies") {
          if (
            healthy ||
            !resolved.dependencyHealthCheckCommand ||
            !resolved.dependencyInstallCommand
          ) {
            await journal("held", "dependency_repair_not_justified");
            return this.failure(
              request,
              "Dependency repair lacks a failing health probe or authorized installer",
              run
            );
          }
          // A host symlink is detached, never followed or repaired in the control checkout.
          const modules = path.join(profile.cwd, "node_modules");
          if (
            ["npm", "npm_ci_worktree", "pnpm", "yarn"].includes(resolved.dependencyStrategy) &&
            (await fs.lstat(modules).catch(() => null))?.isSymbolicLink()
          )
            await fs.unlink(modules);
          await current();
          await configured(resolved.dependencyInstallCommand);
          if (!(await health())) {
            await journal("held", "repair_health_failed");
            return this.failure(
              request,
              "Dependency repair failed its independent health probe",
              run
            );
          }
        }
        // The agent/recipe cannot declare success. The loop reruns the same required gates.
      }
    } catch (err) {
      if (await this.store.owns(run)) {
        run.state = "held";
        run.data.history.push({
          at: new Date(now()).toISOString(),
          event: redactSecretsForUserDisplay(String(err)).slice(0, 500),
        });
        await this.store.save(run);
      }
      return this.failure(request, String(err), run);
    } finally {
      request.onWaiting?.(false);
    }
  }

  private failure(
    request: MergeQualityGateRunOptions,
    reason: string,
    run?: RecoveryIncident
  ): MergeQualityGateFailure {
    return {
      ...run?.data.failure,
      command: run?.data.failure?.command ?? "local_recovery",
      reason: redactSecretsForUserDisplay(reason),
      output: run?.data.failure?.output ?? "",
      category: "environment_setup",
      worktreePath: request.worktreePath,
      preserveWork: true,
      recoveryIncidentId: run?.id,
      classificationReason: "local_recovery_held",
      classificationConfidence: "high",
    };
  }
}
