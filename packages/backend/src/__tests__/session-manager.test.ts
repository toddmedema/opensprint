import crypto from "crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import initSqlJs from "sql.js";
import { SessionManager } from "../services/session-manager.js";
import { OPENSPRINT_PATHS } from "@opensprint/shared";
import { ensureRuntimeDir, getRuntimePath } from "../utils/runtime-dir.js";
import type { DbClient } from "../db/client.js";
import { createSqliteDbClient, SCHEMA_SQL_SQLITE } from "./test-db-helper.js";

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

let testClient: DbClient;
vi.mock("../services/task-store.service.js", async () => {
  const { createSqliteDbClient, SCHEMA_SQL_SQLITE } = await import("./test-db-helper.js");
  return {
    taskStore: {
      init: vi.fn().mockImplementation(async () => {
        const SQL = await initSqlJs();
        const db = new SQL.Database();
        db.run(SCHEMA_SQL_SQLITE);
        testClient = createSqliteDbClient(db);
      }),
      getDb: vi.fn().mockImplementation(async () => testClient),
      runWrite: vi
        .fn()
        .mockImplementation(async (fn: (client: DbClient) => Promise<unknown>) => fn(testClient)),
    },
    TaskStoreService: vi.fn(),
    SCHEMA_SQL: "",
  };
});

describe("SessionManager", () => {
  let manager: SessionManager;
  let repoPath: string;

  beforeEach(async () => {
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

  describe("archiveSession", () => {
    it("truncates output_log and git_diff to 95th percentile threshold when archiving", async () => {
      const projectId = repoPathToProjectId(repoPath);
      const { taskStore } = await import("../services/task-store.service.js");
      const client = await taskStore.getDb();

      // Seed agent_sessions with sizes to establish 95th percentile of 500
      await insertSession(client, projectId, {
        taskId: "seed-1",
        attempt: 1,
        agentType: "cursor",
        agentModel: "gpt-4",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-01-01T00:05:00Z",
        status: "success",
        outputLog: "x".repeat(500),
        gitBranch: "main",
        gitDiff: null,
        testResults: null,
        failureReason: null,
      });
      await insertSession(client, projectId, {
        taskId: "seed-2",
        attempt: 1,
        agentType: "cursor",
        agentModel: "gpt-4",
        startedAt: "2024-01-01T00:00:00Z",
        completedAt: "2024-01-01T00:05:00Z",
        status: "success",
        outputLog: "x".repeat(100),
        gitBranch: "main",
        gitDiff: "y".repeat(500),
        testResults: null,
        failureReason: null,
      });

      const activeDir = path.join(repoPath, OPENSPRINT_PATHS.active, "task-trunc");
      await fs.mkdir(activeDir, { recursive: true });

      const largeOutputLog = "log".repeat(1000);
      const largeGitDiff = "diff".repeat(1000);
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

    it("uses default threshold when no existing sessions", async () => {
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
