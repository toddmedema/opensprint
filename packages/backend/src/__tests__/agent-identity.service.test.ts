import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import initSqlJs from "sql.js";
import {
  AgentIdentityService,
  type TaskAttemptRecord,
} from "../services/agent-identity.service.js";
import type { ProjectSettings } from "@opensprint/shared";
import type { DbClient } from "../db/client.js";
import { createSqliteDbClient, SCHEMA_SQL_SQLITE } from "./test-db-helper.js";

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

describe("AgentIdentityService", () => {
  let tmpDir: string;
  let service: AgentIdentityService;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `agent-identity-test-${Date.now()}`);
    await fs.mkdir(path.join(tmpDir, ".opensprint"), { recursive: true });
    const { taskStore } = await import("../services/task-store.service.js");
    await taskStore.init();
    service = new AgentIdentityService();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeRecord(overrides: Partial<TaskAttemptRecord> = {}): TaskAttemptRecord {
    return {
      taskId: "task-1",
      agentId: "claude-sonnet",
      model: "claude-sonnet-4-20250514",
      attempt: 1,
      startedAt: "2025-01-01T00:00:00.000Z",
      completedAt: "2025-01-01T00:01:00.000Z",
      outcome: "success",
      durationMs: 60000,
      ...overrides,
    };
  }

  it("should record and retrieve attempt records", async () => {
    await service.recordAttempt(tmpDir, makeRecord());
    await service.recordAttempt(tmpDir, makeRecord({ attempt: 2, outcome: "test_failure" }));

    const recent = await service.getRecentAttempts(tmpDir, "task-1");
    expect(recent).toHaveLength(2);
    expect(recent[0].outcome).toBe("success");
    expect(recent[1].outcome).toBe("test_failure");
  });

  it("should persist stats to DB", async () => {
    await service.recordAttempt(tmpDir, makeRecord());

    const recent = await service.getRecentAttempts(tmpDir, "task-1");
    expect(recent).toHaveLength(1);
    expect(recent[0].taskId).toBe("task-1");
  });

  it("should load stats from DB (survives restart)", async () => {
    await service.recordAttempt(tmpDir, makeRecord());

    // Create a new service instance to simulate restart
    const service2 = new AgentIdentityService();
    await service2.recordAttempt(tmpDir, makeRecord({ attempt: 2 }));

    const recent = await service2.getRecentAttempts(tmpDir, "task-1");
    expect(recent).toHaveLength(2);
  });

  it("should build agent profile with aggregated stats", async () => {
    await service.recordAttempt(tmpDir, makeRecord({ outcome: "success", durationMs: 30000 }));
    await service.recordAttempt(
      tmpDir,
      makeRecord({ attempt: 2, outcome: "success", durationMs: 60000, taskId: "task-2" })
    );
    await service.recordAttempt(
      tmpDir,
      makeRecord({ attempt: 3, outcome: "test_failure", durationMs: 45000, taskId: "task-3" })
    );

    const profile = await service.getProfile(tmpDir, "claude-sonnet");
    expect(profile.stats.tasksAttempted).toBe(3);
    expect(profile.stats.tasksSucceeded).toBe(2);
    expect(profile.stats.tasksFailed).toBe(1);
    expect(profile.stats.avgTimeToComplete).toBe(45000); // (30000+60000)/2
    expect(profile.stats.failuresByType).toEqual({ test_failure: 1 });
  });

  it("should cap stored records at 500", async () => {
    for (let i = 0; i < 510; i++) {
      await service.recordAttempt(tmpDir, makeRecord({ attempt: i, taskId: `task-${i}` }));
    }

    const { taskStore } = await import("../services/task-store.service.js");
    const client = await taskStore.getDb();
    const row = await client.queryOne(
      "SELECT COUNT(*) as c FROM agent_stats WHERE project_id LIKE 'repo:%'"
    );
    const count = (row?.c as number) ?? 0;
    expect(count).toBeLessThanOrEqual(500);
  });

  describe("selectAgentForRetry", () => {
    const baseSettings = {
      simpleComplexityAgent: {
        type: "claude" as const,
        model: "claude-sonnet-4-20250514",
        cliCommand: null,
      },
      complexComplexityAgent: {
        type: "claude" as const,
        model: "claude-sonnet-4-20250514",
        cliCommand: null,
      },
      reviewMode: "always" as const,
      deployment: { mode: "custom" as const },
    };

    it("should use base config for first 2 attempts", () => {
      const config = service.selectAgentForRetry(
        baseSettings as unknown as ProjectSettings,
        "task-1",
        1,
        "test_failure",
        undefined,
        []
      );
      expect(config.model).toBe("claude-sonnet-4-20250514");

      const config2 = service.selectAgentForRetry(
        baseSettings as unknown as ProjectSettings,
        "task-1",
        2,
        "test_failure",
        undefined,
        []
      );
      expect(config2.model).toBe("claude-sonnet-4-20250514");
    });

    it("should escalate model on 3+ consecutive same-type failures", () => {
      const attempts: TaskAttemptRecord[] = [
        makeRecord({ attempt: 1, outcome: "test_failure" }),
        makeRecord({ attempt: 2, outcome: "test_failure" }),
        makeRecord({ attempt: 3, outcome: "test_failure" }),
      ];

      const config = service.selectAgentForRetry(
        baseSettings as unknown as ProjectSettings,
        "task-1",
        4,
        "test_failure",
        undefined,
        attempts
      );
      expect(config.model).toContain("opus");
    });

    it("should not escalate when failure types differ", () => {
      const attempts: TaskAttemptRecord[] = [
        makeRecord({ attempt: 1, outcome: "test_failure" }),
        makeRecord({ attempt: 2, outcome: "review_rejection" }),
        makeRecord({ attempt: 3, outcome: "test_failure" }),
      ];

      const config = service.selectAgentForRetry(
        baseSettings as unknown as ProjectSettings,
        "task-1",
        4,
        "test_failure",
        undefined,
        attempts
      );
      // Last consecutive same-type count is 1 (only the most recent), so no escalation
      expect(config.model).toBe("claude-sonnet-4-20250514");
    });

    it("retry with high complexity uses complexComplexityAgent as the base config", () => {
      const settingsWithDifferentAgents = {
        simpleComplexityAgent: {
          type: "claude" as const,
          model: "claude-sonnet-4-20250514",
          cliCommand: null,
        },
        complexComplexityAgent: {
          type: "claude" as const,
          model: "claude-opus-4-20250514",
          cliCommand: null,
        },
        reviewMode: "always" as const,
        deployment: { mode: "custom" as const },
      };

      const config = service.selectAgentForRetry(
        settingsWithDifferentAgents as unknown as ProjectSettings,
        "task-1",
        1,
        "test_failure",
        "high",
        []
      );
      expect(config.model).toBe("claude-opus-4-20250514");
    });

    it("retry with low complexity uses simpleComplexityAgent as the base config", () => {
      const settingsWithDifferentAgents = {
        simpleComplexityAgent: {
          type: "claude" as const,
          model: "claude-sonnet-4-20250514",
          cliCommand: null,
        },
        complexComplexityAgent: {
          type: "claude" as const,
          model: "claude-opus-4-20250514",
          cliCommand: null,
        },
        reviewMode: "always" as const,
        deployment: { mode: "custom" as const },
      };

      const config = service.selectAgentForRetry(
        settingsWithDifferentAgents as unknown as ProjectSettings,
        "task-1",
        1,
        "test_failure",
        "low",
        []
      );
      expect(config.model).toBe("claude-sonnet-4-20250514");
    });
  });
});
