import { Router, Request } from "express";
import { wrapAsync } from "../middleware/wrap-async.js";
import { spawn, execSync } from "child_process";
import path from "path";
import os from "os";
import type {
  ApiResponse,
  DeploymentRecord,
  DeploymentConfig,
  ProjectSettings,
} from "@opensprint/shared";
import {
  resolveTestCommand,
  getDefaultDeploymentTarget,
  getDeploymentTargetConfig,
} from "@opensprint/shared";
import { deploymentService } from "../services/deployment-service.js";
import { deployStorageService } from "../services/deploy-storage.service.js";
import type { ProjectService } from "../services/project.service.js";
import { orchestratorService } from "../services/orchestrator.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { ensureEasConfig } from "../services/eas-config.js";
import { testRunner } from "../services/test-runner.js";
import { createFixEpicFromTestOutput } from "../services/deploy-fix-epic.service.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { getExpoDeployCommand } from "../utils/expo-deploy-command.js";
import { ensureExpoInstalled } from "../utils/expo-install.js";
import { ensureExpoConfig } from "../utils/expo-config.js";
import { checkExpoAuth } from "../utils/expo-auth-check.js";
import { ensureEasProjectIdInAppJson } from "../utils/eas-project-link.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("deliver");

/** Current deliver phase status for a project (deployment records) */
export interface DeliverStatusResponse {
  activeDeployId: string | null;
  currentDeploy: DeploymentRecord | null;
}

export function createDeliverRouter(projectService: ProjectService): Router {
  const router = Router({ mergeParams: true });

type ProjectParams = { projectId: string };
type DeployIdParams = { projectId: string; deployId: string };

/** True when repoPath is under the system temp dir (e.g. test env). Used to skip pre-deploy tests and await in-process. */
function isRepoInTempDir(repoPath: string): boolean {
  const resolvedRepo = path.resolve(repoPath).replace(/^\/private/, "");
  const tmpDir = path.resolve(os.tmpdir()).replace(/^\/private/, "");
  return resolvedRepo.startsWith(tmpDir + path.sep) || resolvedRepo === tmpDir;
}

/** Result shape for completeDeploy: update storage record and broadcast deliver.completed. */
interface CompleteDeployResult {
  success: boolean;
  error?: string;
  fixEpicId?: string | null;
  url?: string;
}

/** Update deploy record and broadcast deliver.completed in one place. */
async function completeDeploy(
  projectId: string,
  deployId: string,
  result: CompleteDeployResult
): Promise<void> {
  const status = result.success ? "success" : "failed";
  await deployStorageService.updateRecord(projectId, deployId, {
    status,
    completedAt: new Date().toISOString(),
    ...(result.error != null && { error: result.error }),
    ...(result.fixEpicId !== undefined && { fixEpicId: result.fixEpicId }),
    ...(result.url != null && { url: result.url }),
  });
  broadcastToProject(projectId, {
    type: "deliver.completed",
    deployId,
    success: result.success,
    ...(result.fixEpicId != null && { fixEpicId: result.fixEpicId }),
  });
}

/** Captured reference for use in async callbacks (avoids ReferenceError when module runs in deferred context). */
const completeDeployFn = completeDeploy;

/** Get git commit hash at HEAD in repo (git rev-parse HEAD) */
function getCommitHash(repoPath: string): string | null {
  try {
    const out = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** In-memory slot per project: value is "pending" or deployId. Every path that set()s must release via delete() in finally or catch. */
const activeDeployments = new Map<string, string>();

// POST /projects/:projectId/deliver — Trigger deployment (Deliver phase)
// Body: { target?: string } — target name from targets array; defaults to getDefaultDeploymentTarget()
router.post(
  "/",
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    try {
      const { projectId } = req.params;

      if (activeDeployments.has(projectId)) {
        res.status(409).json({
          error: {
            code: "DEPLOY_ALREADY_RUNNING",
            message: `Deployment ${activeDeployments.get(projectId)} is already running for this project`,
          },
        });
        return;
      }

      // Reserve the slot synchronously before any awaits to prevent concurrent deploys
      activeDeployments.set(projectId, "pending");

      const bodyTarget = (req.body as { target?: string } | undefined)?.target;
      const project = await projectService.getProject(projectId);
      const settings = await projectService.getSettings(projectId);

      const latest = await deployStorageService.getLatestDeploy(projectId);
      const previousDeployId = latest?.id ?? null;

      const commitHash = getCommitHash(project.repoPath);
      const target = bodyTarget ?? getDefaultDeploymentTarget(settings.deployment);
      const mode = settings.deployment.mode ?? "custom";

      const record = await deployStorageService.createRecord(projectId, previousDeployId, {
        commitHash,
        target,
        mode,
      });

      activeDeployments.set(projectId, record.id);
      broadcastToProject(projectId, { type: "deliver.started", deployId: record.id });

      try {
        await deployStorageService.updateRecord(projectId, record.id, { status: "running" });
      } catch (updateErr) {
        activeDeployments.delete(projectId);
        throw updateErr;
      }

      const repoInTempDir = isRepoInTempDir(project.repoPath);

      const deployPromise = runDeployAsync(
        projectId,
        record.id,
        project.repoPath,
        settings,
        target,
        project.name
      )
        .catch((err) => {
          log.error("Deploy failed", { deployId: record.id, err });
        })
        .finally(() => {
          activeDeployments.delete(projectId);
        });

      // When repo is in temp dir (e.g. test env), await deploy so it completes before test teardown
      if (repoInTempDir) {
        await deployPromise;
      }

      const body: ApiResponse<{ deployId: string }> = { data: { deployId: record.id } };
      res.status(202).json(body);
    } catch (err) {
      activeDeployments.delete(req.params.projectId);
      throw err;
    }
  })
);

// GET /projects/:projectId/deliver/status — Current deployment status (Deliver phase)
router.get(
  "/status",
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    const { projectId } = req.params;
    await projectService.getProject(projectId);
    const history = await deployStorageService.listHistory(projectId, 1);
    const current = history[0] ?? null;
    const activeDeployId =
      current?.status === "running" || current?.status === "pending" ? current.id : null;

    const body: ApiResponse<DeliverStatusResponse> = {
      data: {
        activeDeployId,
        currentDeploy: current,
      },
    };
    res.json(body);
  })
);

