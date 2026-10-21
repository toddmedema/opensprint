import { randomUUID } from "node:crypto";
import { assertDeploymentOperation } from "./operation-effect-context.js";
import type { DeploymentRecord } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { taskStore } from "./task-store.service.js";
import { lockProject, resourceChanged } from "./project-event.service.js";
import type { DbClient } from "../db/client.js";
import { AppError } from "../middleware/error-handler.js";

const _projectService = new ProjectService();

function rowToRecord(row: Record<string, unknown>): DeploymentRecord {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    status: row.status as DeploymentRecord["status"],
    startedAt: row.started_at as string,
    completedAt: (row.completed_at as string) ?? null,
    commitHash: (row.commit_hash as string) ?? null,
    target: (row.target as string) ?? "production",
    mode: (row.mode as DeploymentRecord["mode"]) ?? "custom",
    url: row.url as string | undefined,
    error: row.error as string | undefined,
    log: JSON.parse((row.log as string) || "[]") as string[],
    previousDeployId: (row.previous_deploy_id as string) ?? null,
    rolledBackBy: (row.rolled_back_by as string) ?? null,
    fixEpicId: (row.fix_epic_id as string) ?? null,
  };
}

export class DeployStorageService {
  private async reconcileInterrupted(projectId: string): Promise<void> {
    await taskStore.runWrite(async (tx) => {
      await tx.execute(
        `UPDATE deployments SET status = 'uncertain', error = 'Operation owner ended before deployment completion was confirmed'
        WHERE project_id = $1 AND status IN ('pending','running','stop_requested')
        AND EXISTS (SELECT 1 FROM durable_operations o WHERE o.id = deployments.id AND o.project_id = deployments.project_id AND o.status = 'uncertain')`,
        [projectId]
      );
    });
  }
  async createRecord(
    projectId: string,
    previousDeployId?: string | null,
    options?: {
      id?: string;
      commitHash?: string | null;
      target?: string;
      mode?: "expo" | "custom";
      exclusive?: boolean;
    }
  ): Promise<DeploymentRecord> {
    const record: DeploymentRecord = {
      id: options?.id ?? randomUUID(),
      projectId,
      status: "pending",
      startedAt: new Date().toISOString(),
      completedAt: null,
      log: [],
      previousDeployId: previousDeployId ?? null,
      commitHash: options?.commitHash ?? null,
      target: options?.target ?? "production",
      mode: options?.mode ?? "custom",
    };

    await taskStore.runWrite(async (client) => {
      if (options?.exclusive) {
        await lockProject(client, projectId);
        const active = await client.queryOne(
          "SELECT id FROM deployments WHERE project_id = $1 AND status IN ('pending','running','stop_requested','uncertain') LIMIT 1",
          [projectId]
        );
        if (active)
          throw new AppError(
            409,
            "DEPLOY_ALREADY_RUNNING",
            "A deployment is active or uncertain; reconcile it before starting another.",
            { deployId: active.id }
          );
      }
      await client.execute(
        `INSERT INTO deployments (
          id, project_id, status, started_at, completed_at, commit_hash, target, mode,
          url, error, log, previous_deploy_id, rolled_back_by, fix_epic_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          record.id,
          record.projectId,
          record.status,
          record.startedAt,
          record.completedAt,
          record.commitHash ?? null,
          record.target ?? null,
          record.mode ?? null,
          record.url ?? null,
          record.error ?? null,
          JSON.stringify(record.log),
          record.previousDeployId ?? null,
          record.rolledBackBy ?? null,
          record.fixEpicId ?? null,
        ]
      );
      await resourceChanged(client, projectId, "deployment", record.id, record);
    });
    return record;
  }

  async getRecord(projectId: string, deployId: string): Promise<DeploymentRecord | null> {
    await this.reconcileInterrupted(projectId);
    const client = await taskStore.getDb();
    const row = await client.queryOne(
      "SELECT * FROM deployments WHERE id = $1 AND project_id = $2",
      [deployId, projectId]
    );
    if (!row) return null;
    return rowToRecord(row as Record<string, unknown>);
  }

  async updateRecord(
    projectId: string,
    deployId: string,
    updates: Partial<
      Pick<
        DeploymentRecord,
        "status" | "completedAt" | "url" | "error" | "log" | "rolledBackBy" | "fixEpicId"
      >
    >
  ): Promise<DeploymentRecord | null> {
    return taskStore.runWrite(async (tx) => {
      await lockProject(tx, projectId);
      const row = await tx.queryOne("SELECT * FROM deployments WHERE id = $1 AND project_id = $2", [
        deployId,
        projectId,
      ]);
      if (!row) return null;
      return this.writeRecord(tx, { ...rowToRecord(row), ...updates });
    });
  }

  private async writeRecord(tx: DbClient, record: DeploymentRecord): Promise<DeploymentRecord> {
    await assertDeploymentOperation(tx, record.projectId);
    await tx.execute(
      `UPDATE deployments SET status=$1, completed_at=$2, url=$3, error=$4, log=$5,
      rolled_back_by=$6, fix_epic_id=$7 WHERE id=$8 AND project_id=$9`,
      [
        record.status,
        record.completedAt ?? null,
        record.url ?? null,
        record.error ?? null,
        JSON.stringify(record.log),
        record.rolledBackBy ?? null,
        record.fixEpicId ?? null,
        record.id,
        record.projectId,
      ]
    );
    await resourceChanged(tx, record.projectId, "deployment", record.id, record);
    return record;
  }

  async appendLog(
    projectId: string,
    deployId: string,
    chunk: string
  ): Promise<DeploymentRecord | null> {
    return taskStore.runWrite(async (tx) => {
      await lockProject(tx, projectId);
      const row = await tx.queryOne("SELECT * FROM deployments WHERE id = $1 AND project_id = $2", [
        deployId,
        projectId,
      ]);
      if (!row) return null;
      const record = rowToRecord(row);
      record.log.push(chunk);
      return this.writeRecord(tx, record);
    });
  }

  async listHistory(projectId: string, limit: number = 50): Promise<DeploymentRecord[]> {
    await this.reconcileInterrupted(projectId);
    const client = await taskStore.getDb();
    const rows = await client.query(
      "SELECT * FROM deployments WHERE project_id = $1 ORDER BY started_at DESC, id DESC LIMIT $2",
      [projectId, limit]
    );
    return rows.map((r) => rowToRecord(r as Record<string, unknown>));
  }

  async getLatestDeploy(projectId: string): Promise<DeploymentRecord | null> {
    const history = await this.listHistory(projectId, 1);
    return history[0] ?? null;
  }

  /**
   * Get the last successful deployment for a project and target.
   * Excludes failed and rolled_back deployments (do not use failed deployment as baseline).
   */
  async getLastSuccessfulDeployForTarget(
    projectId: string,
    targetName: string
  ): Promise<DeploymentRecord | null> {
    const client = await taskStore.getDb();
    const row = await client.queryOne(
      `SELECT * FROM deployments
       WHERE project_id = $1 AND target = $2 AND status = 'success'
       ORDER BY COALESCE(completed_at, started_at) DESC
       LIMIT 1`,
      [projectId, targetName]
    );
    if (!row) return null;
    return rowToRecord(row as Record<string, unknown>);
  }
}

export const deployStorageService = new DeployStorageService();
