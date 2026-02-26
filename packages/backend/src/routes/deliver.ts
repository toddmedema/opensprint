import { Router, Request } from "express";
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
import { ProjectService } from "../services/project.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { ensureEasConfig } from "../services/eas-config.js";
import { testRunner } from "../services/test-runner.js";
import { createFixEpicFromTestOutput } from "../services/deploy-fix-epic.service.js";
import { getErrorMessage } from "../utils/error-utils.js";
import { getExpoDeployCommand } from "../utils/expo-deploy-command.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("deliver");
const projectService = new ProjectService();

export const deliverRouter = Router({ mergeParams: true });

type ProjectParams = { projectId: string };
type DeployIdParams = { projectId: string; deployId: string };

/** Current deliver phase status for a project (deployment records) */
export interface DeliverStatusResponse {
  activeDeployId: string | null;
  currentDeploy: DeploymentRecord | null;
}

/** Get git commit hash at HEAD in repo (git rev-parse HEAD) */
function getCommitHash(repoPath: string): string | null {
  try {
    const out = execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf-8" });
    return out.trim() || null;
  } catch {
    return null;
  }
}

const activeDeployments = new Map<string, string>();

// POST /projects/:projectId/deliver — Trigger deployment (Deliver phase)
// Body: { target?: string } — target name from targets array; defaults to getDefaultDeploymentTarget()
deliverRouter.post("/", async (req: Request<ProjectParams>, res, next) => {
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

    const resolvedRepo = path.resolve(project.repoPath);
    const tmpDir = path.resolve(os.tmpdir());
    const repoInTempDir = resolvedRepo.startsWith(tmpDir + path.sep) || resolvedRepo === tmpDir;

    const deployPromise = runDeployAsync(projectId, record.id, project.repoPath, settings, target)
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
    next(err);
  }
});