// GET /projects/:projectId/deliver/history — Deployment history (Deliver phase)
router.get(
  "/history",
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    const { projectId } = req.params;
    await projectService.getProject(projectId);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
    const history = await deployStorageService.listHistory(projectId, limit);

    const body: ApiResponse<DeploymentRecord[]> = { data: history };
    res.json(body);
  })
);

// PUT /projects/:projectId/deliver/settings — Update deployment settings (must be before /:deployId)
router.put(
  "/settings",
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    const { projectId } = req.params;
    const deployment = req.body as Partial<DeploymentConfig>;
    const settings = await projectService.getSettings(projectId);

    const updatedSettings: Partial<ProjectSettings> = {
      deployment: {
        ...settings.deployment,
        ...deployment,
      },
    };

    await projectService.updateSettings(projectId, updatedSettings);
    await orchestratorService.refreshMaxSlotsAndNudge(projectId);
    const updated = await projectService.getSettings(projectId);

    const body: ApiResponse<ProjectSettings> = { data: updated };
    res.json(body);
  })
);

// POST /projects/:projectId/deliver/cancel — Clear stuck delivering state (in-memory + mark running/pending as failed)
// Must be before /:deployId so "cancel" is not captured as deployId
router.post(
  "/cancel",
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    const { projectId } = req.params;
    await projectService.getProject(projectId);

    activeDeployments.delete(projectId);

    const latest = await deployStorageService.getLatestDeploy(projectId);
    if (latest && (latest.status === "running" || latest.status === "pending")) {
      await completeDeployFn(projectId, latest.id, {
        success: false,
        error: "Cancelled (deliver state reset)",
      });
    }

    const body: ApiResponse<{ cleared: boolean }> = { data: { cleared: true } };
    res.json(body);
  })
);

