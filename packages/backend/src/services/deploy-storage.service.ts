import fs from "fs/promises";
import path from "path";
import { v4 as uuid } from "uuid";
import type { DeploymentRecord } from "@opensprint/shared";
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import { ProjectService } from "./project.service.js";
import { writeJsonAtomic } from "../utils/file-utils.js";

const projectService = new ProjectService();

export class DeployStorageService {
  private getDeploymentsDir(repoPath: string): string {
    return path.join(repoPath, OPENSPRINT_PATHS.deployments);
  }

  private getRecordPath(repoPath: string, deployId: string): string {
    return path.join(this.getDeploymentsDir(repoPath), `${deployId}.json`);
  }

  async ensureDeploymentsDir(repoPath: string): Promise<void> {
    const dir = this.getDeploymentsDir(repoPath);
    await fs.mkdir(dir, { recursive: true });
  }

  async createRecord(
    projectId: string,
    previousDeployId?: string | null,
    options?: { commitHash?: string | null; target?: string; mode?: 'expo' | 'custom' },
  ): Promise<DeploymentRecord> {
    const project = await projectService.getProject(projectId);
    await this.ensureDeploymentsDir(project.repoPath);

    const record: DeploymentRecord = {
      id: uuid(),
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

    const filePath = this.getRecordPath(project.repoPath, record.id);
    await writeJsonAtomic(filePath, record);
    return record;
  }

  async getRecord(projectId: string, deployId: string): Promise<DeploymentRecord | null> {
    const project = await projectService.getProject(projectId);
    const filePath = this.getRecordPath(project.repoPath, deployId);
    try {
      const data = await fs.readFile(filePath, "utf-8");
      return JSON.parse(data) as DeploymentRecord;
    } catch {
      return null;
    }
  }

  async updateRecord(
    projectId: string,
    deployId: string,
    updates: Partial<
      Pick<DeploymentRecord, "status" | "completedAt" | "url" | "error" | "log" | "rolledBackBy" | "fixEpicId">
    >,
  ): Promise<DeploymentRecord | null> {
    const existing = await this.getRecord(projectId, deployId);
    if (!existing) return null;

    const updated: DeploymentRecord = {
      ...existing,
      ...updates,
      log: updates.log !== undefined ? updates.log : existing.log,
    };

    const project = await projectService.getProject(projectId);
    const filePath = this.getRecordPath(project.repoPath, deployId);
    await writeJsonAtomic(filePath, updated);
    return updated;
  }

  async appendLog(projectId: string, deployId: string, chunk: string): Promise<DeploymentRecord | null> {
    const existing = await this.getRecord(projectId, deployId);
    if (!existing) return null;

    const newLog = [...existing.log, chunk];
    return this.updateRecord(projectId, deployId, { log: newLog });
  }

  async listHistory(projectId: string, limit: number = 50): Promise<DeploymentRecord[]> {
    const project = await projectService.getProject(projectId);
    const dir = this.getDeploymentsDir(project.repoPath);
    try {
      const files = await fs.readdir(dir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));
      const records: DeploymentRecord[] = [];

      for (const file of jsonFiles) {
        try {
          const data = await fs.readFile(path.join(dir, file), "utf-8");
          records.push(JSON.parse(data) as DeploymentRecord);
        } catch {
          // Skip corrupt files
        }
      }

      // Sort by startedAt descending
      records.sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1));
      return records.slice(0, limit);
    } catch {
      return [];
    }
  }

  async getLatestDeploy(projectId: string): Promise<DeploymentRecord | null> {
    const history = await this.listHistory(projectId, 1);
    return history[0] ?? null;
  }
}

export const deployStorageService = new DeployStorageService();
