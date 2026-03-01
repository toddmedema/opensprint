import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  computeLogDiff95thPercentile,
  truncateToThreshold,
  DEFAULT_LOG_DIFF_THRESHOLD,
} from "../log-diff-truncation.js";
import { createPostgresDbClientFromUrl, runSchema, toPgParams } from "../../db/index.js";
import type { DbClient } from "../../db/client.js";
import type { Pool } from "pg";
import { getTestDatabaseUrl } from "../../__tests__/test-db-helper.js";

describe("log-diff-truncation", () => {
  describe("truncateToThreshold", () => {
    it("returns value unchanged when within threshold", () => {
      expect(truncateToThreshold("short", 100)).toBe("short");
    });

    it("returns value unchanged when exactly at threshold", () => {
      const s = "a".repeat(50);
      expect(truncateToThreshold(s, 50)).toBe(s);
    });

    it("truncates and appends suffix when over threshold", () => {
      const s = "a".repeat(100);
      const suffix = "\n\n... [truncated]";
      const result = truncateToThreshold(s, 50);
      expect(result).toHaveLength(50 + suffix.length);
      expect(result!.endsWith(suffix)).toBe(true);
      expect(result!.slice(0, 50)).toBe("a".repeat(50));
    });

    it("returns null for null input", () => {
      expect(truncateToThreshold(null, 100)).toBeNull();
    });

    it("returns empty string unchanged", () => {
      expect(truncateToThreshold("", 100)).toBe("");
    });

    it("returns undefined as null", () => {
      expect(truncateToThreshold(undefined, 100)).toBeNull();
    });
  });

  describe("computeLogDiff95thPercentile", () => {
    let client: DbClient | null = null;
    let pool: Pool | null = null;

    beforeAll(async () => {
      try {
        const url = await getTestDatabaseUrl();
        const result = await createPostgresDbClientFromUrl(url);
        client = result.client;
        pool = result.pool;
        await runSchema(client);
        await client.query("DELETE FROM agent_sessions");
      } catch {
        client = null;
        pool = null;
      }
    });

    afterAll(async () => {
      if (pool) await pool.end();
    });

    it("returns default when table is empty", async () => {
      if (!client) return;
      await client.query("DELETE FROM agent_sessions");
      const threshold = await computeLogDiff95thPercentile(client);
      expect(threshold).toBe(DEFAULT_LOG_DIFF_THRESHOLD);
    });

    it("returns 95th percentile from output_log and git_diff sizes", async () => {
      if (!client) return;
      await client.query("DELETE FROM agent_sessions");
      const sql = toPgParams(
        `INSERT INTO agent_sessions (project_id, task_id, attempt, agent_type, agent_model, started_at, status, git_branch, output_log)
         VALUES (?, ?, ?, 'cursor', 'gpt-4', '2024-01-01', 'success', 'main', ?)`
      );
      for (let i = 0; i < 10; i++) {
        await client.execute(sql, ["proj", `task-${i}`, i + 1, "x".repeat(2000)]);
      }
      for (let i = 10; i < 20; i++) {
        await client.execute(sql, ["proj", `task-${i}`, i + 1, "x".repeat(5000)]);
      }
      const diffSql = toPgParams(
        `INSERT INTO agent_sessions (project_id, task_id, attempt, agent_type, agent_model, started_at, status, git_branch, git_diff)
         VALUES (?, ?, ?, 'cursor', 'gpt-4', '2024-01-01', 'success', 'main', ?)`
      );
      for (let i = 20; i < 25; i++) {
        await client.execute(diffSql, ["proj", `task-${i}`, i + 1, "y".repeat(3000)]);
      }
      for (let i = 25; i < 30; i++) {
        await client.execute(diffSql, ["proj", `task-${i}`, i + 1, "z".repeat(8000)]);
      }

      const threshold = await computeLogDiff95thPercentile(client);
      expect(threshold).toBe(8000);
    });

    it("enforces minimum threshold of 1024", async () => {
      if (!client) return;
      await client.query("DELETE FROM agent_sessions");
      await client.execute(
        toPgParams(
          `INSERT INTO agent_sessions (project_id, task_id, attempt, agent_type, agent_model, started_at, status, git_branch, output_log)
           VALUES ('p', 't', 1, 'cursor', 'gpt-4', '2024-01-01', 'success', 'main', ?)`
        ),
        ["x".repeat(50)]
      );

      const threshold = await computeLogDiff95thPercentile(client);
      expect(threshold).toBe(1024);
    });
  });
});
