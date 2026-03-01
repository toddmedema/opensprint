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
import { createPostgresDbClient, getPoolConfig } from "../db/client.js";
import { runSchema } from "../db/schema.js";
import type { AppDb } from "../db/app-db.js";
import {
  PlanStore,
  type PlanInsertData,
  type StoredPlan,
} from "./plan-store.service.js";
import { toPgParams } from "../db/sql-params.js";
import { getDatabaseUrl } from "./global-settings.service.js";

const log = createLogger("task-store");


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

/** Re-export plan types for consumers that import from task-store. */
export type { PlanInsertData, StoredPlan } from "./plan-store.service.js";

/** Callback invoked when a task is created, updated, or closed. Used to emit WebSocket events. */
export type TaskChangeCallback = (
  projectId: string,
  changeType: "create" | "update" | "close",
  task: StoredTask
) => void;

export class TaskStoreService {
  private client: DbClient | null = null;
  private pool: Pool | null = null;
  private appDb: AppDb | null = null;
  private writeLock: Promise<void> = Promise.resolve();
  private injectedClient: DbClient | null = null;
  /** Serializes init so only one run runs at a time; concurrent callers await the same promise. */
  private initPromise: Promise<void> | null = null;
  /** Optional callback to emit WebSocket events on task create/update/close. */
  private onTaskChange: TaskChangeCallback | null = null;

  private planStore = new PlanStore(() => this.ensureClient());

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

