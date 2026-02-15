import { exec } from 'child_process';
import { promisify } from 'util';
import type { DeploymentConfig } from '@opensprint/shared';
import { ProjectService } from './project.service.js';
import { ensureEasConfig } from './eas-config.js';

const execAsync = promisify(exec);

export interface DeploymentResult {
  success: boolean;
  url?: string;
  error?: string;
  timestamp: string;
}

/**
 * Manages deployment after successful Build cycles.
 * Supports Expo.dev (EAS Build/Update) and custom pipelines.
 */
export class DeploymentService {
  private projectService = new ProjectService();

  /**
   * Deploy the project using the configured deployment mode.
   */
  async deploy(projectId: string): Promise<DeploymentResult> {
    const settings = await this.projectService.getSettings(projectId);
    const project = await this.projectService.getProject(projectId);

    try {
      let result: DeploymentResult;

      switch (settings.deployment.mode) {
        case 'expo':
          result = await this.deployExpo(project.repoPath, settings.deployment);
          break;
        case 'custom':
          result = await this.deployCustom(project.repoPath, settings.deployment);
          break;
        default:
          result = {
            success: false,
            error: `Unknown deployment mode: ${settings.deployment.mode}`,
            timestamp: new Date().toISOString(),
          };
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Ensure eas.json exists for EAS Build and OTA updates (PRD §6.4).
   */
  async ensureEasConfig(repoPath: string): Promise<void> {
    return ensureEasConfig(repoPath);
  }

  /**
   * Deploy using Expo.dev / EAS.
   * OTA update to preview channel for Validate phase (PRD §6.4).
   */
  private async deployExpo(
    repoPath: string,
    config: DeploymentConfig,
  ): Promise<DeploymentResult> {
    try {
      await ensureEasConfig(repoPath);

      const channel = config.expoConfig?.channel ?? 'preview';
      const message = `OpenSprint preview ${new Date().toISOString().slice(0, 19)}`;

      // Run EAS Update for OTA preview deployment
      const { stdout } = await execAsync(
        `npx eas-cli update --channel ${channel} --message "${message}" --non-interactive --json`,
        {
          cwd: repoPath,
          timeout: 600000, // 10 min timeout
          env: { ...process.env },
        },
      );

      // Parse EAS output for URL
      try {
        const output = JSON.parse(stdout);
        return {
          success: true,
          url: output.url || output.link || output.permalink,
          timestamp: new Date().toISOString(),
        };
      } catch {
        return {
          success: true,
          url: undefined,
          timestamp: new Date().toISOString(),
        };
      }
    } catch (error: unknown) {
      const err = error as { stderr?: string; message: string };
      return {
        success: false,
        error: `Expo deployment failed: ${err.stderr || err.message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Run EAS Build for full native builds.
   */
  async buildExpo(
    repoPath: string,
    platform: 'ios' | 'android' | 'all',
    profile: string = 'preview',
  ): Promise<DeploymentResult> {
    try {
      const platformArg = platform === 'all' ? '--platform all' : `--platform ${platform}`;
      const { stdout } = await execAsync(
        `npx eas-cli build ${platformArg} --profile ${profile} --non-interactive --json`,
        {
          cwd: repoPath,
          timeout: 1800000, // 30 min timeout
          env: { ...process.env },
        },
      );

      try {
        const output = JSON.parse(stdout);
        return {
          success: true,
          url: output.buildUrl || output.url,
          timestamp: new Date().toISOString(),
        };
      } catch {
        return {
          success: true,
          timestamp: new Date().toISOString(),
        };
      }
    } catch (error: unknown) {
      const err = error as { stderr?: string; message: string };
      return {
        success: false,
        error: `Expo build failed: ${err.stderr || err.message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Deploy using a custom pipeline: command or webhook (PRD §6.4).
   */
  private async deployCustom(
    repoPath: string,
    config: DeploymentConfig,
  ): Promise<DeploymentResult> {
    if (config.webhookUrl) {
      return this.deployWebhook(config.webhookUrl, repoPath);
    }
    if (config.customCommand) {
      return this.deployCommand(repoPath, config.customCommand);
    }
    return {
      success: false,
      error: 'No custom deployment command or webhook URL configured',
      timestamp: new Date().toISOString(),
    };
  }

  private async deployCommand(
    repoPath: string,
    command: string,
  ): Promise<DeploymentResult> {
    try {
      await execAsync(command, {
        cwd: repoPath,
        timeout: 600000,
        env: { ...process.env },
      });
      return {
        success: true,
        url: undefined,
        timestamp: new Date().toISOString(),
      };
    } catch (error: unknown) {
      const err = error as { stderr?: string; message: string };
      return {
        success: false,
        error: `Custom deployment failed: ${err.stderr || err.message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  private async deployWebhook(
    url: string,
    repoPath: string,
  ): Promise<DeploymentResult> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'build.completed',
          repoPath,
          timestamp: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        return {
          success: false,
          error: `Webhook returned ${res.status}: ${res.statusText}`,
          timestamp: new Date().toISOString(),
        };
      }
      return {
        success: true,
        url,
        timestamp: new Date().toISOString(),
      };
    } catch (error: unknown) {
      const err = error as Error;
      return {
        success: false,
        error: `Webhook failed: ${err.message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }
}

export const deploymentService = new DeploymentService();
