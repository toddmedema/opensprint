import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import initSqlJs from "sql.js";
import { deployStorageService } from "../services/deploy-storage.service.js";
import { ProjectService } from "../services/project.service.js";
import { DEFAULT_HIL_CONFIG } from "@opensprint/shared";
import type { Database } from "sql.js";

let testDb: Database;
vi.mock("../services/task-store.service.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../services/task-store.service.js")>();
  return {
    ...mod,
    taskStore: {
      init: vi.fn().mockImplementation(async () => {
        const SQL = await initSqlJs();
        testDb = new SQL.Database();
        testDb.run(mod.SCHEMA_SQL);
      }),
      getDb: vi.fn().mockImplementation(async () => testDb),
      runWrite: vi
        .fn()
        .mockImplementation(async (fn: (db: Database) => Promise<unknown>) => fn(testDb)),
    },
  };
});

describe("DeployStorageService", () => {
  let projectService: ProjectService;
  let tempDir: string;
  let projectId: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    projectService = new ProjectService();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "opensprint-deploy-storage-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;

    const { taskStore } = await import("../services/task-store.service.js");
    await taskStore.init();

    const repoPath = path.join(tempDir, "my-project");
    const project = await projectService.createProject({
      name: "Deploy Storage Test",
      repoPath,
      simpleComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      complexComplexityAgent: { type: "claude", model: "claude-sonnet-4", cliCommand: null },
      deployment: { mode: "custom" },
      hilConfig: DEFAULT_HIL_CONFIG,
    });
    projectId = project.id;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should create record with commitHash, target, mode", async () => {
    const record = await deployStorageService.createRecord(projectId, null, {
      commitHash: "abc123def",
      target: "staging",
      mode: "expo",
    });

    expect(record.id).toBeDefined();
    expect(record.projectId).toBe(projectId);
    expect(record.status).toBe("pending");
    expect(record.commitHash).toBe("abc123def");
    expect(record.target).toBe("staging");
    expect(record.mode).toBe("expo");
    expect(record.previousDeployId).toBeNull();
  });

  it("should default target to production and mode to custom when options omitted", async () => {
    const record = await deployStorageService.createRecord(projectId, null);

    expect(record.target).toBe("production");
    expect(record.mode).toBe("custom");
    expect(record.commitHash).toBeNull();
  });

  it("should update record with rolled_back status and rolledBackBy", async () => {
    const record = await deployStorageService.createRecord(projectId, null);
    await deployStorageService.updateRecord(projectId, record.id, {
      status: "success",
      completedAt: new Date().toISOString(),
    });

    const rollbackDeployId = "rollback-deploy-123";
    const updated = await deployStorageService.updateRecord(projectId, record.id, {
      status: "rolled_back",
      rolledBackBy: rollbackDeployId,
    });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("rolled_back");
    expect(updated!.rolledBackBy).toBe(rollbackDeployId);
  });

  describe("getLastSuccessfulDeployForTarget", () => {
    it("returns null when no successful deployment for target", async () => {
      const result = await deployStorageService.getLastSuccessfulDeployForTarget(
        projectId,
        "staging"
      );
      expect(result).toBeNull();
    });

    it("returns last successful deployment for target, excludes failed", async () => {
      const r1 = await deployStorageService.createRecord(projectId, null, {
        target: "staging",
      });
      await deployStorageService.updateRecord(projectId, r1.id, {
        status: "failed",
        completedAt: "2025-02-15T01:00:00.000Z",
      });

      const r2 = await deployStorageService.createRecord(projectId, null, {
        target: "staging",
      });
      await deployStorageService.updateRecord(projectId, r2.id, {
        status: "success",
        completedAt: "2025-02-15T02:00:00.000Z",
      });

      const result = await deployStorageService.getLastSuccessfulDeployForTarget(
        projectId,
        "staging"
      );
      expect(result).not.toBeNull();
      expect(result!.id).toBe(r2.id);
      expect(result!.status).toBe("success");
      expect(result!.completedAt).toBe("2025-02-15T02:00:00.000Z");
    });

    it("returns most recent successful deployment when multiple exist", async () => {
      const r1 = await deployStorageService.createRecord(projectId, null, {
        target: "staging",
      });
      await deployStorageService.updateRecord(projectId, r1.id, {
        status: "success",
        completedAt: "2025-02-15T01:00:00.000Z",
      });

      const r2 = await deployStorageService.createRecord(projectId, null, {
        target: "staging",
      });
      await deployStorageService.updateRecord(projectId, r2.id, {
        status: "success",
        completedAt: "2025-02-15T03:00:00.000Z",
      });

      const result = await deployStorageService.getLastSuccessfulDeployForTarget(
        projectId,
        "staging"
      );
      expect(result).not.toBeNull();
      expect(result!.id).toBe(r2.id);
      expect(result!.completedAt).toBe("2025-02-15T03:00:00.000Z");
    });

    it("returns deployment for correct target only", async () => {
      const rStaging = await deployStorageService.createRecord(projectId, null, {
        target: "staging",
      });
      await deployStorageService.updateRecord(projectId, rStaging.id, {
        status: "success",
        completedAt: "2025-02-15T02:00:00.000Z",
      });

      const rProd = await deployStorageService.createRecord(projectId, null, {
        target: "production",
      });
      await deployStorageService.updateRecord(projectId, rProd.id, {
        status: "success",
        completedAt: "2025-02-15T03:00:00.000Z",
      });

      const stagingResult = await deployStorageService.getLastSuccessfulDeployForTarget(
        projectId,
        "staging"
      );
      const prodResult = await deployStorageService.getLastSuccessfulDeployForTarget(
        projectId,
        "production"
      );

      expect(stagingResult!.id).toBe(rStaging.id);
      expect(prodResult!.id).toBe(rProd.id);
    });

    it("excludes rolled_back deployments (do not use as baseline)", async () => {
      const r1 = await deployStorageService.createRecord(projectId, null, {
        target: "staging",
      });
      await deployStorageService.updateRecord(projectId, r1.id, {
        status: "success",
        completedAt: "2025-02-15T02:00:00.000Z",
      });

      const r2 = await deployStorageService.createRecord(projectId, null, {
        target: "staging",
      });
      await deployStorageService.updateRecord(projectId, r2.id, {
        status: "success",
        completedAt: "2025-02-15T03:00:00.000Z",
      });
      await deployStorageService.updateRecord(projectId, r2.id, {
        status: "rolled_back",
        rolledBackBy: "rollback-123",
      });

      const result = await deployStorageService.getLastSuccessfulDeployForTarget(
        projectId,
        "staging"
      );
      expect(result).not.toBeNull();
      expect(result!.id).toBe(r1.id);
    });
  });
});