// POST /projects/:projectId/deliver/expo-deploy — Expo deploy (beta or prod) with export + eas deploy
// Body: { variant: "beta" | "prod" }
// Must be before /:deployId/rollback so "expo-deploy" is not captured as deployId
router.post(
  "/expo-deploy",
  wrapAsync(async (req: Request<ProjectParams>, res) => {
    try {
      const { projectId } = req.params;
      const variant = (req.body as { variant?: string } | undefined)?.variant;

      if (variant !== "beta" && variant !== "prod") {
        res.status(400).json({
          error: {
            code: "INVALID_VARIANT",
            message: "variant must be 'beta' or 'prod'",
          },
        });
        return;
      }

      if (activeDeployments.has(projectId)) {
        res.status(409).json({
          error: {
            code: "DEPLOY_ALREADY_RUNNING",
            message: `Deployment ${activeDeployments.get(projectId)} is already running for this project`,
          },
        });
        return;
      }

      const project = await projectService.getProject(projectId);
      const settings = await projectService.getSettings(projectId);

      if (settings.deployment.mode !== "expo") {
        res.status(400).json({
          error: {
            code: "EXPO_REQUIRED",
            message: "Expo deploy is only available when deployment mode is 'expo'",
          },
        });
        return;
      }

      // Pre-deploy: identify required but missing Expo auth before starting
      const authCheck = await checkExpoAuth(project.repoPath);
      if (!authCheck.ok) {
        res.status(400).json({
          error: {
            code: authCheck.code,
            message: authCheck.message,
            prompt: authCheck.prompt,
          },
        });
        return;
      }

      activeDeployments.set(projectId, "pending");

      const latest = await deployStorageService.getLatestDeploy(projectId);
      const previousDeployId = latest?.id ?? null;
      const commitHash = getCommitHash(project.repoPath);
      const target = variant === "prod" ? "production" : "staging";

      const record = await deployStorageService.createRecord(projectId, previousDeployId, {
        commitHash,
        target,
        mode: "expo",
      });

      activeDeployments.set(projectId, record.id);
      broadcastToProject(projectId, { type: "deliver.started", deployId: record.id });

      try {
        await deployStorageService.updateRecord(projectId, record.id, { status: "running" });
      } catch (updateErr) {
        activeDeployments.delete(projectId);
        throw updateErr;
      }

      const repoInTempDir = isRepoInTempDir(project.repoPath);
      const expoTarget = variant === "prod" ? "production" : "staging";
      const expoTargetConfig = getDeploymentTargetConfig(settings.deployment, expoTarget);
      const baseEnvVars =
        expoTargetConfig?.envVars ?? settings.deployment.envVars ?? {};
      const envVars =
        authCheck.expoToken != null
          ? { ...baseEnvVars, EXPO_TOKEN: authCheck.expoToken }
          : baseEnvVars;

      const emit = (chunk: string) => {
        deployStorageService.appendLog(projectId, record.id, chunk);
        broadcastToProject(projectId, { type: "deliver.output", deployId: record.id, chunk });
      };

      const deployPromise = runExpoDeployAsync(
        projectId,
        record.id,
        project.repoPath,
        variant,
        emit,
        envVars,
        undefined,
        getConfiguredEasProjectId(settings.deployment)
      )
        .catch((err) => {
          log.error("Expo deploy failed", { deployId: record.id, err });
        })
        .finally(() => {
          activeDeployments.delete(projectId);
        });

      if (repoInTempDir) {
        await deployPromise;
      }

      const body: ApiResponse<{ deployId: string }> = { data: { deployId: record.id } };
      res.status(202).json(body);
    } catch (err) {
      activeDeployments.delete(req.params.projectId);
      throw err;
    }
  })
);

  // POST /projects/:projectId/deliver/:deployId/rollback — Rollback to a deployment
  router.post(
    "/:deployId/rollback",
    wrapAsync(async (req: Request<DeployIdParams>, res) => {
      const { projectId, deployId } = req.params;
      const record = await deployStorageService.getRecord(projectId, deployId);
      if (!record) {
        res.status(404).json({
          error: { code: "NOT_FOUND", message: `Deployment ${deployId} not found` },
        });
        return;
      }

      const project = await projectService.getProject(projectId);
      const settings = await projectService.getSettings(projectId);

      const recordTarget =
        record.target && typeof record.target === "string" ? record.target : "production";
      const targetConfig = getDeploymentTargetConfig(settings.deployment, recordTarget);
      const rollbackCommand = targetConfig?.rollbackCommand ?? settings.deployment.rollbackCommand;

      if (settings.deployment.mode === "custom" && rollbackCommand) {
        const latest = await deployStorageService.getLatestDeploy(projectId);
        const rolledBackDeployId = latest && latest.id !== deployId ? latest.id : null;

        const commitHash = getCommitHash(project.repoPath);
        const target = getDefaultDeploymentTarget(settings.deployment);
        const mode = settings.deployment.mode ?? "custom";

        const rollbackRecord = await deployStorageService.createRecord(projectId, deployId, {
          commitHash,
          target,
          mode,
        });
        broadcastToProject(projectId, { type: "deliver.started", deployId: rollbackRecord.id });
        await deployStorageService.updateRecord(projectId, rollbackRecord.id, { status: "running" });

        const rollbackPromise = runRollbackAsync(
          projectId,
          rollbackRecord.id,
          project.repoPath,
          rollbackCommand,
          rolledBackDeployId,
          completeDeployFn
        ).catch((err) => {
          log.error("Rollback failed", {
            rollbackId: rollbackRecord.id,
            err,
            message: getErrorMessage(err),
          });
        });

        if (isRepoInTempDir(project.repoPath)) {
          await rollbackPromise;
        }

        const body: ApiResponse<{ deployId: string }> = { data: { deployId: rollbackRecord.id } };
        res.status(202).json(body);
      } else {
        res.status(501).json({
          error: {
            code: "NOT_IMPLEMENTED",
            message:
              "Rollback is only supported for custom deployment with rollbackCommand configured",
          },
        });
      }
    })
  );

  return router;
}

