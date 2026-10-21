/**
 * SQL-backed store for command_runs audit table.
 */

import { randomUUID } from "node:crypto";
import type {
  CommandRun,
  CommandStatus,
  CommandIntent,
  CommandRiskLevel,
  CommandPreview,
  CommandExecutionResult,
  CommandHistoryFilters,
} from "@opensprint/shared";
import { taskStore } from "./task-store.service.js";
import { AppError } from "../middleware/error-handler.js";

interface CommandRunRow {
  id: string;
  project_id: string;
  actor: string;
  raw_input: string;
  interpreted_command: string | null;
  risk_level: string | null;
  status: string;
  preview: string | null;
  result: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRun(row: CommandRunRow): CommandRun {
  return {
    id: row.id,
    project_id: row.project_id,
    actor: row.actor,
    raw_input: row.raw_input,
    interpreted_command: row.interpreted_command
      ? (JSON.parse(row.interpreted_command) as CommandIntent)
      : null,
    risk_level: (row.risk_level as CommandRiskLevel) ?? null,
    status: row.status as CommandStatus,
    preview: row.preview ? (JSON.parse(row.preview) as CommandPreview) : null,
    result: row.result ? (JSON.parse(row.result) as CommandExecutionResult) : null,
    idempotency_key: row.idempotency_key,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class CommandStoreService {
  /** Reserve execution before performing effects; interrupted execution is never retried blindly. */
  async claimExecution(
    projectId: string,
    id: string,
    expectedIntent: CommandIntent,
    idempotencyKey?: string
  ): Promise<CommandRun> {
    return taskStore.runWrite(async (tx) => {
      const changed = await tx.execute(
        `UPDATE command_runs SET status = 'executing',
        idempotency_key = $1, updated_at = $2 WHERE id = $3 AND project_id = $4
        AND status IN ('previewing', 'awaiting_confirmation') AND interpreted_command = $5`,
        [
          idempotencyKey ?? null,
          new Date().toISOString(),
          id,
          projectId,
          JSON.stringify(expectedIntent),
        ]
      );
      const row = await tx.queryOne(
        "SELECT * FROM command_runs WHERE id = $1 AND project_id = $2",
        [id, projectId]
      );
      if (!row) throw new AppError(404, "COMMAND_NOT_FOUND", "Command run not found.");
      const run = rowToRun(row as unknown as CommandRunRow);
      if (changed === 1) return run;
      if (run.result && (!idempotencyKey || run.idempotency_key === idempotencyKey)) return run;
      throw new AppError(
        409,
        "COMMAND_EXECUTION_CONFLICT",
        run.status === "executing"
          ? "Command execution is already accepted. Check its history before retrying."
          : "Command changed or is no longer awaiting confirmation. Preview it again."
      );
    });
  }
  async createRun(data: {
    project_id: string;
    actor: string;
    raw_input: string;
    status?: CommandStatus;
  }): Promise<CommandRun> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const status = data.status ?? "interpreting";

    await taskStore.runWrite(async (client) => {
      await client.execute(
        `INSERT INTO command_runs (
          id, project_id, actor, raw_input, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, data.project_id, data.actor, data.raw_input, status, now, now]
      );
    });

    return {
      id,
      project_id: data.project_id,
      actor: data.actor,
      raw_input: data.raw_input,
      interpreted_command: null,
      risk_level: null,
      status,
      preview: null,
      result: null,
      idempotency_key: null,
      created_at: now,
      updated_at: now,
    };
  }

  async updateInterpretation(
    id: string,
    intent: CommandIntent,
    riskLevel: CommandRiskLevel
  ): Promise<void> {
    const now = new Date().toISOString();
    await taskStore.runWrite(async (client) => {
      await client.execute(
        `UPDATE command_runs SET
          interpreted_command = $1, risk_level = $2, status = $3, updated_at = $4
        WHERE id = $5 AND status IN ('interpreting', 'previewing', 'awaiting_confirmation')`,
        [JSON.stringify(intent), riskLevel, "previewing", now, id]
      );
    });
  }

  async updatePreview(id: string, preview: CommandPreview): Promise<void> {
    const now = new Date().toISOString();
    await taskStore.runWrite(async (client) => {
      await client.execute(
        `UPDATE command_runs SET preview = $1, status = $2, updated_at = $3 WHERE id = $4
         AND status IN ('interpreting', 'previewing', 'awaiting_confirmation')`,
        [JSON.stringify(preview), "awaiting_confirmation", now, id]
      );
    });
  }

  async updateResult(
    id: string,
    result: CommandExecutionResult,
    idempotencyKey?: string
  ): Promise<void> {
    const now = new Date().toISOString();
    const status = result.success ? "completed" : "failed";
    await taskStore.runWrite(async (client) => {
      await client.execute(
        `UPDATE command_runs SET
          result = $1, status = $2, idempotency_key = COALESCE($3, idempotency_key),
          updated_at = $4
        WHERE id = $5`,
        [JSON.stringify(result), status, idempotencyKey ?? null, now, id]
      );
    });
  }

  async updateStatus(id: string, status: CommandStatus): Promise<void> {
    const now = new Date().toISOString();
    await taskStore.runWrite(async (client) => {
      await client.execute("UPDATE command_runs SET status = $1, updated_at = $2 WHERE id = $3", [
        status,
        now,
        id,
      ]);
    });
  }

  async getRun(id: string, projectId: string): Promise<CommandRun | null> {
    const client = await taskStore.getDb();
    const row = await client.queryOne(
      "SELECT * FROM command_runs WHERE id = $1 AND project_id = $2",
      [id, projectId]
    );
    return row ? rowToRun(row as unknown as CommandRunRow) : null;
  }

  async findByIdempotencyKey(
    key: string,
    projectId: string,
    runId: string
  ): Promise<CommandRun | null> {
    const client = await taskStore.getDb();
    const row = await client.queryOne(
      "SELECT * FROM command_runs WHERE idempotency_key = $1 AND project_id = $2 AND id = $3",
      [key, projectId, runId]
    );
    return row ? rowToRun(row as unknown as CommandRunRow) : null;
  }

  async listRuns(
    projectId: string,
    filters?: CommandHistoryFilters
  ): Promise<{ runs: CommandRun[]; total: number }> {
    const client = await taskStore.getDb();
    const conditions: string[] = ["project_id = $1"];
    const params: unknown[] = [projectId];
    let paramIdx = 2;

    if (filters?.status) {
      conditions.push(`status = $${paramIdx}`);
      params.push(filters.status);
      paramIdx++;
    }

    const where = conditions.join(" AND ");
    const countRow = await client.queryOne(
      `SELECT COUNT(*) as cnt FROM command_runs WHERE ${where}`,
      params
    );
    const total = Number((countRow as { cnt: number | string })?.cnt ?? 0);

    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;

    const rows = await client.query(
      `SELECT * FROM command_runs WHERE ${where}
       ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      [...params, limit, offset]
    );

    return {
      runs: (rows as unknown as CommandRunRow[]).map(rowToRun),
      total,
    };
  }
}

export const commandStore = new CommandStoreService();
