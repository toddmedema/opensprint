import crypto from "crypto";
import { clampTaskComplexity, getDatabaseDialect } from "@opensprint/shared";
import {
  isAgentAssignee,
  isBlockedByTechnicalError,
  AUTO_RETRY_BLOCKED_INTERVAL_MS,
} from "@opensprint/shared";
import { AppError } from "../middleware/error-handler.js";
import { ErrorCodes } from "../middleware/error-codes.js";
import { createLogger } from "../utils/logger.js";
import type { DbClient } from "../db/client.js";
import { classifyDbConnectionError, isDbConnectionError } from "../db/db-errors.js";
import type { AppDb, DrizzlePg } from "../db/app-db.js";
import { initAppDb } from "../db/app-db.js";
import { PlanStore, type PlanInsertData } from "./plan-store.service.js";
import {
  PlanVersionStore,
  type PlanVersionInsert,
  type PlanVersionListItem,
  type PlanVersionRow,
} from "./plan-version-store.service.js";
import {
  AuditorRunStore,
  type AuditorRunInsert,
  type AuditorRunRecord,
} from "./auditor-run-store.service.js";
import {
  SelfImprovementRunHistoryStore,
  type SelfImprovementRunHistoryInsert,
  type SelfImprovementRunHistoryRecord,
} from "./self-improvement-run-history.service.js";
import { toPgParams } from "../db/sql-params.js";
import { getDatabaseUrl } from "./global-settings.service.js";
import type {
  StoredTask,
  CreateOpts,
  CreateInput,
  TaskChangeCallback,
} from "./task-store.types.js";
import {
  resolveEpicId,
  getBlockersFromIssue,
  getParentId as getParentIdHelper,
  hydrateTask,
  validateAssigneeChange as validateAssigneeChangeHelper,
  mergeExtraForUpdate as mergeExtraForUpdateHelper,
  buildTaskUpdateSets as buildTaskUpdateSetsHelper,
  buildUpdateManySets as buildUpdateManySetsHelper,
  isDuplicateKeyError as isDuplicateKeyErrorHelper,
  getCumulativeAttemptsFromIssue as getCumulativeAttemptsFromIssueHelper,
  hasLabel as hasLabelHelper,
  getFileScopeLabels as getFileScopeLabelsHelper,
  getConflictFilesFromIssue as getConflictFilesFromIssueHelper,
  getMergeStageFromIssue as getMergeStageFromIssueHelper,
} from "./task-store-helpers.js";
import { cascadeDeleteTaskReferences } from "./task-store-cascade.js";
import { TaskStorePlanAuditorSIFacade } from "./task-store-facades.js";
import { parseTaskLastExecutionSummary } from "./task-execution-summary.js";

export type {
  StoredTask,
  CreateOpts,
  CreateInput,
  TaskChangeCallback,
} from "./task-store.types.js";
export { resolveEpicId, getBlockersFromIssue, getParentId } from "./task-store-helpers.js";
/** Re-export plan types for consumers that import from task-store. */
export type { PlanInsertData, StoredPlan } from "./plan-store.service.js";

const log = createLogger("task-store");
const NON_RETRYABLE_BLOCK_FAILURE_TYPES = new Set([
  "review_rejection",
  "repo_preflight",
  "environment_setup",
]);

function getBlockedTaskFailureType(task: StoredTask): string | null {
  const lastExecution = parseTaskLastExecutionSummary(
    (task as { last_execution_summary?: unknown }).last_execution_summary
  );
  if (typeof lastExecution?.failureType === "string" && lastExecution.failureType.trim() !== "") {
    return lastExecution.failureType.trim().toLowerCase();
  }

  const retryContext = (task as { next_retry_context?: unknown }).next_retry_context;
  if (!retryContext || typeof retryContext !== "object") return null;
  const failureType = (retryContext as { failureType?: unknown }).failureType;
  return typeof failureType === "string" && failureType.trim() !== ""
    ? failureType.trim().toLowerCase()
    : null;
}