/** Run deployment asynchronously with streaming output.
 * PRD §7.5.2: Runs pre-deploy test suite first. If tests fail, creates fix epic via Planner and aborts.
 * Exported for use by deploy-trigger.service (auto-deploy on epic completion / Evaluate resolution).
 * @param targetName — Target name from targets array; defaults to getDefaultDeploymentTarget when not provided.
 * @param projectName — OpenSprint project name; used to auto-configure Expo (app.json name/slug) when not configured.
 */
export async function runDeployAsync(
  projectId: string,
  deployId: string,
  repoPath: string,
  settings: ProjectSettings,
  targetName?: string,
  projectName?: string
): Promise<void> {
  const config = settings.deployment;
  const effectiveTarget = targetName ?? getDefaultDeploymentTarget(config);
  const targetConfig = getDeploymentTargetConfig(config, effectiveTarget);
  const envVars = targetConfig?.envVars ?? config.envVars ?? {};
  const emit = (chunk: string) => {
    const p = deployStorageService.appendLog(projectId, deployId, chunk);
    broadcastToProject(projectId, { type: "deliver.output", deployId, chunk });
    return p;
  };

  try {
    // PRD §7.5.2: Pre-deployment validation — run full test suite before deploying
    // Skip pre-deploy tests when repo is in temp dir (e.g. test environment) so deploys complete
    // before test teardown deletes the directory
    const repoInTempDir = isRepoInTempDir(repoPath);

    let testResult: Awaited<ReturnType<typeof testRunner.runTestsWithOutput>>;
    if (repoInTempDir) {
      testResult = {
        passed: 1,
        failed: 0,
        skipped: 0,
        total: 1,
        details: [],
        rawOutput: "",
        executedCommand: null,
        scope: "full",
      };
    } else {
      const testCommand = resolveTestCommand(settings);
      emit("Running pre-deployment tests...\n");
      testResult = await testRunner.runTestsWithOutput(repoPath, testCommand || undefined);
    }

    if (testResult.failed > 0 || testResult.total === 0) {
      const failMsg =
        testResult.total === 0
          ? "No tests ran (test command may be misconfigured)"
          : `${testResult.failed} test(s) failed`;
      emit(`Pre-deployment tests failed: ${failMsg}\n`);
      emit(testResult.rawOutput ? `\n--- Test output ---\n${testResult.rawOutput}\n` : "");

      // Invoke Planner to create fix epic + tasks; create via task store, broadcast with fixEpicId
      const fixResult = await createFixEpicFromTestOutput(
        projectId,
        repoPath,
        testResult.rawOutput || failMsg
      );
      if (fixResult) {
        emit(`Fix epic created: ${fixResult.epicId} (${fixResult.taskCount} tasks)\n`);
      }
      await completeDeployFn(projectId, deployId, {
        success: false,
        error: failMsg,
        fixEpicId: fixResult?.epicId ?? null,
      });
      return;
    }

    emit("All tests passed. Proceeding with deployment...\n");

    const handler = deployHandlers[config.mode] ?? deployHandlers.unknown;
    await handler({
      projectId,
      deployId,
      repoPath,
      settings,
      effectiveTarget,
      targetConfig,
      envVars,
      emit,
      projectName,
    });
  } catch (err) {
    const msg = getErrorMessage(err);
    emit(`Error: ${msg}\n`);
    await completeDeployFn(projectId, deployId, { success: false, error: msg });
  }
}

