import { Router, Request } from "express";
import { spawn } from "child_process";
import type { ApiResponse, DeploymentRecord, DeploymentConfig, ProjectSettings } from "@opensprint/shared";
import { deploymentService } from "../services/deployment-service.js";
import { deployStorageService } from "../services/deploy-storage.service.js";
import { ProjectService } from "../services/project.service.js";
import { broadcastToProject } from "../websocket/index.js";
import { ensureEasConfig } from "../services/eas-config.js";

const projectService = new ProjectService();

export const deployRouter = Router({ mergeParams: true });

type ProjectParams = { projectId: string };
type DeployIdParams = { projectId: string; deployId: string };

/** Current deploy status for a project */
export interface DeployStatusResponse {
  activeDeployId: string | null;
  currentDeploy: DeploymentRecord | null;
}

// POST /projects/:projectId/deploy — Trigger deployment
deployRouter.post("/", async (req: Request<ProjectParams>, res, next) => {
  try {
    const { projectId } = req.params;
    const project = await projectService.getProject(projectId);
    const settings = await projectService.getSettings(projectId);

    const latest = await deployStorageService.getLatestDeploy(projectId);
    const previousDeployId = latest?.id ?? null;

    const record = await deployStorageService.createRecord(projectId, previousDeployId);

    broadcastToProject(projectId, { type: "deploy.started", deployId: record.id });

    await deployStorageService.updateRecord(projectId, record.id, { status: "running" });

    runDeployAsync(projectId, record.id, project.repoPath, settings.deployment).catch((err) => {
      console.error(`[deploy] Deploy ${record.id} failed:`, err);
    });

    const body: ApiResponse<{ deployId: string }> = { data: { deployId: record.id } };
    res.status(202).json(body);
  } catch (err) {
    next(err);
  }
});