  /**
   * Initialize the task store. When appDb is provided (e.g. from startup), use it and do not create a pool.
   * When databaseUrl is provided without appDb, create pool and schema. Tests may inject a client via constructor.
   */
  async init(databaseUrl?: string, appDb?: AppDb): Promise<void> {
    if (this.client) return;

    if (this.injectedClient) {
      this.client = this.injectedClient;
      return;
    }

    if (appDb) {
      this.appDb = appDb;
      this.client = await appDb.getClient();
      log.info("Task store initialized with AppDb");
      return;
    }

    // #region agent log — init falling through to runInitInternal (no appDb)
    const _stack = new Error().stack ?? "";
    const _caller = _stack.split("\n").slice(2, 6).join(" | ");
    fetch("http://127.0.0.1:7244/ingest/7b4dbb83-aede-4af0-b5cc-f2f84134fedd",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"743c0d"},body:JSON.stringify({sessionId:"743c0d",location:"task-store.service.ts:init",message:"init_no_appDb_fallthrough",data:{pid:process.pid,hasInitPromise:!!this.initPromise,hasDatabaseUrl:!!databaseUrl,caller:_caller},timestamp:Date.now(),hypothesisId:"H1"})}).catch(()=>{});
    // #endregion

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.runInitInternal(databaseUrl);
    try {
      await this.initPromise;
    } catch (err) {
      this.initPromise = null;
      const msg =
        err instanceof Error
          ? err.message || (err as NodeJS.ErrnoException).code || err.stack || String(err)
          : String(err);
      throw new AppError(
        500,
        ErrorCodes.TASK_STORE_INIT_FAILED,
        `Failed to initialize task store: ${msg}`
      );
    }
  }

  private async runInitInternal(databaseUrl?: string): Promise<void> {
    const url = databaseUrl ?? (await getDatabaseUrl());

    // #region agent log — runInitInternal creating raw pool
    const _stack = new Error().stack ?? "";
    const _caller = _stack.split("\n").slice(2, 6).join(" | ");
    let _parsedDb = "?";
    try { _parsedDb = new URL(url).pathname.replace(/^\/+|\/+$/g, "") || "opensprint"; } catch {}
    fetch("http://127.0.0.1:7244/ingest/7b4dbb83-aede-4af0-b5cc-f2f84134fedd",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"743c0d"},body:JSON.stringify({sessionId:"743c0d",location:"task-store.service.ts:runInitInternal",message:"runInitInternal_raw_pool",data:{pid:process.pid,database:_parsedDb,vitest:!!process.env.VITEST,urlProvided:!!databaseUrl,hasAppName:url.includes("application_name"),caller:_caller},timestamp:Date.now(),hypothesisId:"H1"})}).catch(()=>{});
    // #endregion

    if (process.env.VITEST) {
      try {
        const dbName = new URL(url).pathname.replace(/^\/+|\/+$/g, "") || "opensprint";
        if (dbName === "opensprint") {
          throw new AppError(
            500,
            ErrorCodes.TASK_STORE_INIT_FAILED,
            `TaskStoreService.runInitInternal refused to connect to app database "${dbName}" during tests. ` +
              "Add vi.mock(\"../services/task-store.service.js\") with createTestPostgresClient() in your test file."
          );
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
      }
    }

    const pool = new pg.Pool(getPoolConfig(url));
    this.pool = pool;
    this.client = createPostgresDbClient(pool);

    await runSchema(this.client);
    log.info("Task store initialized with Postgres");
  }

  /**
   * Close the database pool. Call on shutdown so connections are released.
   * When using AppDb, only clears the reference; caller must call appDb.close().
   * No-op when using an injected client (tests).
   */
  async closePool(): Promise<void> {
    if (this.appDb) {
      this.appDb = null;
      this.client = null;
      return;
    }
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.client = null;
    }
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
    const { z } = await import("zod");
    const schema = z.object({
      id: z.string(), project_id: z.string(), title: z.string(),
      description: z.string().nullable().optional(), issue_type: z.string(),
      status: z.string(), priority: z.number(),
      assignee: z.string().nullable().optional(), owner: z.string().nullable().optional(),
      labels: z.string().optional(), created_at: z.string(), updated_at: z.string(),
      created_by: z.string().nullable().optional(), close_reason: z.string().nullable().optional(),
      started_at: z.string().nullable().optional(), completed_at: z.string().nullable().optional(),
      complexity: z.number().nullable().optional(), extra: z.string().nullable().optional(),
    });
    const parsed = schema.safeParse(row);
    if (!parsed.success) {
      throw new AppError(500, ErrorCodes.TASK_STORE_PARSE_FAILED, "Invalid task row shape", {
        zodError: parsed.error,
      });
    }
    return this.hydrateTaskWithDeps(parsed.data as unknown as Record<string, unknown>);
  }

  async listAll(projectId: string): Promise<StoredTask[]> {
    await this.ensureInitialized();
    const tasks = await this.execAndHydrateWithDeps(
      projectId,
      "SELECT * FROM tasks WHERE project_id = ? ORDER BY priority ASC, created_at ASC",
      [projectId]
    );
    return tasks;
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
      /** Task-level complexity (1-10). Stored in complexity column. Pass null to clear. */
      complexity?: number | null;
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
      // #region agent log — deleteByProjectId caller trace
      const _stack = new Error().stack ?? "";
      const _caller = _stack.split("\n").slice(2, 8).join(" | ");
      const _dbRow = await client.queryOne("SELECT current_database() AS name, current_setting('application_name', true) AS app_name");
      fetch("http://127.0.0.1:7244/ingest/7b4dbb83-aede-4af0-b5cc-f2f84134fedd",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"743c0d"},body:JSON.stringify({sessionId:"743c0d",location:"task-store.service.ts:deleteByProjectId",message:"deleteByProjectId_called",data:{pid:process.pid,projectId,database:(_dbRow?.name as string)??"?",appName:(_dbRow?.app_name as string)??"?",hasAppDb:!!this.appDb,caller:_caller},timestamp:Date.now(),hypothesisId:"H_PROD_DELETE"})}).catch(()=>{});
      // #endregion
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
      await this.planStore.planDeleteAllForProject(projectId);
      await client.execute(toPgParams("DELETE FROM open_questions WHERE project_id = ?"), [projectId]);
    });
  }

  async comment(_projectId: string, _id: string, _message: string): Promise<void> {
    // Comments not supported — no-op for API compatibility
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

  /** No-op. Dolt sync removed — persistence is handled by Postgres. */
  async syncForPush(_projectId: string): Promise<void> {}

  // ──── Plan storage (delegated to PlanStore) ────

  async planInsert(projectId: string, planId: string, data: PlanInsertData): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      await this.planStore.planInsert(projectId, planId, data);
    });
  }

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
    return this.planStore.planGet(projectId, planId);
  }

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
    return this.planStore.planGetByEpicId(projectId, epicId);
  }

  async planListIds(projectId: string): Promise<string[]> {
    await this.ensureInitialized();
    return this.planStore.planListIds(projectId);
  }

  async planUpdateContent(projectId: string, planId: string, content: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      await this.planStore.planUpdateContent(projectId, planId, content);
    });
  }

  async planUpdateMetadata(
    projectId: string,
    planId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      await this.planStore.planUpdateMetadata(projectId, planId, metadata);
    });
  }

  async planSetShippedContent(
    projectId: string,
    planId: string,
    shippedContent: string
  ): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      await this.planStore.planSetShippedContent(projectId, planId, shippedContent);
    });
  }

  async planGetShippedContent(projectId: string, planId: string): Promise<string | null> {
    await this.ensureInitialized();
    return this.planStore.planGetShippedContent(projectId, planId);
  }

  async planDelete(projectId: string, planId: string): Promise<boolean> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      return this.planStore.planDelete(projectId, planId);
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.client) {
      // #region agent log — ensureInitialized with null client
      const _stack = new Error().stack ?? "";
      const _caller = _stack.split("\n").slice(2, 5).join(" | ") || "?";
      fetch("http://127.0.0.1:7244/ingest/7b4dbb83-aede-4af0-b5cc-f2f84134fedd",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"743c0d"},body:JSON.stringify({sessionId:"743c0d",location:"task-store.service.ts:ensureInitialized",message:"ensureInitialized_null_client",data:{pid:process.pid,vitest:!!process.env.VITEST,hasAppDb:!!this.appDb,caller:_caller},timestamp:Date.now(),hypothesisId:"H1"})}).catch(()=>{});
      // #endregion
      await this.init();
    }
  }

  /**
   * Retention policy: keep only the 100 most recent agent_sessions, prune older entries,
   * then VACUUM to reclaim disk space. Active/in-progress sessions are not in agent_sessions
   * until archived, so this has no impact on them.
   * Uses withWriteLock directly because VACUUM cannot run inside a transaction.
   * @returns Number of rows pruned
   */
  async pruneAgentSessions(): Promise<number> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
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
   * Uses runInTransaction for atomicity. Use from feedback-store, deploy-storage, event-log, agent-identity, orchestrator counters, sessions.
   */
  async runWrite<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    await this.ensureInitialized();
    return this.withWriteLock(async () => {
      if (this.appDb) {
        return await this.appDb.runWrite(fn);
      }
      const client = this.ensureClient();
      return await client.runInTransaction(fn);
    });
  }

  /** No-op for Postgres; data is persisted immediately. Use on shutdown for compatibility. */
  flushPersist(): Promise<void> {
    return Promise.resolve();
  }
}

/** Process-wide singleton — all services share one Postgres connection pool. */
export const taskStore = new TaskStoreService();