export class TaskStoreService {
  private client: DbClient | null = null;
  private appDb: AppDb | null = null;
  /** When true, this service created appDb in runInitInternal and should close it in closePool. */
  private ownAppDb = false;
  private writeLock: Promise<void> = Promise.resolve();
  private injectedClient: DbClient | null = null;
  /** Serializes init so only one run runs at a time; concurrent callers await the same promise. */
  private initPromise: Promise<void> | null = null;
  /** Optional callback to emit WebSocket events on task create/update/close. */
  private onTaskChange: TaskChangeCallback | null = null;

  private planStore = new PlanStore(
    () => this.ensureClient(),
    () => this.getDrizzle()
  );
  private planVersionStore = new PlanVersionStore(() => this.ensureClient());
  private auditorRunStore = new AuditorRunStore(() => this.ensureClient());
  private selfImprovementRunHistoryStore = new SelfImprovementRunHistoryStore(() =>
    this.ensureClient()
  );
  private planAuditorSIFacade = new TaskStorePlanAuditorSIFacade({
    ensureInitialized: () => this.ensureInitialized(),
    withWriteLock: <T>(fn: () => Promise<T>) => this.withWriteLock(fn),
    planStore: this.planStore,
    planVersionStore: this.planVersionStore,
    auditorRunStore: this.auditorRunStore,
    selfImprovementRunHistoryStore: this.selfImprovementRunHistoryStore,
  });

  constructor(injectedClient?: DbClient) {
    if (injectedClient) {
      this.injectedClient = injectedClient;
    }
  }

  /** Register callback to emit WebSocket events on task create/update/close. */
  setOnTaskChange(cb: TaskChangeCallback | null): void {
    this.onTaskChange = cb;
  }

