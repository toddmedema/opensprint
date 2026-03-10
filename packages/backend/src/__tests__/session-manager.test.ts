import crypto from "crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { SessionManager } from "../services/session-manager.js";
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import { ensureRuntimeDir, getRuntimePath } from "../utils/runtime-dir.js";
import type { DbClient } from "../db/client.js";

function repoPathToProjectId(repoPath: string): string {
  return "repo:" + crypto.createHash("sha256").update(repoPath).digest("hex").slice(0, 12);
}

async function insertSession(
  client: DbClient,
  projectId: string,
  session: {
    taskId: string;
    attempt: number;
    agentType: string;
    agentModel: string;
    startedAt: string;
    completedAt: string | null;
    status: string;
    outputLog: string;
    gitBranch: string;
    gitDiff: string | null;
    testResults: unknown;
    failureReason: string | null;
    summary?: string;
  }
): Promise<void> {
  await client.execute(
    `INSERT INTO agent_sessions (project_id, task_id, attempt, agent_type, agent_model, started_at, completed_at, status, output_log, git_branch, git_diff, test_results, failure_reason, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      projectId,
      session.taskId,
      session.attempt,
      session.agentType,
      session.agentModel,
      session.startedAt,
      session.completedAt ?? null,
      session.status,
      session.outputLog ?? null,
      session.gitBranch,
      session.gitDiff ?? null,
      session.testResults ? JSON.stringify(session.testResults) : null,
      session.failureReason ?? null,
      session.summary ?? null,
    ]
  );
}

const { testClientRef } = vi.hoisted(() => ({
  testClientRef: { current: null as DbClient | null },
}));
vi.mock("../services/task-store.service.js", async () => {
  const { createTestPostgresClient } = await import("./test-db-helper.js");
  const dbResult = await createTestPostgresClient();
  testClientRef.current = dbResult?.client ?? null;
  return {
    taskStore: {
      init: vi.fn().mockImplementation(async () => {}),
      getDb: vi.fn().mockImplementation(async () => testClientRef.current),
      runWrite: vi
        .fn()
        .mockImplementation(async (fn: (client: DbClient) => Promise<unknown>) =>
          fn(testClientRef.current!)
        ),
    },
    TaskStoreService: vi.fn(),
    SCHEMA_SQL: "",
    _postgresAvailable: !!dbResult,
  };
});

const sessionTaskStoreMod = await import("../services/task-store.service.js");
const sessionPostgresOk =
  (sessionTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

/** Pure path tests that run without Postgres */
describe("SessionManager getResultPath", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  it("returns result.json path when angle is undefined", () => {
    const result = manager.getResultPath("/repo", "task-1");
    expect(result).toMatch(/result\.json$/);
    expect(result).not.toContain("review-angles");
    expect(result).toContain("task-1");
  });

  it("returns review-angles/<angle>/result.json when angle provided", () => {
    const result = manager.getResultPath("/repo", "task-1", "security");
    expect(result).toContain("review-angles/security/result.json");
    expect(result).toContain("task-1");
  });

  it("returns different paths for different angles", () => {
    const security = manager.getResultPath("/repo", "task-x", "security");
    const performance = manager.getResultPath("/repo", "task-x", "performance");
    expect(security).toContain("security");
    expect(performance).toContain("performance");
    expect(security).not.toBe(performance);
  });
});

describe.skipIf(!sessionPostgresOk)("SessionManager", () => {
  let manager: SessionManager;
  let repoPath: string;

  beforeEach(async () => {
    if (!testClientRef.current) throw new Error("Postgres required");
    manager = new SessionManager();
    repoPath = path.join(os.tmpdir(), `opensprint-session-test-${Date.now()}`);
    await fs.mkdir(repoPath, { recursive: true });
    const { taskStore } = await import("../services/task-store.service.js");
    await taskStore.init();
  });

  afterEach(async () => {
    try {
      await fs.rm(repoPath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("loadSessionsGroupedByTaskId", () => {
    it("returns empty map when sessions directory does not exist", async () => {
      const result = await manager.loadSessionsGroupedByTaskId(repoPath);
      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(0);
    });

    it("returns empty map when sessions directory is empty", async () => {
      await ensureRuntimeDir(repoPath);
      const sessionsDir = getRuntimePath(repoPath, OPENSPRINT_PATHS.sessions);
      await fs.mkdir(sessionsDir, { recursive: true });
      const result = await manager.loadSessionsGroupedByTaskId(repoPath);
      expect(result.size).toBe(0);
    });

    it("groups sessions by task ID from DB", async () => {
      const projectId = repoPathToProjectId(repoPath);
      const { taskStore } = await import("../services/task-store.service.js");
      const client = await taskStore.getDb();

      await insertSession(client, projectId, {
        taskId: "task-a",
        attempt: 1,
        agentType: "cursor",
        agentModel: "gpt-4",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-01-01T00:05:00Z",
        status: "success",
        outputLog: "",
        gitBranch: "main",
        gitDiff: null,
        testResults: { passed: 5, failed: 0, skipped: 0, total: 5, details: [] },
        failureReason: null,
      });
      await insertSession(client, projectId, {
        taskId: "task-a",
        attempt: 2,
        agentType: "cursor",
        agentModel: "gpt-4",
        startedAt: "2024-01-02T00:00:00Z",
        completedAt: "2024-01-02T00:05:00Z",
        status: "success",
        outputLog: "",
        gitBranch: "main",
        gitDiff: null,
        testResults: { passed: 6, failed: 0, skipped: 0, total: 6, details: [] },
        failureReason: null,
      });
      await insertSession(client, projectId, {
        taskId: "task-b",
        attempt: 1,
        agentType: "cursor",
        agentModel: "gpt-4",
        startedAt: "2024-01-03T00:00:00Z",
        completedAt: "2024-01-03T00:05:00Z",
        status: "success",
        outputLog: "",
        gitBranch: "main",
        gitDiff: null,
        testResults: null,
        failureReason: null,
      });

      const result = await manager.loadSessionsGroupedByTaskId(repoPath);
      expect(result.size).toBe(2);
      expect(result.get("task-a")).toHaveLength(2);
      expect(result.get("task-a")![0].attempt).toBe(1);
      expect(result.get("task-a")![1].attempt).toBe(2);
      expect(result.get("task-a")![1].testResults?.passed).toBe(6);
      expect(result.get("task-b")).toHaveLength(1);
    });

    it("parses task IDs with hyphens correctly (e.g. opensprint.dev-q0h6)", async () => {
      const projectId = repoPathToProjectId(repoPath);
      const { taskStore } = await import("../services/task-store.service.js");
      const client = await taskStore.getDb();
      await insertSession(client, projectId, {
        taskId: "opensprint.dev-q0h6",
        attempt: 1,
        agentType: "cursor",
        agentModel: "gpt-4",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-01-01T00:05:00Z",
        status: "success",
        outputLog: "",
        gitBranch: "main",
        gitDiff: null,
        testResults: null,
        failureReason: null,
      });

      const result = await manager.loadSessionsGroupedByTaskId(repoPath);
      expect(result.size).toBe(1);
      expect(result.get("opensprint.dev-q0h6")).toHaveLength(1);
      expect(result.get("opensprint.dev-q0h6")![0].attempt).toBe(1);
    });

    it("returns one task when one session exists", async () => {
      const projectId = repoPathToProjectId(repoPath);
      const { taskStore } = await import("../services/task-store.service.js");
      const client = await taskStore.getDb();
      await insertSession(client, projectId, {
        taskId: "valid-task",
        attempt: 1,
        agentType: "cursor",
        agentModel: "gpt-4",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: null,
        status: "success",
        outputLog: "",
        gitBranch: "main",
        gitDiff: null,
        testResults: null,
        failureReason: null,
      });

      const result = await manager.loadSessionsGroupedByTaskId(repoPath);
      expect(result.size).toBe(1);
      expect(result.get("valid-task")).toHaveLength(1);
    });

    it("returns session by task and attempt from DB", async () => {
      const projectId = repoPathToProjectId(repoPath);
      const { taskStore } = await import("../services/task-store.service.js");
      const client = await taskStore.getDb();
      await insertSession(client, projectId, {
        taskId: "task",
        attempt: 2,
        agentType: "cursor",
        agentModel: "gpt-4",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: null,
        status: "success",
        outputLog: "",
        gitBranch: "main",
        gitDiff: null,
        testResults: null,
        failureReason: null,
      });

      const result = await manager.loadSessionsGroupedByTaskId(repoPath);
      expect(result.size).toBe(1);
      expect(result.get("task")).toHaveLength(1);
      expect(result.get("task")![0].attempt).toBe(2);
    });
  });

  describe("readSession", () => {
    it("returns session when row exists in DB", async () => {
      const projectId = repoPathToProjectId(repoPath);
      const { taskStore } = await import("../services/task-store.service.js");
      const client = await taskStore.getDb();
      const sessionData = {
        taskId: "task-x",
        attempt: 1,
        agentType: "cursor",
        agentModel: "gpt-4",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-01-01T00:05:00Z",
        status: "success",
        outputLog: "",
        gitBranch: "main",
        gitDiff: null,
        testResults: null,
        failureReason: null,
      };
      await insertSession(client, projectId, sessionData);

      const result = await manager.readSession(repoPath, "task-x", 1);
      expect(result).toMatchObject(sessionData);
    });

    it("returns null when no session for task/attempt", async () => {
      const result = await manager.readSession(repoPath, "nonexistent", 1);
      expect(result).toBeNull();
    });

    it("returns null when session does not exist in DB", async () => {
      const result = await manager.readSession(repoPath, "task-y", 1);
      expect(result).toBeNull();
    });
  });

  describe("readResult", () => {
    it("returns result when result.json exists and is valid", async () => {
      const activeDir = path.join(repoPath, OPENSPRINT_PATHS.active, "task-z");
      await fs.mkdir(activeDir, { recursive: true });
      const resultData = { status: "success", summary: "Done" };
      await fs.writeFile(path.join(activeDir, "result.json"), JSON.stringify(resultData));

      const result = await manager.readResult(repoPath, "task-z");
      expect(result).toEqual(resultData);
    });

    it("returns result from review-angles/<angle>/result.json when angle provided", async () => {
      const activeDir = path.join(repoPath, OPENSPRINT_PATHS.active, "task-angle");
      const angleDir = path.join(activeDir, "review-angles", "security");
      await fs.mkdir(angleDir, { recursive: true });
      const resultData = { status: "approved", summary: "Security review passed" };
      await fs.writeFile(path.join(angleDir, "result.json"), JSON.stringify(resultData));

      const result = await manager.readResult(repoPath, "task-angle", "security");
      expect(result).toEqual(resultData);
    });

    it("returns null when angle-specific result.json does not exist", async () => {
      const activeDir = path.join(repoPath, OPENSPRINT_PATHS.active, "task-no-angle");
      await fs.mkdir(activeDir, { recursive: true });

      const result = await manager.readResult(repoPath, "task-no-angle", "performance");
      expect(result).toBeNull();
    });

    it("returns null when result.json does not exist", async () => {
      const result = await manager.readResult(repoPath, "no-result-task");
      expect(result).toBeNull();
    });

    it("returns null when result.json is malformed", async () => {
      const activeDir = path.join(repoPath, OPENSPRINT_PATHS.active, "task-malformed");
      await fs.mkdir(activeDir, { recursive: true });
      await fs.writeFile(path.join(activeDir, "result.json"), "{ invalid");

      const result = await manager.readResult(repoPath, "task-malformed");
      expect(result).toBeNull();
    });
  });

  describe("clearResult", () => {
    it("removes result.json when angle is undefined", async () => {
      const activeDir = path.join(repoPath, OPENSPRINT_PATHS.active, "task-clear");
      await fs.mkdir(activeDir, { recursive: true });
      await fs.writeFile(path.join(activeDir, "result.json"), '{"status":"success"}');

      await manager.clearResult(repoPath, "task-clear");

      await expect(fs.access(path.join(activeDir, "result.json"))).rejects.toThrow();
    });

    it("removes review-angles/<angle>/result.json when angle provided", async () => {
      const activeDir = path.join(repoPath, OPENSPRINT_PATHS.active, "task-clear-angle");
      const angleDir = path.join(activeDir, "review-angles", "security");
      await fs.mkdir(angleDir, { recursive: true });
      await fs.writeFile(path.join(angleDir, "result.json"), '{"status":"approved"}');

      await manager.clearResult(repoPath, "task-clear-angle", "security");

      await expect(fs.access(path.join(angleDir, "result.json"))).rejects.toThrow();
    });

    it("does not throw when result file does not exist", async () => {
      await expect(manager.clearResult(repoPath, "nonexistent-task")).resolves.toBeUndefined();
      await expect(
        manager.clearResult(repoPath, "nonexistent-task", "performance")
      ).resolves.toBeUndefined();
    });
  });

  describe("archiveSession", () => {
    it("truncates output_log and git_diff at 100KB when archiving", async () => {
      const activeDir = path.join(repoPath, OPENSPRINT_PATHS.active, "task-trunc");
      await fs.mkdir(activeDir, { recursive: true });

      const largeOutputLog = "log".repeat(50_000);
      const largeGitDiff = "diff".repeat(50_000);
      await manager.archiveSession(repoPath, "task-trunc", 1, {
        taskId: "task-trunc",
        attempt: 1,
        agentType: "cursor",
        agentModel: "gpt-4",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-01-01T00:05:00Z",
        status: "success",
        outputLog: largeOutputLog,
        gitBranch: "main",
        gitDiff: largeGitDiff,
        testResults: null,
        failureReason: null,
      });

      const sessions = await manager.loadSessionsGroupedByTaskId(repoPath);
      const archived = sessions.get("task-trunc");
      expect(archived).toHaveLength(1);
      expect(archived![0].outputLog.length).toBeLessThan(largeOutputLog.length);
      expect(archived![0].outputLog.endsWith("\n\n... [truncated]")).toBe(true);
      expect(archived![0].gitDiff!.length).toBeLessThan(largeGitDiff.length);
      expect(archived![0].gitDiff!.endsWith("\n\n... [truncated]")).toBe(true);
    });

    it("truncates log over 100KB when archiving", async () => {
      const activeDir = path.join(repoPath, OPENSPRINT_PATHS.active, "task-default");
      await fs.mkdir(activeDir, { recursive: true });

      const hugeLog = "x".repeat(150_000);
      await manager.archiveSession(repoPath, "task-default", 1, {
        taskId: "task-default",
        attempt: 1,
        agentType: "cursor",
        agentModel: "gpt-4",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-01-01T00:05:00Z",
        status: "success",
        outputLog: hugeLog,
        gitBranch: "main",
        gitDiff: null,
        testResults: null,
        failureReason: null,
      });

      const sessions = await manager.loadSessionsGroupedByTaskId(repoPath);
      const archived = sessions.get("task-default");
      expect(archived).toHaveLength(1);
      expect(archived![0].outputLog.length).toBeLessThan(hugeLog.length);
      expect(archived![0].outputLog.endsWith("\n\n... [truncated]")).toBe(true);
    });

    it("archives nested review-angles artifacts recursively", async () => {
      const taskId = "task-nested";
      const activeDir = path.join(repoPath, OPENSPRINT_PATHS.active, taskId);
      const securityDir = path.join(activeDir, "review-angles", "security");
      const performanceDir = path.join(activeDir, "review-angles", "performance");
      await fs.mkdir(securityDir, { recursive: true });
      await fs.mkdir(performanceDir, { recursive: true });
      await fs.writeFile(path.join(activeDir, "agent-output.log"), "top-level log", "utf-8");
      await fs.writeFile(path.join(securityDir, "result.json"), '{"status":"approved"}', "utf-8");
      await fs.writeFile(
        path.join(performanceDir, "agent-output.log"),
        "performance angle log",
        "utf-8"
      );
      await fs.writeFile(path.join(activeDir, OPENSPRINT_PATHS.heartbeat), "{}", "utf-8");

      await manager.archiveSession(repoPath, taskId, 2, {
        taskId,
        attempt: 2,
        agentType: "cursor",
        agentModel: "gpt-4",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-01-01T00:05:00Z",
        status: "failed",
        outputLog: "review failed",
        gitBranch: "opensprint/task-nested",
        gitDiff: null,
        testResults: null,
        failureReason: "no_result",
      });

      const sessionDir = path.join(
        getRuntimePath(repoPath, OPENSPRINT_PATHS.sessions),
        `${taskId}-2`
      );
      await expect(
        fs.readFile(path.join(sessionDir, "review-angles", "security", "result.json"), "utf-8")
      ).resolves.toContain('"status":"approved"');
      await expect(
        fs.readFile(
          path.join(sessionDir, "review-angles", "performance", "agent-output.log"),
          "utf-8"
        )
      ).resolves.toContain("performance angle log");
      await expect(fs.access(path.join(sessionDir, OPENSPRINT_PATHS.heartbeat))).rejects.toThrow();
    });
  });

  describe("listSessions", () => {
    it("returns sessions for a task in attempt order", async () => {
      const projectId = repoPathToProjectId(repoPath);
      const { taskStore } = await import("../services/task-store.service.js");
      const client = await taskStore.getDb();
      await insertSession(client, projectId, {
        taskId: "my-task",
        attempt: 2,
        agentType: "cursor",
        agentModel: "gpt-4",
        startedAt: "2024-01-02T00:00:00Z",
        completedAt: null,
        status: "success",
        outputLog: "",
        gitBranch: "main",
        gitDiff: null,
        testResults: null,
        failureReason: null,
      });
      await insertSession(client, projectId, {
        taskId: "my-task",
        attempt: 1,
        agentType: "cursor",
        agentModel: "gpt-4",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: null,
        status: "success",
        outputLog: "",
        gitBranch: "main",
        gitDiff: null,
        testResults: null,
        failureReason: null,
      });

      const sessions = await manager.listSessions(repoPath, "my-task");
      expect(sessions).toHaveLength(2);
      expect(sessions[0].attempt).toBe(1);
      expect(sessions[1].attempt).toBe(2);
    });
  });
});
