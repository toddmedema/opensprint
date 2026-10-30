/**
 * One-way migration: copy all data from current DB (typically SQLite) to a target PostgreSQL database.
 * Used by the "Upgrade to PostgreSQL" flow in Settings.
 */

import { getDatabaseDialect } from "@opensprint/shared";
import type { DbClient, DbRow } from "../db/client.js";
import { createPostgresDbClientFromUrl } from "../db/client.js";
import { runSchema } from "../db/schema.js";
import { initAppDb } from "../db/app-db.js";
import { GOVERNANCE_TABLES_IN_DEPENDENCY_ORDER } from "../db/governance-schema.js";

const TABLES = [
  "tasks",
  "task_dependencies",
  "feedback",
  "feedback_inbox",
  "agent_sessions",
  "agent_stats",
  "orchestrator_events",
  "orchestrator_counters",
  "deployments",
  "plans",
  "plan_execute_batches",
  "auditor_runs",
  "self_improvement_runs",
  "behavior_versions",
  "project_behavior_state",
  "open_questions",
  "prd_metadata",
  "project_conversations",
  "planning_runs",
  "agent_instructions",
  "project_workflows",
  "help_chat_histories",
  "repo_file_migrations",
  "worktree_leases",
  ...GOVERNANCE_TABLES_IN_DEPENDENCY_ORDER,
] as const;

/** Preserve IDs for durable replay/session references, then advance PostgreSQL sequences. */
const SERIAL_ID_TABLES = new Set([
  "agent_sessions",
  "agent_stats",
  "orchestrator_events",
  "auditor_runs",
  "self_improvement_runs",
]);

function getInsertColumns(row: DbRow): string[] {
  const cols = Object.keys(row).filter((k) => row[k] !== undefined);
  return cols;
}

function rowToValues(row: DbRow, columns: string[]): unknown[] {
  return columns.map((c) => row[c]);
}

/** Copy one consistent source snapshot, retaining policy authority and exact session identity. */
export async function copyDatabaseRows(
  sourceClient: DbClient,
  targetClient: DbClient
): Promise<void> {
  await sourceClient.runInTransaction(async (source) =>
    targetClient.runInTransaction(async (tx) => {
      for (const table of TABLES) {
        const rows = await source.query(`SELECT * FROM ${table}`);
        if (!rows.length) continue;
        const columns = getInsertColumns(rows[0]);
        if (!columns.length) continue;
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
        const sql = `INSERT INTO ${table} (${columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(", ")}) VALUES (${placeholders})`;
        for (const row of rows) await tx.execute(sql, rowToValues(row, columns));
      }
      for (const table of SERIAL_ID_TABLES) {
        await tx.execute(
          `SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), EXISTS(SELECT 1 FROM ${table}))`,
          [table]
        );
      }
    })
  );
}

export async function migrateSqliteToPostgres(sourceUrl: string, targetUrl: string): Promise<void> {
  const sourceDialect = getDatabaseDialect(sourceUrl);
  if (sourceDialect !== "sqlite") {
    throw new Error("Source must be SQLite");
  }
  if (getDatabaseDialect(targetUrl) !== "postgres") {
    throw new Error("Target must be PostgreSQL");
  }

  const sourceAppDb = await initAppDb(sourceUrl);
  const { client: targetClient, pool: targetPool } = await createPostgresDbClientFromUrl(targetUrl);

  try {
    await runSchema(targetClient, "postgres");

    const sourceClient = await sourceAppDb.getClient();

    await copyDatabaseRows(sourceClient, targetClient);
  } finally {
    await sourceAppDb.close();
    await targetPool.end();
  }
}