  private emitTaskChange(
    projectId: string,
    changeType: "create" | "update" | "close",
    task: StoredTask
  ): void {
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

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.runInitInternal(databaseUrl);
    try {
      await this.initPromise;
    } catch (err) {
      this.initPromise = null;
      if (
        (err instanceof AppError && err.code === ErrorCodes.DATABASE_UNAVAILABLE) ||
        isDbConnectionError(err)
      ) {
        const dialect = databaseUrl
          ? getDatabaseDialect(databaseUrl)
          : getDatabaseDialect(await getDatabaseUrl().catch(() => "postgresql://"));
        throw new AppError(
          503,
          ErrorCodes.DATABASE_UNAVAILABLE,
          classifyDbConnectionError(err, dialect)
        );
      }
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

    if (process.env.VITEST && getDatabaseDialect(url) === "postgres") {
      try {
        const dbName = new URL(url).pathname.replace(/^\/+|\/+$/g, "") || "opensprint";
        if (dbName === "opensprint") {
          throw new AppError(
            500,
            ErrorCodes.TASK_STORE_INIT_FAILED,
            `TaskStoreService.runInitInternal refused to connect to app database "${dbName}" during tests. ` +
              'Add vi.mock("../services/task-store.service.js") with createTestPostgresClient() in your test file.'
          );
        }
      } catch (err) {
        if (err instanceof AppError) throw err;
      }
    }

    const appDbInstance = await initAppDb(url);
    this.appDb = appDbInstance;
    this.ownAppDb = true;
    this.client = await appDbInstance.getClient();
    const dialect = getDatabaseDialect(url);
    log.info("Task store initialized", { dialect });
  }

  /**
   * Close the database pool. Call on shutdown so connections are released.
   * When using AppDb from app init, only clears the reference; caller must call appDb.close().
   * When this service created AppDb (ownAppDb), closes it here.
   * No-op when using an injected client (tests).
   */
  async closePool(): Promise<void> {
    if (this.appDb) {
      if (this.ownAppDb) {
        await this.appDb.close();
        this.ownAppDb = false;
      }
      this.appDb = null;
      this.client = null;
      return;
    }
    this.client = null;
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

  /** Returns Drizzle instance when using Postgres; null for SQLite or when not initialized. */
  private async getDrizzle(): Promise<DrizzlePg | null> {
    if (!this.appDb?.getDrizzle) return null;
    return this.appDb.getDrizzle();
  }

  /**
   * Check database connectivity. Used by GET /db-status for homepage error banner.
   * Returns { ok: true } when connected, or { ok: false, message } when not.
   */
  async checkConnection(): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const client = this.ensureClient();
      await client.query("SELECT 1");
      return { ok: true };
    } catch (err) {
      const url = await getDatabaseUrl().catch(() => "");
      const dialect = url ? getDatabaseDialect(url) : "postgres";
      return { ok: false, message: classifyDbConnectionError(err, dialect) };
    }
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
    return hydrateTask(
      row,
      new Map([
        [
          row.id as string,
          deps.map((d) => ({
            depends_on_id: d.depends_on_id as string,
            type: d.dep_type as string,
          })),
        ],
      ]),
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
      hydrateTask(row as Record<string, unknown>, depsByTaskId, dependentCountByTaskId)
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
      id: z.string(),
      project_id: z.string(),
      title: z.string(),
      description: z.string().nullable().optional(),
      issue_type: z.string(),
      status: z.string(),
      priority: z.number(),
      assignee: z.string().nullable().optional(),
      owner: z.string().nullable().optional(),
      labels: z.string().optional(),
      created_at: z.string(),
      updated_at: z.string(),
      created_by: z.string().nullable().optional(),
      close_reason: z.string().nullable().optional(),
      started_at: z.string().nullable().optional(),
      completed_at: z.string().nullable().optional(),
      complexity: z.number().nullable().optional(),
      extra: z.string().nullable().optional(),
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

  /**
   * List the N most recently completed tasks for analytics.
   * When projectId is provided, scope to that project; when null, global scope.
   * Only returns tasks with completed_at set (required for completion time).
   * Includes started_at for completion-time calculation (fallback to created_at when null).
   */
  async listRecentlyCompletedTasks(
    projectId: string | null,
    limit: number = 100
  ): Promise<
    Array<{
      id: string;
      created_at: string;
      started_at: string | null;
      completed_at: string;
      complexity: number | null;
    }>
  > {
    await this.ensureInitialized();
    const client = this.ensureClient();
    const sql =
      projectId != null
        ? "SELECT id, created_at, started_at, completed_at, complexity FROM tasks WHERE project_id = ? AND status = 'closed' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT ?"
        : "SELECT id, created_at, started_at, completed_at, complexity FROM tasks WHERE status = 'closed' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT ?";
    const params = projectId != null ? [projectId, limit] : [limit];
    const rows = await client.query(toPgParams(sql), params);
    return rows.map((r) => ({
      id: r.id as string,
      created_at: r.created_at as string,
      started_at: (r.started_at as string | null) ?? null,
      completed_at: r.completed_at as string,
      complexity: r.complexity as number | null,
    }));
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
   * List project IDs that have at least one task with status in_progress.
   * Used by scripts (e.g. reset in-progress tasks to open).
   */
  async listProjectIdsWithInProgressTasks(): Promise<string[]> {
    await this.ensureInitialized();
    const client = this.ensureClient();
    const rows = await client.query(
      toPgParams("SELECT DISTINCT project_id FROM tasks WHERE status = ?"),
      ["in_progress"]
    );
    return rows.map((r) => r.project_id as string).filter(Boolean);
  }

  /**
   * List tasks blocked by technical errors (Merge Failure, Quality Gate Failure, Coding Failure) that are eligible
   * for auto-retry. Excludes human-feedback blocks plus deterministic/setup or review failures
   * that should stay blocked until someone intervenes. Only returns tasks whose
   * last_auto_retry_at is null or older than AUTO_RETRY_BLOCKED_INTERVAL_MS (8 hours).
   */
  async listBlockedByTechnicalErrorEligibleForRetry(projectId: string): Promise<StoredTask[]> {
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
      const failureType = getBlockedTaskFailureType(t);
      if (failureType && NON_RETRYABLE_BLOCK_FAILURE_TYPES.has(failureType)) return false;
      const lastRetry = t.last_auto_retry_at;
      if (!lastRetry) return true;
      const lastRetryMs = new Date(lastRetry).getTime();
      return !isNaN(lastRetryMs) && lastRetryMs <= cutoff;
    });
  }

  getBlockersFromIssue(issue: StoredTask): string[] {
    return getBlockersFromIssue(issue);
  }

  async readyWithStatusMap(
    projectId: string
  ): Promise<{ tasks: StoredTask[]; statusMap: Map<string, string>; allIssues: StoredTask[] }> {
    const allIssues = await this.listAll(projectId);
    const statusMap = new Map(allIssues.map((i) => [i.id, i.status]));

    const filtered: StoredTask[] = [];
    for (const issue of allIssues) {
      if (issue.status !== "open") continue;
      if (issue.issue_type === "epic") continue;
      const mergePausedUntilRaw = (issue as Record<string, unknown>)
        .merge_quality_gate_paused_until;
      if (typeof mergePausedUntilRaw === "string") {
        const mergePausedUntilMs = Date.parse(mergePausedUntilRaw);
        if (Number.isFinite(mergePausedUntilMs) && mergePausedUntilMs > Date.now()) {
          continue;
        }
      }

      // Exclude tasks in blocked epic (walk up to find epic parent)
      const epicId = this.getPlanEpicId(issue, allIssues);
      if (epicId) {
        const epicStatus = statusMap.get(epicId);
        if (epicStatus === "blocked") continue;
      }

      const blockers = getBlockersFromIssue(issue);
      const allBlockersClosed =
        blockers.length === 0 || blockers.every((bid) => statusMap.get(bid) === "closed");
      if (allBlockersClosed) {
        filtered.push(issue);
      }
    }

    filtered.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
    return { tasks: filtered, statusMap, allIssues };
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
      return getBlockersFromIssue(issue);
    } catch {
      return [];
    }
  }

