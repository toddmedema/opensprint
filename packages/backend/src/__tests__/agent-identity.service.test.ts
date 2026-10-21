import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  AgentIdentityService,
  type TaskAttemptRecord,
} from "../services/agent-identity.service.js";
import type { ProjectSettings } from "@opensprint/shared";
import type { DbClient } from "../db/client.js";

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
      runRead: vi
        .fn()
        .mockImplementation(async (fn: (client: DbClient) => Promise<unknown>) =>
          fn(testClientRef.current!)
        ),
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

const agentIdentityTaskStoreMod = await import("../services/task-store.service.js");
const agentIdentityPostgresOk =
  (agentIdentityTaskStoreMod as { _postgresAvailable?: boolean })._postgresAvailable ?? false;

describe.skipIf(!agentIdentityPostgresOk)("AgentIdentityService", () => {
  let tmpDir: string;
  let service: AgentIdentityService;

  beforeEach(async () => {
    if (!testClientRef.current) throw new Error("Postgres required");
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

  it("updates an existing attempt row when completion is recorded after start", async () => {
    await service.recordAttemptStarted(tmpDir, {
      taskId: "task-1",
      agentId: "cursor-default",
      role: "coder",
      model: "composer-2",
      attempt: 3,
      startedAt: "2025-01-01T00:03:00.000Z",
    });
    await service.recordAttempt(
      tmpDir,
      makeRecord({
        attempt: 3,
        role: "coder",
        agentId: "cursor-default",
        model: "composer-2",
        startedAt: "2025-01-01T00:03:00.000Z",
        completedAt: "2025-01-01T00:04:30.000Z",
        durationMs: 90000,
        outcome: "success",
      })
    );

    const recent = await service.getRecentAttempts(tmpDir, "task-1");
    const attempt3 = recent.find((record) => record.attempt === 3);
    expect(attempt3).toBeDefined();
    expect(attempt3?.outcome).toBe("success");
    expect(attempt3?.durationMs).toBe(90000);
    expect(recent.filter((record) => record.attempt === 3)).toHaveLength(1);
  });

  it("keeps separate rows for different agents in the same attempt", async () => {
    await service.recordAttemptStarted(tmpDir, {
      taskId: "task-1",
      agentId: "cursor-review-general",
      role: "reviewer",
      model: "composer-2",
      attempt: 4,
      startedAt: "2025-01-01T00:05:00.000Z",
    });
    await service.recordAttemptStarted(tmpDir, {
      taskId: "task-1",
      agentId: "cursor-review-security",
      role: "reviewer",
      model: "composer-2",
      attempt: 4,
      startedAt: "2025-01-01T00:05:30.000Z",
    });

    await service.recordAttempt(
      tmpDir,
      makeRecord({
        taskId: "task-1",
        attempt: 4,
        role: "reviewer",
        agentId: "cursor-review-security",
        model: "composer-2",
        startedAt: "2025-01-01T00:05:30.000Z",
        completedAt: "2025-01-01T00:06:30.000Z",
        durationMs: 60000,
        outcome: "success",
      })
    );

    const recent = await service.getRecentAttempts(tmpDir, "task-1");
    const attempt4 = recent.filter((record) => record.attempt === 4);
    expect(attempt4).toHaveLength(2);
    expect(attempt4.filter((record) => record.agentId === "cursor-review-general")).toHaveLength(1);
    expect(attempt4.filter((record) => record.agentId === "cursor-review-security")).toHaveLength(
      1
    );
    expect(attempt4.find((record) => record.agentId === "cursor-review-security")?.outcome).toBe(
      "success"
    );
    expect(attempt4.find((record) => record.agentId === "cursor-review-general")?.outcome).toBe(
      "no_result"
    );
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
    const { taskStore } = await import("../services/task-store.service.js");
    const client = await taskStore.getDb();
    const projectId =
      "repo:" + crypto.createHash("sha256").update(tmpDir).digest("hex").slice(0, 12);

    await client.execute(
      `INSERT INTO agent_stats (
         project_id,
         task_id,
         agent_id,
         role,
         model,
         attempt,
         started_at,
         completed_at,
         outcome,
         duration_ms
       )
       SELECT
         $1,
         'task-' || seq::text,
         'claude-sonnet',
         NULL,
         'claude-sonnet-4-20250514',
         seq,
         '2025-01-01T00:00:00.000Z',
         '2025-01-01T00:01:00.000Z',
         'success',
         60000
       FROM generate_series(0, 499) AS seq`,
      [projectId]
    );

    await service.recordAttempt(tmpDir, makeRecord({ attempt: 500, taskId: "task-500" }));

    const row = await client.queryOne(
      "SELECT COUNT(*)::int as c FROM agent_stats WHERE project_id = $1",
      [projectId]
    );
    const count = Number(row?.c ?? 0);
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
