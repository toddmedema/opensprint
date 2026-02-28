import crypto from "crypto";
import pg from "pg";
import type { Pool } from "pg";
import type { TaskType, TaskPriority } from "@opensprint/shared";
import { clampTaskComplexity } from "@opensprint/shared";
import {
  isAgentAssignee,
  isBlockedByTechnicalError,
  AUTO_RETRY_BLOCKED_INTERVAL_MS,
} from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { createLogger } from "../utils/logger.js";
import type { DbClient } from "../db/client.js";
import { createPostgresDbClient } from "../db/client.js";
import { SCHEMA_SQL, runSchema } from "../db/schema.js";
import { toPgParams } from "../db/sql-params.js";
import { getDatabaseUrl } from "./global-settings.service.js";

const log = createLogger("task-store");

/** Re-export for consumers that import SCHEMA_SQL from task-store. */
export { SCHEMA_SQL };

export interface StoredTask {
  id: string;
  project_id?: string;
  title: string;
  description?: string;
  issue_type: string;
  status: string;
  priority: number;
  assignee?: string | null;
  owner?: string | null;
  labels?: string[];
  created_at: string;
  updated_at: string;
  created_by?: string;
  close_reason?: string;
  /** Set when first Coder agent picks up task (assignee set). */
  started_at?: string | null;
  /** Set when task is closed. */
  completed_at?: string | null;
  dependencies?: Array<{
    depends_on_id: string;
    type: string;
  }>;
  dependency_count?: number;
  dependent_count?: number;
  /** Reason task was blocked (e.g. Coding Failure, Merge Failure). Stored in extra when status is blocked. */
  block_reason?: string | null;
  /** ISO timestamp of last auto-retry (technical-error unblock). Stored in extra. */
  last_auto_retry_at?: string | null;
  [key: string]: unknown;
}

export interface CreateOpts {
  type?: TaskType | string;
  priority?: TaskPriority | number;
  description?: string;
  parentId?: string;
  /** Task-level complexity (1-10). Persisted in complexity column. */
  complexity?: number;
  /** Merge into extra JSON (e.g. sourceFeedbackIds) */
  extra?: Record<string, unknown>;
}

export interface CreateInput {
  title: string;
  type?: TaskType | string;
  priority?: TaskPriority | number;
  description?: string;
  parentId?: string;
  /** Task-level complexity (1-10). Persisted in complexity column. */
  complexity?: number;
}

/** Plan row returned from plans table (metadata is JSON string; parse as PlanMetadata). */
export interface StoredPlan {
  project_id: string;
  plan_id: string;
  epic_id: string;
  gate_task_id: string | null;
  re_execute_gate_task_id: string | null;
  content: string;
  metadata: string;
  shipped_content: string | null;
  updated_at: string;
}

export interface PlanInsertData {
  epic_id: string;
  gate_task_id?: string | null;
  re_execute_gate_task_id?: string | null;
  content: string;
  metadata?: string | null;
}

/** Callback invoked when a task is created, updated, or closed. Used to emit WebSocket events. */
export type TaskChangeCallback = (
  projectId: string,
  changeType: "create" | "update" | "close",
  task: StoredTask
) => void;

export class TaskStoreService {
  private client: DbClient | null = null;
  private pool: Pool | null = null;
  private writeLock: Promise<void> = Promise.resolve();
  private injectedClient: DbClient | null = null;
  /** Serializes init so only one run runs at a time; concurrent callers await the same promise. */
  private initPromise: Promise<void> | null = null;
  /** Optional callback to emit WebSocket events on task create/update/close. */
  private onTaskChange: TaskChangeCallback | null = null;

  constructor(injectedClient?: DbClient) {
    if (injectedClient) {
      this.injectedClient = injectedClient;
    }
  }

  /** Register callback to emit WebSocket events on task create/update/close. */
  setOnTaskChange(cb: TaskChangeCallback | null): void {
    this.onTaskChange = cb;
  }

  private emitTaskChange(projectId: string, changeType: "create" | "update" | "close", task: StoredTask): void {
    this.onTaskChange?.(projectId, changeType, task);
  }