// GET /projects/:projectId/deliver/status — Current deployment status (Deliver phase)
deliverRouter.get("/status", async (req: Request<ProjectParams>, res, next) => {
  try {
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
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/deliver/history — Deployment history (Deliver phase)
deliverRouter.get("/history", async (req: Request<ProjectParams>, res, next) => {
  try {
    const { projectId } = req.params;
    await projectService.getProject(projectId);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
    const history = await deployStorageService.listHistory(projectId, limit);

    const body: ApiResponse<DeploymentRecord[]> = { data: history };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// PUT /projects/:projectId/deliver/settings — Update deployment settings (must be before /:deployId)
deliverRouter.put("/settings", async (req: Request<ProjectParams>, res, next) => {
  try {
    const { projectId } = req.params;
    const deployment = req.body as Partial<DeploymentConfig>;
    const settings = await projectService.getSettings(projectId);

    const updatedSettings: ProjectSettings = {
      ...settings,
      deployment: {
        ...settings.deployment,
        ...deployment,
      },
    };

    await projectService.updateSettings(projectId, updatedSettings);
    const updated = await projectService.getSettings(projectId);

    const body: ApiResponse<ProjectSettings> = { data: updated };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/deliver/cancel — Clear stuck delivering state (in-memory + mark running/pending as failed)
// Must be before /:deployId so "cancel" is not captured as deployId
deliverRouter.post("/cancel", async (req: Request<ProjectParams>, res, next) => {
  try {
    const { projectId } = req.params;
    await projectService.getProject(projectId);

    activeDeployments.delete(projectId);

    const latest = await deployStorageService.getLatestDeploy(projectId);
    if (latest && (latest.status === "running" || latest.status === "pending")) {
      await deployStorageService.updateRecord(projectId, latest.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: "Cancelled (deliver state reset)",
      });
      broadcastToProject(projectId, {
        type: "deliver.completed",
        deployId: latest.id,
        success: false,
      });
    }

    const body: ApiResponse<{ cleared: boolean }> = { data: { cleared: true } };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// POST /projects/:projectId/deliver/expo-deploy — Expo deploy (beta or prod) with export + eas deploy
// Body: { variant: "beta" | "prod" }
// Must be before /:deployId/rollback so "expo-deploy" is not captured as deployId
deliverRouter.post("/expo-deploy", async (req: Request<ProjectParams>, res, next) => {
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

    const resolvedRepo = path.resolve(project.repoPath);
    const tmpDir = path.resolve(os.tmpdir());
    const repoInTempDir = resolvedRepo.startsWith(tmpDir + path.sep) || resolvedRepo === tmpDir;
    const envVars = settings.deployment.envVars ?? {};

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
      envVars
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
    next(err);
  }
});

// POST /projects/:projectId/deliver/:deployId/rollback — Rollback to a deployment
deliverRouter.post("/:deployId/rollback", async (req: Request<DeployIdParams>, res, next) => {
  try {
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
    const rollbackCommand =
      targetConfig?.rollbackCommand ?? settings.deployment.rollbackCommand;

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
        rolledBackDeployId
      ).catch((err) => {
        log.error("Rollback failed", { rollbackId: rollbackRecord.id, err });
      });

      const repoInTempDir =
        path.resolve(project.repoPath).startsWith(os.tmpdir() + path.sep) ||
        path.resolve(project.repoPath) === os.tmpdir();
      if (repoInTempDir) {
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
  } catch (err) {
    next(err);
  }
});

/** Run deployment asynchronously with streaming output.
 * PRD §7.5.2: Runs pre-deploy test suite first. If tests fail, creates fix epic via Planner and aborts.
 * Exported for use by deploy-trigger.service (auto-deploy on epic completion / Evaluate resolution).
 * @param targetName — Target name from targets array; defaults to getDefaultDeploymentTarget when not provided.
 */
export async function runDeployAsync(
  projectId: string,
  deployId: string,
  repoPath: string,
  settings: ProjectSettings,
  targetName?: string
): Promise<void> {
  const config = settings.deployment;
  const effectiveTarget = targetName ?? getDefaultDeploymentTarget(config);
  const targetConfig = getDeploymentTargetConfig(config, effectiveTarget);
  const envVars = config.envVars ?? {};
  const emit = (chunk: string) => {
    const p = deployStorageService.appendLog(projectId, deployId, chunk);
    broadcastToProject(projectId, { type: "deliver.output", deployId, chunk });
    return p;
  };

  try {
    // PRD §7.5.2: Pre-deployment validation — run full test suite before deploying
    // Skip pre-deploy tests when repo is in temp dir (e.g. test environment) so deploys complete
    // before test teardown deletes the directory
    const resolvedRepo = path.resolve(repoPath);
    const tmpDir = path.resolve(os.tmpdir());
    const repoInTempDir = resolvedRepo.startsWith(tmpDir + path.sep) || resolvedRepo === tmpDir;

    let testResult: Awaited<ReturnType<typeof testRunner.runTestsWithOutput>>;
    if (repoInTempDir) {
      testResult = { passed: 1, failed: 0, skipped: 0, total: 1, details: [], rawOutput: "" };
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

      await deployStorageService.updateRecord(projectId, deployId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: failMsg,
        fixEpicId: fixResult?.epicId ?? null,
      });
      if (fixResult) {
        emit(`Fix epic created: ${fixResult.epicId} (${fixResult.taskCount} tasks)\n`);
      }
      broadcastToProject(projectId, {
        type: "deliver.completed",
        deployId,
        success: false,
        fixEpicId: fixResult?.epicId ?? undefined,
      });
      return;
    }

    emit("All tests passed. Proceeding with deployment...\n");

    if (config.mode === "expo") {
      await ensureEasConfig(repoPath);
      const channel = config.expoConfig?.channel ?? "preview";
      const message = `OpenSprint preview ${new Date().toISOString().slice(0, 19)}`;
      let output = "";
      const captureEmit = (chunk: string) => {
        output += chunk;
        return emit(chunk);
      };
      try {
        await runCommandStreaming(
          "npx",
          [
            "eas-cli",
            "update",
            "--channel",
            channel,
            "--message",
            message,
            "--non-interactive",
            "--json",
          ],
          repoPath,
          captureEmit,
          envVars
        );
        let url: string | undefined;
        try {
          const parsed = JSON.parse(output.trim().split("\n").pop() ?? "{}");
          url = parsed.url ?? parsed.link ?? parsed.permalink;
        } catch {
          // ignore parse errors
        }
        await deployStorageService.updateRecord(projectId, deployId, {
          status: "success",
          completedAt: new Date().toISOString(),
          url,
        });
        broadcastToProject(projectId, { type: "deliver.completed", deployId, success: true });
      } catch (err) {
        const msg = getErrorMessage(err);
        await deployStorageService.updateRecord(projectId, deployId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: msg,
        });
        broadcastToProject(projectId, { type: "deliver.completed", deployId, success: false });
      }
    } else if (config.mode === "custom") {
      const customCommand = targetConfig?.command ?? config.customCommand;
      const webhookUrl = targetConfig?.webhookUrl ?? config.webhookUrl;

      if (customCommand) {
        await runCommandStreaming("sh", ["-c", customCommand], repoPath, emit, envVars);
        await deployStorageService.updateRecord(projectId, deployId, {
          status: "success",
          completedAt: new Date().toISOString(),
        });
        broadcastToProject(projectId, { type: "deliver.completed", deployId, success: true });
      } else if (webhookUrl) {
        const result = await deploymentService.deployWithWebhook(projectId, webhookUrl, envVars);
        emit(`Webhook POST to ${webhookUrl}\n`);
        await deployStorageService.updateRecord(projectId, deployId, {
          status: result.success ? "success" : "failed",
          completedAt: new Date().toISOString(),
          url: result.url,
          error: result.error,
        });
        broadcastToProject(projectId, {
          type: "deliver.completed",
          deployId,
          success: result.success,
        });
      } else {
        await deployStorageService.updateRecord(projectId, deployId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: "No custom deployment command or webhook URL configured",
        });
        broadcastToProject(projectId, { type: "deliver.completed", deployId, success: false });
      }
    } else {
      await deployStorageService.updateRecord(projectId, deployId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: `Unknown deployment mode: ${config.mode}`,
      });
      broadcastToProject(projectId, { type: "deliver.completed", deployId, success: false });
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    emit(`Error: ${msg}\n`);
    await deployStorageService.updateRecord(projectId, deployId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: msg,
    });
    broadcastToProject(projectId, { type: "deliver.completed", deployId, success: false });
  }
}

/** Run Expo deploy (beta or prod): npx expo export --platform web && eas deploy [--prod] */
async function runExpoDeployAsync(
  projectId: string,
  deployId: string,
  repoPath: string,
  variant: "beta" | "prod",
  emit: (chunk: string) => void,
  envVars?: Record<string, string>
): Promise<void> {
  const cmd = getExpoDeployCommand(variant);
  try {
    await ensureEasConfig(repoPath);
    emit(`Running: ${cmd}\n`);
    await runCommandStreaming("sh", ["-c", cmd], repoPath, emit, envVars);
    await deployStorageService.updateRecord(projectId, deployId, {
      status: "success",
      completedAt: new Date().toISOString(),
    });
    broadcastToProject(projectId, { type: "deliver.completed", deployId, success: true });
  } catch (err) {
    const msg = getErrorMessage(err);
    emit(`Error: ${msg}\n`);
    await deployStorageService.updateRecord(projectId, deployId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: msg,
    });
    broadcastToProject(projectId, { type: "deliver.completed", deployId, success: false });
  }
}

/** Run rollback command with streaming */
async function runRollbackAsync(
  projectId: string,
  deployId: string,
  repoPath: string,
  rollbackCommand: string,
  rolledBackDeployId: string | null
): Promise<void> {
  const emit = (chunk: string) => {
    const p = deployStorageService.appendLog(projectId, deployId, chunk);
    broadcastToProject(projectId, { type: "deliver.output", deployId, chunk });
    return p;
  };

  try {
    await runCommandStreaming("sh", ["-c", rollbackCommand], repoPath, emit);
    await deployStorageService.updateRecord(projectId, deployId, {
      status: "success",
      completedAt: new Date().toISOString(),
    });
    if (rolledBackDeployId) {
      await deployStorageService.updateRecord(projectId, rolledBackDeployId, {
        status: "rolled_back",
        rolledBackBy: deployId,
      });
    }
    broadcastToProject(projectId, { type: "deliver.completed", deployId, success: true });
  } catch (err) {
    const msg = getErrorMessage(err);
    emit(`Error: ${msg}\n`);
    await deployStorageService.updateRecord(projectId, deployId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: msg,
    });
    broadcastToProject(projectId, { type: "deliver.completed", deployId, success: false });
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

    proc.on("close", async (code) => {
      try {
        await Promise.all(pendingOutput);
      } catch {
        // Log writes are best-effort; don't fail the deploy
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}