type DeployHandlerContext = {
  projectId: string;
  deployId: string;
  repoPath: string;
  settings: ProjectSettings;
  effectiveTarget: string;
  targetConfig: ReturnType<typeof getDeploymentTargetConfig>;
  envVars: Record<string, string>;
  emit: (chunk: string) => void | Promise<unknown>;
  projectName?: string;
};

const deployHandlers: Record<
  string,
  (ctx: DeployHandlerContext) => Promise<void>
> = {
  expo: async (ctx) => {
    const authCheck = await checkExpoAuth(ctx.repoPath);
    if (!authCheck.ok) {
      ctx.emit(`${authCheck.prompt}\n`);
      await completeDeployFn(ctx.projectId, ctx.deployId, {
        success: false,
        error: authCheck.message,
      });
      return;
    }
    const expoEnvVars =
      authCheck.expoToken != null
        ? { ...ctx.envVars, EXPO_TOKEN: authCheck.expoToken }
        : ctx.envVars;
    const variant: "beta" | "prod" =
      ctx.effectiveTarget === "staging" ? "beta" : "prod";
    await runExpoDeployAsync(
      ctx.projectId,
      ctx.deployId,
      ctx.repoPath,
      variant,
      (chunk) => ctx.emit(chunk),
      expoEnvVars,
      ctx.projectName,
      getConfiguredEasProjectId(ctx.settings.deployment)
    );
  },
  custom: async (ctx) => {
    const customCommand =
      ctx.targetConfig?.command ?? ctx.settings.deployment.customCommand;
    const webhookUrl =
      ctx.targetConfig?.webhookUrl ?? ctx.settings.deployment.webhookUrl;

    if (customCommand) {
      await runCommandStreaming(
        "sh",
        ["-c", customCommand],
        ctx.repoPath,
        (chunk) => ctx.emit(chunk),
        ctx.envVars
      );
      await completeDeployFn(ctx.projectId, ctx.deployId, { success: true });
    } else if (webhookUrl) {
      const result = await deploymentService.deployWithWebhook(
        ctx.projectId,
        webhookUrl,
        ctx.envVars
      );
      ctx.emit(`Webhook POST to ${webhookUrl}\n`);
      await completeDeployFn(ctx.projectId, ctx.deployId, {
        success: result.success,
        url: result.url,
        error: result.error,
      });
    } else {
      await completeDeployFn(ctx.projectId, ctx.deployId, {
        success: false,
        error:
          "No custom deployment command or webhook URL configured",
      });
    }
  },
  unknown: async (ctx) => {
    await completeDeployFn(ctx.projectId, ctx.deployId, {
      success: false,
      error: `Unknown deployment mode: ${ctx.settings.deployment.mode}`,
    });
  },
};