  async init(_repoPath?: string): Promise<void> {
    if (this.client) return;

    if (this.injectedClient) {
      this.client = this.injectedClient;
      // Caller is responsible for schema when using injected client (e.g. tests)
      return;
    }

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.runInitInternal();
    try {
      await this.initPromise;
    } catch (err) {
      this.initPromise = null;
      throw new AppError(
        500,
        ErrorCodes.TASK_STORE_INIT_FAILED,
        `Failed to initialize task store: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private async runInitInternal(): Promise<void> {
    const databaseUrl = await getDatabaseUrl();
    const pool = new pg.Pool({ connectionString: databaseUrl });
    this.pool = pool;
    this.client = createPostgresDbClient(pool);

    await runSchema(this.client);
    await this.migrateTaskDurationColumns();
    await this.migrateTaskComplexityColumn();
    await this.migrateOpenQuestionsKind();
    await this.migratePlansWithGateTasks();
    log.info("Task store initialized with Postgres");
  }

  /** Migration: Add started_at and completed_at columns (information_schema check). */
  private async migrateTaskDurationColumns(): Promise<void> {
    const client = this.ensureClient();
    const rows = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name IN ('started_at', 'completed_at')"
    );
    const existing = new Set(rows.map((r) => r.column_name as string));
    if (!existing.has("started_at")) {
      await client.execute("ALTER TABLE tasks ADD COLUMN started_at TEXT");
      log.info("Added started_at column to tasks");
    }
    if (!existing.has("completed_at")) {
      await client.execute("ALTER TABLE tasks ADD COLUMN completed_at TEXT");
      log.info("Added completed_at column to tasks");
    }
  }

  /** Migration: Add complexity column (information_schema check). */
  private async migrateTaskComplexityColumn(): Promise<void> {
    const client = this.ensureClient();
    const rows = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tasks' AND column_name = 'complexity'"
    );
    if (rows.length === 0) {
      await client.execute("ALTER TABLE tasks ADD COLUMN complexity INTEGER");
      log.info("Added complexity column to tasks");
    }
  }

  /** Migration: Add kind and error_code to open_questions (information_schema check). */
  private async migrateOpenQuestionsKind(): Promise<void> {
    const client = this.ensureClient();
    const rows = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'open_questions' AND column_name IN ('kind', 'error_code')"
    );
    const existing = new Set(rows.map((r) => r.column_name as string));
    if (!existing.has("kind")) {
      await client.execute("ALTER TABLE open_questions ADD COLUMN kind TEXT NOT NULL DEFAULT 'open_question'");
      log.info("Added kind column to open_questions");
    }
    if (!existing.has("error_code")) {
      await client.execute("ALTER TABLE open_questions ADD COLUMN error_code TEXT");
      log.info("Added error_code column to open_questions");
    }
  }

  /** Migration: Epic-blocked model. Plans with gate_task_id migrated to remove gate tasks. */
  private async migratePlansWithGateTasks(): Promise<void> {
    if (this.injectedClient) return;
    const client = this.ensureClient();
    const rows = await client.query(
      "SELECT project_id, plan_id, epic_id, gate_task_id, re_execute_gate_task_id FROM plans WHERE (gate_task_id IS NOT NULL AND gate_task_id != '') OR (re_execute_gate_task_id IS NOT NULL AND re_execute_gate_task_id != '')"
    );
    if (rows.length === 0) return;

    const planRows = rows.map((r) => ({
      project_id: r.project_id as string,
      plan_id: r.plan_id as string,
      epic_id: r.epic_id as string,
      gate_task_id: (r.gate_task_id as string) || null,
      re_execute_gate_task_id: (r.re_execute_gate_task_id as string) || null,
    }));

    const gateIds = new Set<string>();
    for (const r of planRows) {
      if (r.gate_task_id) gateIds.add(r.gate_task_id);
      if (r.re_execute_gate_task_id) gateIds.add(r.re_execute_gate_task_id);
    }

    for (const r of planRows) {
      const epicId = r.epic_id;
      if (!epicId) continue;
      let epicStatus: "open" | "blocked" = "blocked";
      for (const gateId of [r.gate_task_id, r.re_execute_gate_task_id]) {
        if (!gateId) continue;
        try {
          const gateTask = await this.show(r.project_id, gateId);
          if ((gateTask.status as string) === "closed") epicStatus = "open";
        } catch {
          // Gate task missing — treat as not approved
        }
      }
      await client.execute(toPgParams("UPDATE tasks SET status = ? WHERE id = ? AND project_id = ?"), [
        epicStatus,
        epicId,
        r.project_id,
      ]);
    }

    for (const gateId of gateIds) {
      const planRow = planRows.find(
        (r) => r.gate_task_id === gateId || r.re_execute_gate_task_id === gateId
      );
      if (!planRow) continue;
      await client.execute(toPgParams("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?"), [
        gateId,
        gateId,
      ]);
      await client.execute(toPgParams("DELETE FROM tasks WHERE id = ? AND project_id = ?"), [
        gateId,
        planRow.project_id,
      ]);
    }

    for (const r of planRows) {
      await client.execute(
        toPgParams(
          "UPDATE plans SET gate_task_id = NULL, re_execute_gate_task_id = NULL WHERE project_id = ? AND plan_id = ?"
        ),
        [r.project_id, r.plan_id]
      );
    }
    log.info("Migrated plans with gate tasks to epic-blocked model", { count: planRows.length });
  }

  protected ensureClient(): DbClient {
    if (!this.client) {
      throw new AppError(
        500,
        ErrorCodes.TASK_STORE_INIT_FAILED,
        "Task store not initialized. Call init() first."
      );
    }
    return this.client;
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.writeLock;
    let release: () => void;
    this.writeLock = new Promise<void>((r) => {
      release = r;
    });
    try {
      await prev;
      return await fn();
    } finally {
      release!();
    }
  }

  private async loadDepsMapsForProject(projectId: string): Promise<{
    depsByTaskId: Map<string, Array<{ depends_on_id: string; type: string }>>;
    dependentCountByTaskId: Map<string, number>;
  }> {
    const client = this.ensureClient();
    const depsByTaskId = new Map<string, Array<{ depends_on_id: string; type: string }>>();
    const dependentCountByTaskId = new Map<string, number>();

    const depRows = await client.query(
      toPgParams(
        "SELECT task_id, depends_on_id, dep_type FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)"
      ),
      [projectId]
    );
    for (const row of depRows) {
      const taskId = row.task_id as string;
      let arr = depsByTaskId.get(taskId);
      if (!arr) {
        arr = [];
        depsByTaskId.set(taskId, arr);
      }
      arr.push({
        depends_on_id: row.depends_on_id as string,
        type: row.dep_type as string,
      });
    }

    const countRows = await client.query(
      toPgParams(
        "SELECT depends_on_id, COUNT(*)::int as cnt FROM task_dependencies WHERE depends_on_id IN (SELECT id FROM tasks WHERE project_id = ?) GROUP BY depends_on_id"
      ),
      [projectId]
    );
    for (const row of countRows) {
      dependentCountByTaskId.set(row.depends_on_id as string, (row.cnt as number) ?? 0);
    }

    return { depsByTaskId, dependentCountByTaskId };
  }

  private hydrateTask(
    row: Record<string, unknown>,
    depsByTaskId?: Map<string, Array<{ depends_on_id: string; type: string }>>,
    dependentCountByTaskId?: Map<string, number>
  ): StoredTask {
    const labels: string[] = JSON.parse((row.labels as string) || "[]");
    const extra: Record<string, unknown> = JSON.parse((row.extra as string) || "{}");

    let deps: Array<{ depends_on_id: string; type: string }>;
    let dependentCount: number;

    if (depsByTaskId != null && dependentCountByTaskId != null) {
      deps = depsByTaskId.get(row.id as string) ?? [];
      dependentCount = dependentCountByTaskId.get(row.id as string) ?? 0;
    } else {
      deps = [];
      dependentCount = 0;
    }

    const blockReason = (extra.block_reason as string) ?? null;
    const lastAutoRetryAt = (extra.last_auto_retry_at as string) ?? null;
    const complexity = clampTaskComplexity(row.complexity);
    return {
      ...extra,
      ...(complexity != null && { complexity }),
      block_reason: blockReason,
      last_auto_retry_at: lastAutoRetryAt,
      id: row.id as string,
      project_id: row.project_id as string | undefined,
      title: row.title as string,
      description: (row.description as string) ?? undefined,
      issue_type: row.issue_type as string,
      status: row.status as string,
      priority: row.priority as number,
      assignee: (row.assignee as string) ?? null,
      owner: (row.owner as string) ?? null,
      labels,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      created_by: (row.created_by as string) ?? undefined,
      close_reason: (row.close_reason as string) ?? undefined,
      started_at: (row.started_at as string) ?? null,
      completed_at: (row.completed_at as string) ?? null,
      dependencies: deps,
      dependency_count: deps.length,
      dependent_count: dependentCount,
    };
  }

  private async hydrateTaskWithDeps(row: Record<string, unknown>): Promise<StoredTask> {
    const client = this.ensureClient();
    const deps = await client.query(
      toPgParams("SELECT depends_on_id, dep_type FROM task_dependencies WHERE task_id = ?"),
      [row.id]
    );
    const depCountRow = await client.queryOne(
      toPgParams("SELECT COUNT(*)::int as cnt FROM task_dependencies WHERE depends_on_id = ?"),
      [row.id]
    );
    const dependentCount = (depCountRow?.cnt as number) ?? 0;
    return this.hydrateTask(
      row,
      new Map([[row.id as string, deps.map((d) => ({ depends_on_id: d.depends_on_id as string, type: d.dep_type as string }))]]),
      new Map([[row.id as string, dependentCount]])
    );
  }

  private async execAndHydrateWithDeps(
    projectId: string,
    sql: string,
    params?: unknown[]
  ): Promise<StoredTask[]> {
    const client = this.ensureClient();
    const rows = await client.query(toPgParams(sql), params ?? []);
    if (rows.length === 0) return [];
    const { depsByTaskId, dependentCountByTaskId } = await this.loadDepsMapsForProject(projectId);
    return rows.map((row) =>
      this.hydrateTask(row as Record<string, unknown>, depsByTaskId, dependentCountByTaskId)
    );
  }

  private async execAndHydrate(sql: string, params?: unknown[]): Promise<StoredTask[]> {
    const client = this.ensureClient();
    const rows = await client.query(toPgParams(sql), params ?? []);
    const results: StoredTask[] = [];
    for (const row of rows) {
      results.push(await this.hydrateTaskWithDeps(row as Record<string, unknown>));
    }
    return results;
  }

  private async generateId(projectId: string, parentId?: string): Promise<string> {
    const client = this.ensureClient();
    if (parentId) {
      const rows = await client.query(
        toPgParams("SELECT id FROM tasks WHERE id LIKE $1 AND project_id = $2 ORDER BY id"),
        [`${parentId}.%`, projectId]
      );
      let maxSeq = 0;
      for (const row of rows) {
        const childId = row.id as string;
        const suffix = childId.slice(parentId.length + 1);
        const seq = parseInt(suffix.split(".")[0], 10);
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
      }
      return `${parentId}.${maxSeq + 1}`;
    }
    const hex = crypto.randomBytes(2).toString("hex");
    return `os-${hex}`;
  }

  // ──── Read methods ────

  async show(projectId: string, id: string): Promise<StoredTask> {
    const client = this.ensureClient();
    const row = await client.queryOne(
      toPgParams("SELECT * FROM tasks WHERE id = ? AND project_id = ?"),
      [id, projectId]
    );
    if (!row) {
      throw new AppError(404, ErrorCodes.ISSUE_NOT_FOUND, `Task ${id} not found`, { issueId: id });
    }
    return this.hydrateTaskWithDeps(row as Record<string, unknown>);
  }

  async listAll(projectId: string): Promise<StoredTask[]> {
    await this.ensureInitialized();
    return this.execAndHydrateWithDeps(
      projectId,
      "SELECT * FROM tasks WHERE project_id = ? ORDER BY priority ASC, created_at ASC",
      [projectId]
    );
  }

  async list(projectId: string): Promise<StoredTask[]> {
    await this.ensureInitialized();
    return this.execAndHydrateWithDeps(
      projectId,
      "SELECT * FROM tasks WHERE project_id = ? AND status IN ('open', 'in_progress') ORDER BY priority ASC, created_at ASC",
      [projectId]
    );
  }

  async listInProgressWithAgentAssignee(projectId: string): Promise<StoredTask[]> {
    const all = await this.list(projectId);
    return all.filter((t) => t.status === "in_progress" && isAgentAssignee(t.assignee));
  }

  /**
   * List tasks blocked by technical errors (Merge Failure, Coding Failure) that are eligible
   * for auto-retry. Excludes human-feedback blocks. Only returns tasks whose last_auto_retry_at
   * is null or older than AUTO_RETRY_BLOCKED_INTERVAL_MS (8 hours).
   */
  async listBlockedByTechnicalErrorEligibleForRetry(
    projectId: string
  ): Promise<StoredTask[]> {
    await this.ensureInitialized();
    const blocked = await this.execAndHydrateWithDeps(
      projectId,
      "SELECT * FROM tasks WHERE project_id = ? AND status = ? ORDER BY priority ASC, created_at ASC",
      [projectId, "blocked"]
    );
    const now = Date.now();
    const cutoff = now - AUTO_RETRY_BLOCKED_INTERVAL_MS;
    return blocked.filter((t) => {
      if (!isBlockedByTechnicalError(t.block_reason)) return false;
      const lastRetry = t.last_auto_retry_at;
      if (!lastRetry) return true;
      const lastRetryMs = new Date(lastRetry).getTime();
      return !isNaN(lastRetryMs) && lastRetryMs <= cutoff;
    });
  }

  getBlockersFromIssue(issue: StoredTask): string[] {
    const deps = issue.dependencies ?? [];
    return deps
      .filter((d) => (d.type ?? (d as Record<string, unknown>).dependency_type) === "blocks")
      .map(
        (d) =>
          d.depends_on_id ??
          (d as Record<string, unknown>).issue_id ??
          (d as Record<string, unknown>).id ??
          ""
      )
      .filter((x): x is string => !!x);
  }

  async readyWithStatusMap(
    projectId: string
  ): Promise<{ tasks: StoredTask[]; statusMap: Map<string, string> }> {
    const allIssues = await this.listAll(projectId);
    const statusMap = new Map(allIssues.map((i) => [i.id, i.status]));

    const filtered: StoredTask[] = [];
    for (const issue of allIssues) {
      if (issue.status !== "open") continue;
      if (issue.issue_type === "epic") continue;

      // Exclude tasks in blocked epic (walk up to find epic parent)
      const epicId = this.getPlanEpicId(issue, allIssues);
      if (epicId) {
        const epicStatus = statusMap.get(epicId);
        if (epicStatus === "blocked") continue;
      }

      const blockers = this.getBlockersFromIssue(issue);
      const allBlockersClosed =
        blockers.length === 0 || blockers.every((bid) => statusMap.get(bid) === "closed");
      if (allBlockersClosed) {
        filtered.push(issue);
      }
    }

    filtered.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    return { tasks: filtered, statusMap };
  }

  async ready(projectId: string): Promise<StoredTask[]> {
    const { tasks } = await this.readyWithStatusMap(projectId);
    return tasks;
  }

  async getStatusMap(projectId: string): Promise<Map<string, string>> {
    await this.ensureInitialized();
    const allIssues = await this.listAll(projectId);
    return new Map(allIssues.map((i) => [i.id, i.status]));
  }

  async areAllBlockersClosed(
    projectId: string,
    taskId: string,
    statusMap?: Map<string, string>
  ): Promise<boolean> {
    const blockers = await this.getBlockers(projectId, taskId);
    if (blockers.length === 0) return true;
    const map = statusMap ?? (await this.getStatusMap(projectId));
    return blockers.every((bid) => map.get(bid) === "closed");
  }

  async getBlockers(projectId: string, id: string): Promise<string[]> {
    await this.ensureInitialized();
    try {
      const issue = await this.show(projectId, id);
      return this.getBlockersFromIssue(issue);
    } catch {
      return [];
    }
  }

  getParentId(taskId: string): string | null {
    const lastDot = taskId.lastIndexOf(".");
    if (lastDot <= 0) return null;
    return taskId.slice(0, lastDot);
  }

  /** Find plan epic by walking up parent chain (epic.1.2 -> epic.1 -> epic). */
  private getPlanEpicId(issue: StoredTask, allIssues: StoredTask[]): string | null {
    let parentId = this.getParentId(issue.id ?? "");
    while (parentId) {
      const parent = allIssues.find((i) => i.id === parentId);
      if (parent && (parent.issue_type ?? parent.type) === "epic") {
        return parentId;
      }
      parentId = this.getParentId(parentId);
    }
    return null;
  }

  // ──── Write methods (mutex + save) ────

  async create(projectId: string, title: string, options: CreateOpts = {}): Promise<StoredTask> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      const id = await this.generateId(projectId, options.parentId);
      const now = new Date().toISOString();
      const type = (options.type as string) ?? "task";
      const priority = options.priority ?? 2;
      const complexity = clampTaskComplexity(options.complexity);
      const baseExtra: Record<string, unknown> = { ...options.extra };
      const extra = JSON.stringify(baseExtra);

      await client.execute(
        toPgParams(
          `INSERT INTO tasks (id, project_id, title, description, issue_type, status, priority, assignee, labels, created_at, updated_at, complexity, extra)
           VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, '[]', ?, ?, ?, ?)`
        ),
        [id, projectId, title, options.description ?? null, type, priority, now, now, complexity ?? null, extra]
      );

      if (options.parentId) {
        await client.execute(
          toPgParams(
            "INSERT INTO task_dependencies (task_id, depends_on_id, dep_type) VALUES (?, ?, 'parent-child') ON CONFLICT (task_id, depends_on_id) DO NOTHING"
          ),
          [id, options.parentId]
        );
      }

      const task = await this.show(projectId, id);
      this.emitTaskChange(projectId, "create", task);
      return task;
    });
  }

  private isDuplicateKeyError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /unique constraint|already exists|duplicate/i.test(msg);
  }

  async createWithRetry(
    projectId: string,
    title: string,
    options: CreateOpts = {},
    opts?: { fallbackToStandalone?: boolean }
  ): Promise<StoredTask | null> {
    const MAX_RETRIES = 3;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.create(projectId, title, options);
      } catch (err: unknown) {
        lastError = err;
        if (!this.isDuplicateKeyError(err)) throw err;
        log.warn("Duplicate key on create, retrying", {
          title,
          attempt: attempt + 1,
        });
      }
    }

    if (opts?.fallbackToStandalone && options.parentId) {
      try {
        const { parentId: _p, ...rest } = options;
        await this.create(projectId, title, rest);
        return null;
      } catch {
        return null;
      }
    }

    throw lastError;
  }

  async createMany(projectId: string, inputs: CreateInput[]): Promise<StoredTask[]> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      const ids: string[] = [];
      const parentIdToNextSeq = new Map<string, number>();
      for (const input of inputs) {
        const parentId = input.parentId;
        if (!parentId) {
          ids.push(await this.generateId(projectId, undefined));
          continue;
        }
        let next = parentIdToNextSeq.get(parentId);
        if (next === undefined) {
          const rows = await client.query(
            toPgParams("SELECT id FROM tasks WHERE id LIKE $1 AND project_id = $2 ORDER BY id"),
            [`${parentId}.%`, projectId]
          );
          let maxSeq = 0;
          for (const row of rows) {
            const childId = row.id as string;
            const suffix = childId.slice(parentId.length + 1);
            const seq = parseInt(suffix.split(".")[0], 10);
            if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
          }
          next = maxSeq + 1;
        }
        parentIdToNextSeq.set(parentId, next + 1);
        ids.push(`${parentId}.${next}`);
      }
      await client.runInTransaction(async (tx) => {
        const now = new Date().toISOString();
        for (let i = 0; i < inputs.length; i++) {
          const input = inputs[i]!;
          const id = ids[i]!;
          const type = (input.type as string) ?? "task";
          const priority = input.priority ?? 2;
          const complexity = clampTaskComplexity(input.complexity);

          await tx.execute(
            toPgParams(
              `INSERT INTO tasks (id, project_id, title, description, issue_type, status, priority, assignee, labels, created_at, updated_at, complexity, extra)
               VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, '[]', ?, ?, ?, ?)`
            ),
            [id, projectId, input.title, input.description ?? null, type, priority, now, now, complexity ?? null, "{}"]
          );

          if (input.parentId) {
            await tx.execute(
              toPgParams(
                "INSERT INTO task_dependencies (task_id, depends_on_id, dep_type) VALUES (?, ?, 'parent-child') ON CONFLICT (task_id, depends_on_id) DO NOTHING"
              ),
              [id, input.parentId]
            );
          }
        }
      });
      const tasks: StoredTask[] = [];
      for (const id of ids) {
        tasks.push(await this.show(projectId, id));
      }
      for (const task of tasks) {
        this.emitTaskChange(projectId, "create", task);
      }
      return tasks;
    });
  }

  async update(
    projectId: string,
    id: string,
    options: {
      title?: string;
      status?: string;
      assignee?: string;
      description?: string;
      priority?: number;
      claim?: boolean;
      /** Merge into extra JSON (e.g. sourceFeedbackIds) */
      extra?: Record<string, unknown>;
      /** Task-level complexity (1-10). Stored in complexity column. */
      complexity?: number;
      /** Reason task was blocked. Persisted when status becomes blocked; cleared when unblocked. */
      block_reason?: string | null;
      /** ISO timestamp of last auto-retry. Stored in extra. */
      last_auto_retry_at?: string | null;
    } = {}
  ): Promise<StoredTask> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      const now = new Date().toISOString();
      const sets: string[] = ["updated_at = $1"];
      const vals: unknown[] = [now];
      let paramIdx = 2;

      if (options.title != null) {
        sets.push(`title = $${paramIdx++}`);
        vals.push(options.title);
      }
      if (options.claim) {
        sets.push("status = $" + paramIdx++);
        vals.push("in_progress");
        if (options.assignee != null) {
          sets.push("assignee = $" + paramIdx++);
          vals.push(options.assignee);
        }
      } else {
        if (options.status != null) {
          sets.push("status = $" + paramIdx++);
          vals.push(options.status);
        }
        if (options.assignee != null) {
          sets.push("assignee = $" + paramIdx++);
          vals.push(options.assignee);
        }
      }

      const assigneeBeingSet =
        options.assignee != null && options.assignee.trim() !== "";
      if (assigneeBeingSet) {
        const row = await client.queryOne(
          toPgParams("SELECT started_at FROM tasks WHERE id = ? AND project_id = ?"),
          [id, projectId]
        );
        if (row) {
          const currentStartedAt = row.started_at as string | null | undefined;
          if (currentStartedAt == null || currentStartedAt === "") {
            sets.push(`started_at = $${paramIdx++}`);
            vals.push(now);
          }
        }
      }

      if (options.description != null) {
        sets.push(`description = $${paramIdx++}`);
        vals.push(options.description);
      }
      if (options.priority != null) {
        sets.push(`priority = $${paramIdx++}`);
        vals.push(options.priority);
      }
      if (options.complexity !== undefined) {
        const c = clampTaskComplexity(options.complexity);
        sets.push(`complexity = $${paramIdx++}`);
        vals.push(c ?? null);
      }

      if (
        options.extra != null ||
        options.block_reason !== undefined ||
        options.last_auto_retry_at !== undefined
      ) {
        const row = await client.queryOne(
          toPgParams("SELECT extra FROM tasks WHERE id = ? AND project_id = ?"),
          [id, projectId]
        );
        if (row) {
          const existing: Record<string, unknown> = JSON.parse(
            (row.extra as string) || "{}"
          ) as Record<string, unknown>;
          const merged: Record<string, unknown> = {
            ...existing,
            ...options.extra,
          };
          if (options.block_reason !== undefined) {
            if (options.block_reason == null || options.block_reason === "") {
              delete merged.block_reason;
            } else {
              merged.block_reason = options.block_reason;
            }
          }
          if (options.last_auto_retry_at !== undefined) {
            if (options.last_auto_retry_at == null || options.last_auto_retry_at === "") {
              delete merged.last_auto_retry_at;
            } else {
              merged.last_auto_retry_at = options.last_auto_retry_at;
            }
          }
          sets.push(`extra = $${paramIdx++}`);
          vals.push(JSON.stringify(merged));
        }
      }

      vals.push(id, projectId);
      const updateSql = `UPDATE tasks SET ${sets.join(", ")} WHERE id = $${paramIdx++} AND project_id = $${paramIdx}`;
      const modified = await client.execute(updateSql, vals);
      if (modified === 0) {
        throw new AppError(404, ErrorCodes.ISSUE_NOT_FOUND, `Task ${id} not found`, {
          issueId: id,
        });
      }
      const task = await this.show(projectId, id);
      this.emitTaskChange(projectId, "update", task);
      return task;
    });
  }

  async updateMany(
    projectId: string,
    updates: Array<{
      id: string;
      status?: string;
      assignee?: string;
      description?: string;
      priority?: number;
    }>
  ): Promise<StoredTask[]> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      await client.runInTransaction(async (tx) => {
        for (const u of updates) {
          const now = new Date().toISOString();
          const sets: string[] = ["updated_at = $1"];
          const vals: unknown[] = [now];
          let paramIdx = 2;
          if (u.status != null) {
            sets.push(`status = $${paramIdx++}`);
            vals.push(u.status);
          }
          if (u.assignee != null) {
            sets.push(`assignee = $${paramIdx++}`);
            vals.push(u.assignee);
            if (u.assignee.trim() !== "") {
              const row = await tx.queryOne(
                toPgParams("SELECT started_at FROM tasks WHERE id = ? AND project_id = ?"),
                [u.id, projectId]
              );
              if (row) {
                const currentStartedAt = row.started_at as string | null | undefined;
                if (currentStartedAt == null || currentStartedAt === "") {
                  sets.push(`started_at = $${paramIdx++}`);
                  vals.push(now);
                }
              }
            }
          }
          if (u.description != null) {
            sets.push(`description = $${paramIdx++}`);
            vals.push(u.description);
          }
          if (u.priority != null) {
            sets.push(`priority = $${paramIdx++}`);
            vals.push(u.priority);
          }
          vals.push(u.id, projectId);
          const sql = `UPDATE tasks SET ${sets.join(", ")} WHERE id = $${paramIdx++} AND project_id = $${paramIdx}`;
          await tx.execute(sql, vals);
        }
      });
      const tasks: StoredTask[] = [];
      for (const u of updates) {
        tasks.push(await this.show(projectId, u.id));
      }
      for (const task of tasks) {
        this.emitTaskChange(projectId, "update", task);
      }
      return tasks;
    });
  }

  async close(projectId: string, id: string, reason: string, _force = false): Promise<StoredTask> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      const now = new Date().toISOString();
      const modified = await client.execute(
        toPgParams(
          "UPDATE tasks SET status = 'closed', close_reason = ?, completed_at = ?, updated_at = ? WHERE id = ? AND project_id = ?"
        ),
        [reason, now, now, id, projectId]
      );
      if (modified === 0) {
        throw new AppError(404, ErrorCodes.ISSUE_NOT_FOUND, `Task ${id} not found`, {
          issueId: id,
        });
      }
      const task = await this.show(projectId, id);
      this.emitTaskChange(projectId, "close", task);
      return task;
    });
  }

  async closeMany(
    projectId: string,
    items: Array<{ id: string; reason: string }>
  ): Promise<StoredTask[]> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      const now = new Date().toISOString();
      await client.runInTransaction(async (tx) => {
        for (const item of items) {
          await tx.execute(
            toPgParams(
              "UPDATE tasks SET status = 'closed', close_reason = ?, completed_at = ?, updated_at = ? WHERE id = ? AND project_id = ?"
            ),
            [item.reason, now, now, item.id, projectId]
          );
        }
      });
      const tasks: StoredTask[] = [];
      for (const item of items) {
        tasks.push(await this.show(projectId, item.id));
      }
      for (const task of tasks) {
        this.emitTaskChange(projectId, "close", task);
      }
      return tasks;
    });
  }

  async addDependency(
    _projectId: string,
    childId: string,
    parentId: string,
    type?: string
  ): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      await client.execute(
        toPgParams(
          "INSERT INTO task_dependencies (task_id, depends_on_id, dep_type) VALUES (?, ?, ?) ON CONFLICT (task_id, depends_on_id) DO NOTHING"
        ),
        [childId, parentId, type ?? "blocks"]
      );
    });
  }

  async addDependencies(
    _projectId: string,
    deps: Array<{ childId: string; parentId: string; type?: string }>
  ): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      await client.runInTransaction(async (tx) => {
        for (const dep of deps) {
          await tx.execute(
            toPgParams(
              "INSERT INTO task_dependencies (task_id, depends_on_id, dep_type) VALUES (?, ?, ?) ON CONFLICT (task_id, depends_on_id) DO NOTHING"
            ),
            [dep.childId, dep.parentId, dep.type ?? "blocks"]
          );
        }
      });
    });
  }

  async delete(projectId: string, id: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      await client.execute(
        toPgParams("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?"),
        [id, id]
      );
      const modified = await client.execute(
        toPgParams("DELETE FROM tasks WHERE id = ? AND project_id = ?"),
        [id, projectId]
      );
      if (modified === 0) {
        throw new AppError(404, ErrorCodes.ISSUE_NOT_FOUND, `Task ${id} not found`, {
          issueId: id,
        });
      }
    });
  }

  /** Delete multiple tasks by ID. Skips tasks that don't exist (e.g. already deleted). */
  async deleteMany(projectId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      const uniqueIds = [...new Set(ids)];
      await client.runInTransaction(async (tx) => {
        for (const id of uniqueIds) {
          await tx.execute(
            toPgParams("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?"),
            [id, id]
          );
          await tx.execute(
            toPgParams("DELETE FROM tasks WHERE id = ? AND project_id = ?"),
            [id, projectId]
          );
        }
      });
    });
  }

  /** Delete all open_questions for a project. Used when archiving (index-only removal). */
  async deleteOpenQuestionsByProjectId(projectId: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      await client.execute(
        toPgParams("DELETE FROM open_questions WHERE project_id = ?"),
        [projectId]
      );
    });
  }

  /** Delete all data for a project from every project-scoped table. */
  async deleteByProjectId(projectId: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      const rows = await client.query(
        toPgParams("SELECT id FROM tasks WHERE project_id = ?"),
        [projectId]
      );
      const ids = rows.map((r) => r.id as string);
      for (const id of ids) {
        await client.execute(
          toPgParams("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?"),
          [id, id]
        );
      }
      await client.execute(toPgParams("DELETE FROM tasks WHERE project_id = ?"), [projectId]);
      await client.execute(toPgParams("DELETE FROM feedback WHERE project_id = ?"), [projectId]);
      await client.execute(toPgParams("DELETE FROM feedback_inbox WHERE project_id = ?"), [projectId]);
      await client.execute(toPgParams("DELETE FROM agent_sessions WHERE project_id = ?"), [projectId]);
      await client.execute(toPgParams("DELETE FROM agent_stats WHERE project_id = ?"), [projectId]);
      await client.execute(toPgParams("DELETE FROM orchestrator_events WHERE project_id = ?"), [projectId]);
      await client.execute(toPgParams("DELETE FROM orchestrator_counters WHERE project_id = ?"), [projectId]);
      await client.execute(toPgParams("DELETE FROM deployments WHERE project_id = ?"), [projectId]);
      await client.execute(toPgParams("DELETE FROM plans WHERE project_id = ?"), [projectId]);
      await client.execute(toPgParams("DELETE FROM open_questions WHERE project_id = ?"), [projectId]);
    });
  }

  async comment(_projectId: string, _id: string, _message: string): Promise<void> {
    // Comments not supported in sql.js store — no-op for API compatibility
  }

  async addLabel(projectId: string, id: string, label: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      const row = await client.queryOne(
        toPgParams("SELECT labels FROM tasks WHERE id = ? AND project_id = ?"),
        [id, projectId]
      );
      if (!row) {
        throw new AppError(404, ErrorCodes.ISSUE_NOT_FOUND, `Task ${id} not found`);
      }
      const labels: string[] = JSON.parse((row.labels as string) || "[]");

      if (!labels.includes(label)) {
        labels.push(label);
        const now = new Date().toISOString();
        await client.execute(
          toPgParams("UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ? AND project_id = ?"),
          [JSON.stringify(labels), now, id, projectId]
        );
      }
    });
  }

  async removeLabel(projectId: string, id: string, label: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      const row = await client.queryOne(
        toPgParams("SELECT labels FROM tasks WHERE id = ? AND project_id = ?"),
        [id, projectId]
      );
      if (!row) return;

      const labels: string[] = JSON.parse((row.labels as string) || "[]");
      const idx = labels.indexOf(label);
      if (idx >= 0) {
        labels.splice(idx, 1);
        const now = new Date().toISOString();
        await client.execute(
          toPgParams("UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ? AND project_id = ?"),
          [JSON.stringify(labels), now, id, projectId]
        );
      }
    });
  }

  getCumulativeAttemptsFromIssue(issue: StoredTask): number {
    const labels = (issue.labels ?? []) as string[];
    let max = 0;
    for (const l of labels) {
      if (/^attempts:\d+$/.test(l)) {
        const n = parseInt(l.split(":")[1]!, 10);
        if (!Number.isNaN(n) && n > max) max = n;
      }
    }
    return max;
  }

  async getCumulativeAttempts(projectId: string, id: string): Promise<number> {
    await this.ensureInitialized();
    const issue = await this.show(projectId, id);
    return this.getCumulativeAttemptsFromIssue(issue);
  }

  async setCumulativeAttempts(
    projectId: string,
    id: string,
    count: number,
    _options?: { currentLabels?: string[] }
  ): Promise<void> {
    const freshIssue = await this.show(projectId, id);
    const freshLabels = (freshIssue.labels ?? []) as string[];
    const allExisting = freshLabels.filter((l) => /^attempts:\d+$/.test(l));
    for (const old of allExisting) {
      await this.removeLabel(projectId, id, old);
    }
    await this.addLabel(projectId, id, `attempts:${count}`);
  }

  hasLabel(issue: StoredTask, label: string): boolean {
    return Array.isArray(issue.labels) && issue.labels.includes(label);
  }

  getFileScopeLabels(issue: StoredTask): { modify?: string[]; create?: string[] } | null {
    const labels = (issue.labels ?? []) as string[];
    const label = labels.find((l) => l.startsWith("files:"));
    if (!label) return null;
    try {
      return JSON.parse(label.slice("files:".length));
    } catch {
      return null;
    }
  }

  async setActualFiles(projectId: string, id: string, files: string[]): Promise<void> {
    const issue = await this.show(projectId, id);
    const labels = (issue.labels ?? []) as string[];
    const existing = labels.find((l) => l.startsWith("actual_files:"));
    if (existing) {
      await this.removeLabel(projectId, id, existing);
    }
    if (files.length > 0) {
      await this.addLabel(projectId, id, `actual_files:${JSON.stringify(files)}`);
    }
  }

  /** No-op. Dolt sync removed — persistence is handled by saveToDisk(). */
  async syncForPush(_projectId: string): Promise<void> {}

  // ──── Plan storage (SQL-only) ────

  async planInsert(projectId: string, planId: string, data: PlanInsertData): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      const now = new Date().toISOString();
      await client.execute(
        toPgParams(
          `INSERT INTO plans (project_id, plan_id, epic_id, gate_task_id, re_execute_gate_task_id, content, metadata, shipped_content, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
        ),
        [
          projectId,
          planId,
          data.epic_id,
          data.gate_task_id ?? null,
          data.re_execute_gate_task_id ?? null,
          data.content,
          data.metadata ?? null,
          now,
        ]
      );
    });
  }

  /** Return plan row as { content, metadata (parsed), shipped_content, updated_at } or null. */
  async planGet(
    projectId: string,
    planId: string
  ): Promise<{
    content: string;
    metadata: Record<string, unknown>;
    shipped_content: string | null;
    updated_at: string;
  } | null> {
    await this.ensureInitialized();
    const client = this.ensureClient();
    const row = await client.queryOne(
      toPgParams(
        "SELECT content, metadata, shipped_content, updated_at FROM plans WHERE project_id = ? AND plan_id = ?"
      ),
      [projectId, planId]
    );
    if (!row) return null;
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse((row.metadata as string) || "{}") as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    return {
      content: (row.content as string) ?? "",
      metadata,
      shipped_content: (row.shipped_content as string) ?? null,
      updated_at: (row.updated_at as string) ?? "",
    };
  }

  /** Lookup plan by epic id (epic_id). Returns same shape as planGet or null. */
  async planGetByEpicId(
    projectId: string,
    epicId: string
  ): Promise<{
    plan_id: string;
    content: string;
    metadata: Record<string, unknown>;
    shipped_content: string | null;
    updated_at: string;
  } | null> {
    await this.ensureInitialized();
    const client = this.ensureClient();
    const row = await client.queryOne(
      toPgParams(
        "SELECT plan_id, content, metadata, shipped_content, updated_at FROM plans WHERE project_id = ? AND epic_id = ?"
      ),
      [projectId, epicId]
    );
    if (!row) return null;
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse((row.metadata as string) || "{}") as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    return {
      plan_id: (row.plan_id as string) ?? "",
      content: (row.content as string) ?? "",
      metadata,
      shipped_content: (row.shipped_content as string) ?? null,
      updated_at: (row.updated_at as string) ?? "",
    };
  }

  async planListIds(projectId: string): Promise<string[]> {
    await this.ensureInitialized();
    const client = this.ensureClient();
    const rows = await client.query(
      toPgParams("SELECT plan_id FROM plans WHERE project_id = ? ORDER BY updated_at ASC"),
      [projectId]
    );
    return rows.map((r) => r.plan_id as string);
  }

  async planUpdateContent(projectId: string, planId: string, content: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      const existing = await client.queryOne(
        toPgParams("SELECT 1 FROM plans WHERE project_id = ? AND plan_id = ?"),
        [projectId, planId]
      );
      if (!existing) {
        throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
      }
      const now = new Date().toISOString();
      await client.execute(
        toPgParams("UPDATE plans SET content = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?"),
        [content, now, projectId, planId]
      );
    });
  }

  async planUpdateMetadata(
    projectId: string,
    planId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      const existing = await client.queryOne(
        toPgParams("SELECT 1 FROM plans WHERE project_id = ? AND plan_id = ?"),
        [projectId, planId]
      );
      if (!existing) {
        throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
      }
      const metaJson = JSON.stringify(metadata);
      const now = new Date().toISOString();
      await client.execute(
        toPgParams("UPDATE plans SET metadata = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?"),
        [metaJson, now, projectId, planId]
      );
    });
  }

  async planSetShippedContent(
    projectId: string,
    planId: string,
    shippedContent: string
  ): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      const existing = await client.queryOne(
        toPgParams("SELECT 1 FROM plans WHERE project_id = ? AND plan_id = ?"),
        [projectId, planId]
      );
      if (!existing) {
        throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
      }
      await client.execute(
        toPgParams("UPDATE plans SET shipped_content = ? WHERE project_id = ? AND plan_id = ?"),
        [shippedContent, projectId, planId]
      );
    });
  }

  async planGetShippedContent(projectId: string, planId: string): Promise<string | null> {
    await this.ensureInitialized();
    const client = this.ensureClient();
    const row = await client.queryOne(
      toPgParams("SELECT shipped_content FROM plans WHERE project_id = ? AND plan_id = ?"),
      [projectId, planId]
    );
    return (row?.shipped_content as string) ?? null;
  }

  /** Delete a plan by project_id and plan_id. Returns true if a row was deleted. */
  async planDelete(projectId: string, planId: string): Promise<boolean> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      const existing = await client.queryOne(
        toPgParams("SELECT 1 FROM plans WHERE project_id = ? AND plan_id = ?"),
        [projectId, planId]
      );
      if (!existing) return false;
      const modified = await client.execute(
        toPgParams("DELETE FROM plans WHERE project_id = ? AND plan_id = ?"),
        [projectId, planId]
      );
      return modified > 0;
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.client) {
      await this.init();
    }
  }

  /**
   * Retention policy: keep only the 100 most recent agent_sessions, prune older entries,
   * then VACUUM to reclaim disk space. Active/in-progress sessions are not in agent_sessions
   * until archived, so this has no impact on them.
   * @returns Number of rows pruned
   */
  async pruneAgentSessions(): Promise<number> {
    return this.runWrite(async (client) => {
      const countRow = await client.queryOne("SELECT COUNT(*)::int as cnt FROM agent_sessions");
      const total = (countRow?.cnt as number) ?? 0;
      if (total <= 100) return 0;

      const cutoffRow = await client.queryOne(
        "SELECT id FROM agent_sessions ORDER BY id DESC LIMIT 1 OFFSET 99"
      );
      const cutoffId = cutoffRow?.id as number | undefined;
      if (cutoffId == null) return 0;

      const pruned = await client.execute(
        toPgParams("DELETE FROM agent_sessions WHERE id < ?"),
        [cutoffId]
      );

      await client.execute("VACUUM");
      if (pruned > 0) {
        log.info("Pruned agent_sessions", { pruned, retained: 100 });
      }
      return pruned;
    });
  }

  /**
   * Return the shared DbClient for use by other stores (feedback, deployments, events, etc.).
   * Callers must await init() first (done at server startup in index.ts).
   */
  async getDb(): Promise<DbClient> {
    await this.ensureInitialized();
    return this.ensureClient();
  }

  /**
   * Run a write transaction under the shared write lock.
   * Use this from feedback-store, deploy-storage, event-log, agent-identity, orchestrator counters, sessions.
   */
  async runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    await this.ensureInitialized();
    return this.withWriteLock(async () => {
      return await fn(this.ensureClient());
    });
  }

  /** No-op for Postgres; data is persisted immediately. Use on shutdown for compatibility. */
  flushPersist(): Promise<void> {
    return Promise.resolve();
  }
}

/** Process-wide singleton — all services share one in-memory database. */
export const taskStore = new TaskStoreService();