// GET /projects/:projectId/deploy/status — Current deployment status
deployRouter.get("/status", async (req: Request<ProjectParams>, res, next) => {
  try {
    const { projectId } = req.params;
    const history = await deployStorageService.listHistory(projectId, 1);
    const current = history[0] ?? null;
    const activeDeployId = current?.status === "running" || current?.status === "pending" ? current.id : null;

    const body: ApiResponse<DeployStatusResponse> = {
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

// GET /projects/:projectId/deploy/history — Deployment history
deployRouter.get("/history", async (req: Request<ProjectParams>, res, next) => {
  try {
    const { projectId } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
    const history = await deployStorageService.listHistory(projectId, limit);

    const body: ApiResponse<DeploymentRecord[]> = { data: history };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

// PUT /projects/:projectId/deploy/settings — Update deployment settings (must be before /:deployId)
deployRouter.put("/settings", async (req: Request<ProjectParams>, res, next) => {
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

// POST /projects/:projectId/deploy/:deployId/rollback — Rollback to a deployment
deployRouter.post("/:deployId/rollback", async (req: Request<DeployIdParams>, res, next) => {
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

    if (settings.deployment.mode === "custom" && settings.deployment.rollbackCommand) {
      const rollbackRecord = await deployStorageService.createRecord(projectId, deployId);
      broadcastToProject(projectId, { type: "deploy.started", deployId: rollbackRecord.id });
      await deployStorageService.updateRecord(projectId, rollbackRecord.id, { status: "running" });

      runRollbackAsync(projectId, rollbackRecord.id, project.repoPath, settings.deployment.rollbackCommand!).catch(
        (err) => {
          console.error(`[deploy] Rollback ${rollbackRecord.id} failed:`, err);
        },
      );

      const body: ApiResponse<{ deployId: string }> = { data: { deployId: rollbackRecord.id } };
      res.status(202).json(body);
    } else {
      res.status(501).json({
        error: {
          code: "NOT_IMPLEMENTED",
          message: "Rollback is only supported for custom deployment with rollbackCommand configured",
        },
      });
    }
  } catch (err) {
    next(err);
  }
});

/** Run deployment asynchronously with streaming output */
async function runDeployAsync(
  projectId: string,
  deployId: string,
  repoPath: string,
  config: DeploymentConfig,
): Promise<void> {
  const emit = (chunk: string) => {
    deployStorageService.appendLog(projectId, deployId, chunk);
    broadcastToProject(projectId, { type: "deploy.output", deployId, chunk });
  };

  try {
    if (config.mode === "expo") {
      await ensureEasConfig(repoPath);
      const channel = config.expoConfig?.channel ?? "preview";
      const message = `OpenSprint preview ${new Date().toISOString().slice(0, 19)}`;
      let output = "";
      const captureEmit = (chunk: string) => {
        output += chunk;
        emit(chunk);
      };
      try {
        await runCommandStreaming(
          "npx",
          ["eas-cli", "update", "--channel", channel, "--message", message, "--non-interactive", "--json"],
          repoPath,
          captureEmit,
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
        broadcastToProject(projectId, { type: "deploy.completed", deployId, success: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await deployStorageService.updateRecord(projectId, deployId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: msg,
        });
        broadcastToProject(projectId, { type: "deploy.completed", deployId, success: false });
      }
    } else if (config.mode === "custom") {
      if (config.customCommand) {
        await runCommandStreaming("sh", ["-c", config.customCommand], repoPath, emit);
        await deployStorageService.updateRecord(projectId, deployId, {
          status: "success",
          completedAt: new Date().toISOString(),
        });
        broadcastToProject(projectId, { type: "deploy.completed", deployId, success: true });
      } else if (config.webhookUrl) {
        const result = await deploymentService.deploy(projectId);
        emit(`Webhook POST to ${config.webhookUrl}\n`);
        await deployStorageService.updateRecord(projectId, deployId, {
          status: result.success ? "success" : "failed",
          completedAt: new Date().toISOString(),
          url: result.url,
          error: result.error,
        });
        broadcastToProject(projectId, { type: "deploy.completed", deployId, success: result.success });
      } else {
        await deployStorageService.updateRecord(projectId, deployId, {
          status: "failed",
          completedAt: new Date().toISOString(),
          error: "No custom deployment command or webhook URL configured",
        });
        broadcastToProject(projectId, { type: "deploy.completed", deployId, success: false });
      }
    } else {
      await deployStorageService.updateRecord(projectId, deployId, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: `Unknown deployment mode: ${config.mode}`,
      });
      broadcastToProject(projectId, { type: "deploy.completed", deployId, success: false });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit(`Error: ${msg}\n`);
    await deployStorageService.updateRecord(projectId, deployId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: msg,
    });
    broadcastToProject(projectId, { type: "deploy.completed", deployId, success: false });
  }
}

/** Run rollback command with streaming */
async function runRollbackAsync(
  projectId: string,
  deployId: string,
  repoPath: string,
  rollbackCommand: string,
): Promise<void> {
  const emit = (chunk: string) => {
    deployStorageService.appendLog(projectId, deployId, chunk);
    broadcastToProject(projectId, { type: "deploy.output", deployId, chunk });
  };

  try {
    await runCommandStreaming("sh", ["-c", rollbackCommand], repoPath, emit);
    await deployStorageService.updateRecord(projectId, deployId, {
      status: "success",
      completedAt: new Date().toISOString(),
    });
    broadcastToProject(projectId, { type: "deploy.completed", deployId, success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit(`Error: ${msg}\n`);
    await deployStorageService.updateRecord(projectId, deployId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: msg,
    });
    broadcastToProject(projectId, { type: "deploy.completed", deployId, success: false });
  }
}

function runCommandStreaming(
  command: string,
  args: string[],
  cwd: string,
  onOutput: (chunk: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
    });

    proc.stdout?.on("data", (data: Buffer) => {
      onOutput(data.toString());
    });
    proc.stderr?.on("data", (data: Buffer) => {
      onOutput(data.toString());
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command exited with code ${code}`));
      }
    });
    proc.on("error", reject);
  });
}