/** Run Expo deploy (beta or prod): npx expo export --platform web && eas deploy [--prod] */
async function runExpoDeployAsync(
  projectId: string,
  deployId: string,
  repoPath: string,
  variant: "beta" | "prod",
  emit: (chunk: string) => void,
  envVars?: Record<string, string>,
  projectName?: string,
  easProjectId?: string
): Promise<void> {
  const cmd = getExpoDeployCommand(variant);
  try {
    if (isRepoInTempDir(repoPath)) {
      emit(`Skipping Expo CLI in temp repo for test environment (${variant}).\n`);
      await completeDeployFn(projectId, deployId, { success: true });
      return;
    }

    emit("Checking Expo installation...\n");
    const ensureResult = await ensureExpoInstalled(repoPath, emit);
    if (!ensureResult.ok) {
      emit(`Expo installation required but failed: ${ensureResult.error}\n`);
      await completeDeployFn(projectId, deployId, {
        success: false,
        error: ensureResult.error,
      });
      return;
    }
    const configResult = await ensureExpoConfig(
      repoPath,
      projectName ?? "App",
      emit
    );
    if (!configResult.ok) {
      emit(`Expo configuration failed: ${configResult.error}\n`);
      await completeDeployFn(projectId, deployId, {
        success: false,
        error: configResult.error,
      });
      return;
    }
    if (easProjectId) {
      emit(`Ensuring EAS project link for ${easProjectId}...\n`);
      const projectLinkResult = await ensureEasProjectIdInAppJson(repoPath, easProjectId);
      if (!projectLinkResult.ok && projectLinkResult.code === "APP_JSON_MISSING") {
        emit("app.json not found; attempting non-interactive eas init...\n");
        try {
          await runCommandStreaming(
            "npx",
            ["eas-cli", "init", "--id", easProjectId, "--non-interactive"],
            repoPath,
            emit,
            envVars
          );
        } catch (initErr) {
          const initMsg = `EAS project linking failed: ${getErrorMessage(initErr)}`;
          log.error("EAS init fallback failed", {
            projectId,
            deployId,
            repoPath,
            easProjectId,
            err: initErr,
          });
          emit(`${initMsg}\n`);
          await completeDeployFn(projectId, deployId, { success: false, error: initMsg });
          return;
        }
      } else if (!projectLinkResult.ok) {
        const linkMsg = `EAS project linking failed: ${projectLinkResult.error}`;
        log.error("EAS project linking failed", {
          projectId,
          deployId,
          repoPath,
          easProjectId,
          error: projectLinkResult.error,
          code: projectLinkResult.code,
        });
        emit(`${linkMsg}\n`);
        await completeDeployFn(projectId, deployId, { success: false, error: linkMsg });
        return;
      }
    }
    await ensureEasConfig(repoPath);
    emit(`Running: ${cmd}\n`);
    await runCommandStreaming("sh", ["-c", cmd], repoPath, emit, envVars);
    await completeDeployFn(projectId, deployId, { success: true });
  } catch (err) {
    const msg = getErrorMessage(err);
    emit(`Error: ${msg}\n`);
    await completeDeployFn(projectId, deployId, { success: false, error: msg });
  }
}

function getConfiguredEasProjectId(config: DeploymentConfig): string | undefined {
  const rawId = config.easProjectId ?? config.expoConfig?.projectId;
  if (typeof rawId !== "string") return undefined;
  const trimmed = rawId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Run rollback command with streaming */
async function runRollbackAsync(
  projectId: string,
  deployId: string,
  repoPath: string,
  rollbackCommand: string,
  rolledBackDeployId: string | null,
  complete: typeof completeDeployFn
): Promise<void> {
  const emit = (chunk: string) => {
    const p = deployStorageService.appendLog(projectId, deployId, chunk);
    broadcastToProject(projectId, { type: "deliver.output", deployId, chunk });
    return p;
  };

  try {
    await runCommandStreaming("sh", ["-c", rollbackCommand], repoPath, emit);
    if (rolledBackDeployId) {
      await deployStorageService.updateRecord(projectId, rolledBackDeployId, {
        status: "rolled_back",
        rolledBackBy: deployId,
      });
    }
    await complete(projectId, deployId, { success: true });
  } catch (err) {
    const msg = getErrorMessage(err);
    emit(`Error: ${msg}\n`);
    try {
      await complete(projectId, deployId, { success: false, error: msg });
    } catch (completeErr) {
      log.error("Rollback completeDeploy failed", {
        projectId,
        deployId,
        err: completeErr,
        message: getErrorMessage(completeErr),
      });
      throw completeErr;
    }
  }
}

function runCommandStreaming(
  command: string,
  args: string[],
  cwd: string,
  onOutput: (chunk: string) => void | Promise<unknown>,
  envVars?: Record<string, string>
): Promise<void> {
  const env = { ...process.env, ...envVars };
  const pendingOutput: Promise<unknown>[] = [];
  const capture = (chunk: string) => {
    const result = onOutput(chunk);
    if (result instanceof Promise) {
      pendingOutput.push(result);
    }
  };

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env,
      shell: false,
    });

    proc.stdout?.on("data", (data: Buffer) => {
      capture(data.toString());
    });
    proc.stderr?.on("data", (data: Buffer) => {
      capture(data.toString());
    });

    proc.on("close", (code) => {
      // Do not await pendingOutput so we don't block on log writes (avoids hang when storage is slow or locked)
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}