  getParentId(taskId: string): string | null {
    return getParentIdHelper(taskId);
  }

  /** Find plan epic by walking up parent chain (epic.1.2 -> epic.1 -> epic). */
  private getPlanEpicId(issue: StoredTask, allIssues: StoredTask[]): string | null {
    return resolveEpicId(issue.id ?? "", allIssues);
  }

  // ──── Write methods (mutex + save) ────

  async create(projectId: string, title: string, options: CreateOpts = {}): Promise<StoredTask> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      const now = new Date().toISOString();
      const type = (options.type as string) ?? "task";
      const priority = options.priority ?? 2;
      const complexity = clampTaskComplexity(options.complexity);
      const baseExtra: Record<string, unknown> = { ...options.extra };
      const extra = JSON.stringify(baseExtra);

      const isTopLevel = options.parentId == null;
      const maxAttempts = isTopLevel ? 3 : 1;
      let lastError: unknown;
      let id: string | null = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          id = await this.generateId(projectId, options.parentId);
          await client.execute(
            toPgParams(
              `INSERT INTO tasks (id, project_id, title, description, issue_type, status, priority, assignee, labels, created_at, updated_at, complexity, extra)
               VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, '[]', ?, ?, ?, ?)`
            ),
            [
              id,
              projectId,
              title,
              options.description ?? null,
              type,
              priority,
              now,
              now,
              complexity ?? null,
              extra,
            ]
          );
          break;
        } catch (err: unknown) {
          lastError = err;
          if (!isTopLevel || !isDuplicateKeyErrorHelper(err)) throw err;
          log.warn("Duplicate key on create (top-level ID), retrying", {
            title,
            attempt: attempt + 1,
          });
        }
      }

      if (id == null) {
        throw lastError;
      }

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
        if (!isDuplicateKeyErrorHelper(err)) throw err;
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

          const extraJson =
            input.extra != null ? JSON.stringify(input.extra) : "{}";
          await tx.execute(
            toPgParams(
              `INSERT INTO tasks (id, project_id, title, description, issue_type, status, priority, assignee, labels, created_at, updated_at, complexity, extra)
               VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, '[]', ?, ?, ?, ?)`
            ),
            [
              id,
              projectId,
              input.title,
              input.description ?? null,
              type,
              priority,
              now,
              now,
              complexity ?? null,
              extraJson,
            ]
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

      const needRow =
        options.assignee !== undefined ||
        options.extra != null ||
        options.block_reason !== undefined ||
        options.last_auto_retry_at !== undefined;
      const row = needRow
        ? await client.queryOne(
            toPgParams(
              "SELECT status, started_at, extra FROM tasks WHERE id = ? AND project_id = ?"
            ),
            [id, projectId]
          )
        : null;
      const rowShape = row
        ? {
            status: row.status as string | undefined,
            started_at: row.started_at as string | null | undefined,
            extra: row.extra as string | undefined,
          }
        : null;

      validateAssigneeChangeHelper(rowShape?.status, options, id);

      let mergedExtra: Record<string, unknown> | undefined;
      if (
        options.extra != null ||
        options.block_reason !== undefined ||
        options.last_auto_retry_at !== undefined
      ) {
        const existing: Record<string, unknown> = rowShape?.extra
          ? (JSON.parse(rowShape.extra || "{}") as Record<string, unknown>)
          : {};
        mergedExtra = mergeExtraForUpdateHelper(existing, options);
      }

      const { sets, vals, nextIdx } = buildTaskUpdateSetsHelper(
        options,
        now,
        rowShape,
        mergedExtra
      );
      vals.push(id, projectId);
      const updateSql = `UPDATE tasks SET ${sets.join(", ")} WHERE id = $${nextIdx} AND project_id = $${nextIdx + 1}`;
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
          const needRow = u.assignee !== undefined;
          const row = needRow
            ? await tx.queryOne(
                toPgParams("SELECT status, started_at FROM tasks WHERE id = ? AND project_id = ?"),
                [u.id, projectId]
              )
            : null;
          const rowShape = row
            ? {
                status: row.status as string | undefined,
                started_at: row.started_at as string | null | undefined,
              }
            : null;

          validateAssigneeChangeHelper(rowShape?.status, u, u.id);

          const now = new Date().toISOString();
          const { sets, vals, nextIdx } = buildUpdateManySetsHelper(u, now, rowShape);
          vals.push(u.id, projectId);
          const sql = `UPDATE tasks SET ${sets.join(", ")} WHERE id = $${nextIdx} AND project_id = $${nextIdx + 1}`;
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

  async removeDependency(_projectId: string, childId: string, parentId: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      await client.execute(
        toPgParams("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?"),
        [childId, parentId]
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
      const modified = await client.runInTransaction(async (tx) => {
        const existing = await tx.queryOne(
          toPgParams("SELECT 1 FROM tasks WHERE id = ? AND project_id = ?"),
          [id, projectId]
        );
        if (!existing) return 0;

        await cascadeDeleteTaskReferences(tx, projectId, id);
        await tx.execute(
          toPgParams("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?"),
          [id, id]
        );
        return tx.execute(toPgParams("DELETE FROM tasks WHERE id = ? AND project_id = ?"), [
          id,
          projectId,
        ]);
      });
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
          const existing = await tx.queryOne(
            toPgParams("SELECT 1 FROM tasks WHERE id = ? AND project_id = ?"),
            [id, projectId]
          );
          if (!existing) continue;
          await cascadeDeleteTaskReferences(tx, projectId, id);
          await tx.execute(
            toPgParams("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?"),
            [id, id]
          );
          await tx.execute(toPgParams("DELETE FROM tasks WHERE id = ? AND project_id = ?"), [
            id,
            projectId,
          ]);
        }
      });
    });
  }

  /** Delete all open_questions for a project. Used when archiving (index-only removal). */
  async deleteOpenQuestionsByProjectId(projectId: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      await client.execute(toPgParams("DELETE FROM open_questions WHERE project_id = ?"), [
        projectId,
      ]);
    });
  }

  /** Delete all data for a project from every project-scoped table. */
  async deleteByProjectId(projectId: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const client = this.ensureClient();
      const rows = await client.query(toPgParams("SELECT id FROM tasks WHERE project_id = ?"), [
        projectId,
      ]);
      const ids = rows.map((r) => r.id as string);
      for (const id of ids) {
        await client.execute(
          toPgParams("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?"),
          [id, id]
        );
      }
      await client.execute(toPgParams("DELETE FROM tasks WHERE project_id = ?"), [projectId]);
      await client.execute(toPgParams("DELETE FROM feedback WHERE project_id = ?"), [projectId]);
      await client.execute(toPgParams("DELETE FROM feedback_inbox WHERE project_id = ?"), [
        projectId,
      ]);
      await client.execute(toPgParams("DELETE FROM agent_sessions WHERE project_id = ?"), [
        projectId,
      ]);
      await client.execute(toPgParams("DELETE FROM auditor_runs WHERE project_id = ?"), [
        projectId,
      ]);
      await client.execute(toPgParams("DELETE FROM self_improvement_runs WHERE project_id = ?"), [
        projectId,
      ]);
      await client.execute(toPgParams("DELETE FROM agent_stats WHERE project_id = ?"), [projectId]);
      await client.execute(toPgParams("DELETE FROM orchestrator_events WHERE project_id = ?"), [
        projectId,
      ]);
      await client.execute(toPgParams("DELETE FROM orchestrator_counters WHERE project_id = ?"), [
        projectId,
      ]);
      await client.execute(toPgParams("DELETE FROM deployments WHERE project_id = ?"), [projectId]);
      await client.execute(toPgParams("DELETE FROM prd_metadata WHERE project_id = ?"), [
        projectId,
      ]);
      await client.execute(toPgParams("DELETE FROM prd_snapshots WHERE project_id = ?"), [
        projectId,
      ]);
      await client.execute(toPgParams("DELETE FROM project_conversations WHERE project_id = ?"), [
        projectId,
      ]);
      await client.execute(toPgParams("DELETE FROM planning_runs WHERE project_id = ?"), [
        projectId,
      ]);
      await client.execute(toPgParams("DELETE FROM agent_instructions WHERE project_id = ?"), [
        projectId,
      ]);
      await client.execute(toPgParams("DELETE FROM project_workflows WHERE project_id = ?"), [
        projectId,
      ]);
      await client.execute(toPgParams("DELETE FROM repo_file_migrations WHERE project_id = ?"), [
        projectId,
      ]);
      await client.execute(
        toPgParams("DELETE FROM help_chat_histories WHERE scope_key = ? OR scope_key = ?"),
        [`project:${projectId}`, projectId]
      );
      await this.planAuditorSIFacade.planDeleteAllForProject(projectId);
      await client.execute(toPgParams("DELETE FROM open_questions WHERE project_id = ?"), [
        projectId,
      ]);
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
    return getCumulativeAttemptsFromIssueHelper(issue);
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
    return hasLabelHelper(issue, label);
  }

  getFileScopeLabels(
    issue: StoredTask
  ): { modify?: string[]; create?: string[]; test?: string[] } | null {
    return getFileScopeLabelsHelper(issue);
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

  getConflictFilesFromIssue(issue: StoredTask): string[] {
    return getConflictFilesFromIssueHelper(issue);
  }

  async setConflictFiles(projectId: string, id: string, files: string[]): Promise<void> {
    const issue = await this.show(projectId, id);
    const labels = (issue.labels ?? []) as string[];
    const existing = labels.find((l) => l.startsWith("conflict_files:"));
    if (existing) {
      await this.removeLabel(projectId, id, existing);
    }
    if (files.length > 0) {
      await this.addLabel(projectId, id, `conflict_files:${JSON.stringify(files)}`);
    }
  }

  getMergeStageFromIssue(issue: StoredTask): string | null {
    return getMergeStageFromIssueHelper(issue);
  }

  async setMergeStage(projectId: string, id: string, stage: string | null): Promise<void> {
    const issue = await this.show(projectId, id);
    const labels = (issue.labels ?? []) as string[];
    const existing = labels.find((l) => l.startsWith("merge_stage:"));
    if (existing) {
      await this.removeLabel(projectId, id, existing);
    }
    if (stage && stage.trim()) {
      await this.addLabel(projectId, id, `merge_stage:${stage.trim()}`);
    }
  }

  /** No-op. Dolt sync removed — persistence is handled by Postgres. */
  async syncForPush(_projectId: string): Promise<void> {}

  // ──── Plan / Auditor / Self-improvement (delegated to facade) ────

  async planInsert(projectId: string, planId: string, data: PlanInsertData): Promise<void> {
    return this.planAuditorSIFacade.planInsert(projectId, planId, data);
  }

  async planGet(
    projectId: string,
    planId: string
  ): Promise<{
    content: string;
    metadata: Record<string, unknown>;
    shipped_content: string | null;
    updated_at: string;
    current_version_number: number;
    last_executed_version_number: number | null;
  } | null> {
    return this.planAuditorSIFacade.planGet(projectId, planId);
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
    current_version_number: number;
    last_executed_version_number: number | null;
  } | null> {
    return this.planAuditorSIFacade.planGetByEpicId(projectId, epicId);
  }

  async planListIds(projectId: string): Promise<string[]> {
    return this.planAuditorSIFacade.planListIds(projectId);
  }

  async planUpdateContent(
    projectId: string,
    planId: string,
    content: string,
    currentVersionNumber?: number
  ): Promise<void> {
    return this.planAuditorSIFacade.planUpdateContent(
      projectId,
      planId,
      content,
      currentVersionNumber
    );
  }

  async planUpdateMetadata(
    projectId: string,
    planId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    return this.planAuditorSIFacade.planUpdateMetadata(projectId, planId, metadata);
  }

  async planSetShippedContent(
    projectId: string,
    planId: string,
    shippedContent: string
  ): Promise<void> {
    return this.planAuditorSIFacade.planSetShippedContent(projectId, planId, shippedContent);
  }

  async planGetShippedContent(projectId: string, planId: string): Promise<string | null> {
    return this.planAuditorSIFacade.planGetShippedContent(projectId, planId);
  }

  async planUpdateVersionNumbers(
    projectId: string,
    planId: string,
    updates: { current_version_number?: number; last_executed_version_number?: number | null }
  ): Promise<void> {
    return this.planAuditorSIFacade.planUpdateVersionNumbers(projectId, planId, updates);
  }

  async planVersionList(projectId: string, planId: string): Promise<PlanVersionListItem[]> {
    return this.planAuditorSIFacade.planVersionList(projectId, planId);
  }

  async planVersionGetByVersionNumber(
    projectId: string,
    planId: string,
    versionNumber: number
  ): Promise<PlanVersionRow> {
    return this.planAuditorSIFacade.planVersionGetByVersionNumber(projectId, planId, versionNumber);
  }

  async planVersionInsert(data: PlanVersionInsert): Promise<PlanVersionRow> {
    return this.planAuditorSIFacade.planVersionInsert(data);
  }

  async planVersionUpdateContent(
    projectId: string,
    planId: string,
    versionNumber: number,
    content: string,
    title?: string | null
  ): Promise<void> {
    return this.planAuditorSIFacade.planVersionUpdateContent(
      projectId,
      planId,
      versionNumber,
      content,
      title
    );
  }

  async planVersionSetExecutedVersion(
    projectId: string,
    planId: string,
    versionNumber: number
  ): Promise<void> {
    return this.planAuditorSIFacade.planVersionSetExecutedVersion(projectId, planId, versionNumber);
  }

  async planDelete(projectId: string, planId: string): Promise<boolean> {
    return this.planAuditorSIFacade.planDelete(projectId, planId);
  }

  async listPlanVersions(projectId: string, planId: string): Promise<PlanVersionListItem[]> {
    return this.planAuditorSIFacade.listPlanVersions(projectId, planId);
  }

  async getPlanVersionByNumber(
    projectId: string,
    planId: string,
    versionNumber: number
  ): Promise<PlanVersionRow> {
    return this.planAuditorSIFacade.getPlanVersionByNumber(projectId, planId, versionNumber);
  }

  async auditorRunInsert(record: AuditorRunInsert): Promise<AuditorRunRecord> {
    return this.planAuditorSIFacade.auditorRunInsert(record);
  }

  async listAuditorRunsByPlanId(projectId: string, planId: string): Promise<AuditorRunRecord[]> {
    return this.planAuditorSIFacade.listAuditorRunsByPlanId(projectId, planId);
  }

  async insertSelfImprovementRunHistory(
    record: SelfImprovementRunHistoryInsert
  ): Promise<SelfImprovementRunHistoryRecord> {
    return this.planAuditorSIFacade.insertSelfImprovementRunHistory(record);
  }

  async listSelfImprovementRunHistory(
    projectId: string,
    limit?: number
  ): Promise<SelfImprovementRunHistoryRecord[]> {
    return this.planAuditorSIFacade.listSelfImprovementRunHistory(projectId, limit);
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
   * Uses withWriteLock directly because VACUUM cannot run inside a transaction.
   * Vacuum only the current schema's agent_sessions table so concurrent test runs do not
   * trigger full-database VACUUM work against each other.
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

      const pruned = await client.execute(toPgParams("DELETE FROM agent_sessions WHERE id < ?"), [
        cutoffId,
      ]);

      const url = await getDatabaseUrl().catch(() => "");
      const dialect = url ? getDatabaseDialect(url) : "postgres";
      const vacuumSql = dialect === "sqlite" ? "VACUUM" : "VACUUM agent_sessions";
      await client.execute(vacuumSql);
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
