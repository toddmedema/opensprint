import fs from "fs";
import path from "path";
import crypto from "crypto";
import initSqlJs, { type Database } from "sql.js";
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

const log = createLogger("task-store");

function getDbPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(home, ".opensprint", "tasks.db");
}

const DB_EXT_BACKUP = ".bak";
const DB_EXT_TMP = ".tmp";

function isCorruptionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("malformed") || msg.includes("corrupt") || msg.includes("database disk image");
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL,
    title         TEXT NOT NULL,
    description   TEXT,
    issue_type    TEXT NOT NULL DEFAULT 'task',
    status        TEXT NOT NULL DEFAULT 'open',
    priority      INTEGER NOT NULL DEFAULT 2,
    assignee      TEXT,
    owner         TEXT,
    labels        TEXT DEFAULT '[]',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    created_by    TEXT,
    close_reason  TEXT,
    started_at    TEXT,
    completed_at  TEXT,
    complexity    INTEGER,
    extra         TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id       TEXT NOT NULL,
    depends_on_id TEXT NOT NULL,
    dep_type      TEXT NOT NULL DEFAULT 'blocks',
    PRIMARY KEY (task_id, depends_on_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee) WHERE assignee IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deps_task ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_deps_depends ON task_dependencies(depends_on_id);

-- Feedback (SQL-only)
CREATE TABLE IF NOT EXISTS feedback (
    id                TEXT NOT NULL,
    project_id        TEXT NOT NULL,
    text              TEXT NOT NULL,
    category          TEXT NOT NULL,
    mapped_plan_id    TEXT,
    created_task_ids  TEXT NOT NULL DEFAULT '[]',
    status            TEXT NOT NULL,
    created_at        TEXT NOT NULL,
    task_titles       TEXT,
    proposed_tasks    TEXT,
    mapped_epic_id    TEXT,
    is_scope_change   INTEGER,
    feedback_source_task_id TEXT,
    parent_id         TEXT,
    depth             INTEGER,
    user_priority     INTEGER,
    image_paths       TEXT,
    extra             TEXT DEFAULT '{}',
    PRIMARY KEY (id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_feedback_project_id ON feedback(project_id);
CREATE INDEX IF NOT EXISTS idx_feedback_parent_id ON feedback(parent_id) WHERE parent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS feedback_inbox (
    project_id   TEXT NOT NULL,
    feedback_id  TEXT NOT NULL,
    enqueued_at  TEXT NOT NULL,
    PRIMARY KEY (project_id, feedback_id)
);
CREATE INDEX IF NOT EXISTS idx_feedback_inbox_project_enqueued ON feedback_inbox(project_id, enqueued_at);

-- Agent sessions (SQL-only)
CREATE TABLE IF NOT EXISTS agent_sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   TEXT NOT NULL,
    task_id      TEXT NOT NULL,
    attempt      INTEGER NOT NULL,
    agent_type   TEXT NOT NULL,
    agent_model  TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    completed_at TEXT,
    status       TEXT NOT NULL,
    output_log   TEXT,
    git_branch   TEXT NOT NULL,
    git_diff     TEXT,
    test_results TEXT,
    failure_reason TEXT,
    summary      TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_project_task ON agent_sessions(project_id, task_id);

-- Agent stats (SQL-only)
CREATE TABLE IF NOT EXISTS agent_stats (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   TEXT NOT NULL,
    task_id      TEXT NOT NULL,
    agent_id     TEXT NOT NULL,
    model        TEXT NOT NULL,
    attempt      INTEGER NOT NULL,
    started_at   TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    outcome      TEXT NOT NULL,
    duration_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_stats_project ON agent_stats(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_stats_task ON agent_stats(task_id);

-- Orchestrator events (SQL-only)
CREATE TABLE IF NOT EXISTS orchestrator_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    task_id    TEXT NOT NULL,
    timestamp  TEXT NOT NULL,
    event      TEXT NOT NULL,
    data       TEXT
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_events_project ON orchestrator_events(project_id);
CREATE INDEX IF NOT EXISTS idx_orchestrator_events_task ON orchestrator_events(task_id);
CREATE INDEX IF NOT EXISTS idx_orchestrator_events_timestamp ON orchestrator_events(timestamp);

-- Orchestrator counters (SQL-only)
CREATE TABLE IF NOT EXISTS orchestrator_counters (
    project_id    TEXT PRIMARY KEY,
    total_done    INTEGER NOT NULL DEFAULT 0,
    total_failed  INTEGER NOT NULL DEFAULT 0,
    queue_depth   INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL
);

-- Deployments (SQL-only)
CREATE TABLE IF NOT EXISTS deployments (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL,
    status            TEXT NOT NULL,
    started_at        TEXT NOT NULL,
    completed_at      TEXT,
    commit_hash       TEXT,
    target            TEXT,
    mode              TEXT,
    url               TEXT,
    error             TEXT,
    log               TEXT NOT NULL DEFAULT '[]',
    previous_deploy_id TEXT,
    rolled_back_by    TEXT,
    fix_epic_id       TEXT
);
CREATE INDEX IF NOT EXISTS idx_deployments_project_id ON deployments(project_id);

-- Plans (SQL-only; content and metadata moved from .opensprint/plans/)
-- gate_task_id nullable for epic-blocked model (no gate tasks)
CREATE TABLE IF NOT EXISTS plans (
    project_id              TEXT NOT NULL,
    plan_id                  TEXT NOT NULL,
    epic_id                  TEXT NOT NULL,
    gate_task_id             TEXT,
    re_execute_gate_task_id  TEXT,
    content                  TEXT NOT NULL,
    metadata                 TEXT NOT NULL,
    shipped_content          TEXT,
    updated_at               TEXT NOT NULL,
    PRIMARY KEY (project_id, plan_id)
);
CREATE INDEX IF NOT EXISTS idx_plans_project_id ON plans(project_id);
CREATE INDEX IF NOT EXISTS idx_plans_project_epic ON plans(project_id, epic_id);

-- Open questions / notifications (agent clarification requests + API-blocked human notifications)
CREATE TABLE IF NOT EXISTS open_questions (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL,
    source       TEXT NOT NULL,
    source_id    TEXT NOT NULL,
    questions    TEXT NOT NULL DEFAULT '[]',
    status       TEXT NOT NULL DEFAULT 'open',
    created_at   TEXT NOT NULL,
    resolved_at  TEXT,
    kind         TEXT NOT NULL DEFAULT 'open_question',
    error_code   TEXT
);
CREATE INDEX IF NOT EXISTS idx_open_questions_project_id ON open_questions(project_id);
CREATE INDEX IF NOT EXISTS idx_open_questions_status ON open_questions(status);
`;

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

/**
 * sql.js-backed task store. Replaces the old Dolt/CLI task system with
 * an in-memory SQLite database persisted to ~/.opensprint/tasks.db.
 */
const SAVE_DEBOUNCE_MS = 80;

/** Callback invoked when a task is created, updated, or closed. Used to emit WebSocket events. */
export type TaskChangeCallback = (
  projectId: string,
  changeType: "create" | "update" | "close",
  task: StoredTask
) => void;

export class TaskStoreService {
  private db: Database | null = null;
  private writeLock: Promise<void> = Promise.resolve();
  private dbPath: string;
  private injectedDb: Database | null = null;
  /** Serializes init so only one run runs at a time; concurrent callers await the same promise. */
  private initPromise: Promise<void> | null = null;
  /** Debounced save: timer for scheduling a single save after mutations. */
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  /** One-time registration of beforeExit so we flush on process shutdown. */
  private beforeExitRegistered = false;
  /** Optional callback to emit WebSocket events on task create/update/close. */
  private onTaskChange: TaskChangeCallback | null = null;

  constructor(injectedDb?: Database) {
    this.dbPath = getDbPath();
    if (injectedDb) {
      this.injectedDb = injectedDb;
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
    if (this.db) return;

    if (this.injectedDb) {
      this.db = this.injectedDb;
      this.db.run(SCHEMA_SQL);
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

  /**
   * Actual init work: load DB, run schema/migrations, persist under write lock.
   * Only one run executes at a time; callers serialize via initPromise in init().
   */
  private async runInitInternal(): Promise<void> {
    const SQL = await initSqlJs({
      locateFile: (file: string) => {
        const decodedPath = decodeURIComponent(new URL(import.meta.url).pathname);
        const candidates = [
          path.join(
            path.dirname(decodedPath),
            "..",
            "..",
            "node_modules",
            "sql.js",
            "dist",
            file
          ),
          path.join(
            path.dirname(decodedPath),
            "..",
            "..",
            "..",
            "..",
            "node_modules",
            "sql.js",
            "dist",
            file
          ),
        ];
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) return candidate;
        }
        return candidates[0];
      },
    });

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const candidates = [
      this.dbPath,
      this.dbPath + DB_EXT_BACKUP,
      this.dbPath + DB_EXT_TMP,
    ] as const;
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      try {
        const buf = fs.readFileSync(candidate);
        this.db = new SQL.Database(buf);
        this.db.run("PRAGMA quick_check");
        log.info("Loaded task DB from disk", {
          path: candidate === this.dbPath ? this.dbPath : candidate,
          fallback: candidate !== this.dbPath,
        });
        break;
      } catch (err) {
        if (isCorruptionError(err)) {
          log.warn("Task DB file corrupted, trying next candidate", {
            path: candidate,
            error: err instanceof Error ? err.message : String(err),
          });
          this.db?.close();
          this.db = null;
          continue;
        }
        throw err;
      }
    }
    if (!this.db) {
      this.db = new SQL.Database();
      log.info("Created new task DB", { path: this.dbPath });
    }

    this.db.run(SCHEMA_SQL);
    this.migrateTaskDurationColumns();
    this.migrateTaskComplexityColumn();
    this.migrateOpenQuestionsKind();
    await this.migratePlansWithGateTasks();
    await this.withWriteLock(async () => {
      await this.saveToDisk(); // initial save immediately, not debounced
    });
    this.registerBeforeExit();
  }

  /** Register process beforeExit once so we flush pending save on shutdown. */
  private registerBeforeExit(): void {
    if (this.injectedDb || this.beforeExitRegistered) return;
    this.beforeExitRegistered = true;
    process.on("beforeExit", () => {
      this.flushSave().catch((err) => {
        log.warn("Task store flush on exit failed", { error: err instanceof Error ? err.message : String(err) });
      });
    });
  }

  /**
   * Migration: Add started_at and completed_at columns for task duration metadata.
   */
  private migrateTaskDurationColumns(): void {
    const db = this.ensureDb();
    const stmt = db.prepare(
      "SELECT COUNT(*) as cnt FROM pragma_table_info('tasks') WHERE name = ?"
    );
    stmt.bind(["started_at"]);
    const hasStartedAt = stmt.step() && (stmt.getAsObject().cnt as number) > 0;
    stmt.free();

    if (!hasStartedAt) {
      db.run("ALTER TABLE tasks ADD COLUMN started_at TEXT");
      log.info("Added started_at column to tasks");
    }

    const stmt2 = db.prepare(
      "SELECT COUNT(*) as cnt FROM pragma_table_info('tasks') WHERE name = ?"
    );
    stmt2.bind(["completed_at"]);
    const hasCompletedAt = stmt2.step() && (stmt2.getAsObject().cnt as number) > 0;
    stmt2.free();

    if (!hasCompletedAt) {
      db.run("ALTER TABLE tasks ADD COLUMN completed_at TEXT");
      log.info("Added completed_at column to tasks");
    }
  }

  /**
   * Migration: Add complexity column (integer 1-10) for tasks and epics.
   * Replaces legacy simple/complex stored in extra JSON.
   */
  private migrateTaskComplexityColumn(): void {
    const db = this.ensureDb();
    const stmt = db.prepare(
      "SELECT COUNT(*) as cnt FROM pragma_table_info('tasks') WHERE name = ?"
    );
    stmt.bind(["complexity"]);
    const hasComplexity = stmt.step() && (stmt.getAsObject().cnt as number) > 0;
    stmt.free();

    if (!hasComplexity) {
      db.run("ALTER TABLE tasks ADD COLUMN complexity INTEGER");
      log.info("Added complexity column to tasks");
    }
  }

  /**
   * Migration: Add kind column to open_questions for API-blocked human notifications.
   */
  private migrateOpenQuestionsKind(): void {
    const db = this.ensureDb();
    const stmt = db.prepare(
      "SELECT COUNT(*) as cnt FROM pragma_table_info('open_questions') WHERE name = ?"
    );
    stmt.bind(["kind"]);
    const hasKind = stmt.step() && (stmt.getAsObject().cnt as number) > 0;
    stmt.free();

    if (!hasKind) {
      db.run("ALTER TABLE open_questions ADD COLUMN kind TEXT NOT NULL DEFAULT 'open_question'");
      log.info("Added kind column to open_questions");
    }

    const stmt2 = db.prepare(
      "SELECT COUNT(*) as cnt FROM pragma_table_info('open_questions') WHERE name = ?"
    );
    stmt2.bind(["error_code"]);
    const hasErrorCode = stmt2.step() && (stmt2.getAsObject().cnt as number) > 0;
    stmt2.free();

    if (!hasErrorCode) {
      db.run("ALTER TABLE open_questions ADD COLUMN error_code TEXT");
      log.info("Added error_code column to open_questions");
    }
  }

  /**
   * Migration: Epic-blocked model. Plans with gate_task_id are migrated:
   * - If gate task is closed → set epic status "open"
   * - If gate task is open or missing → set epic status "blocked"
   * - Delete gate task and its dependency rows
   * - Clear gate_task_id and re_execute_gate_task_id on plan row
   */
  private async migratePlansWithGateTasks(): Promise<void> {
    if (this.injectedDb) return;
    const db = this.ensureDb();
    const stmt = db.prepare(
      "SELECT project_id, plan_id, epic_id, gate_task_id, re_execute_gate_task_id FROM plans WHERE (gate_task_id IS NOT NULL AND gate_task_id != '') OR (re_execute_gate_task_id IS NOT NULL AND re_execute_gate_task_id != '')"
    );
    const rows: Array<{
      project_id: string;
      plan_id: string;
      epic_id: string;
      gate_task_id: string | null;
      re_execute_gate_task_id: string | null;
    }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      rows.push({
        project_id: row.project_id as string,
        plan_id: row.plan_id as string,
        epic_id: row.epic_id as string,
        gate_task_id: (row.gate_task_id as string) || null,
        re_execute_gate_task_id: (row.re_execute_gate_task_id as string) || null,
      });
    }
    stmt.free();
    if (rows.length === 0) return;

    const gateIds = new Set<string>();
    for (const r of rows) {
      if (r.gate_task_id) gateIds.add(r.gate_task_id);
      if (r.re_execute_gate_task_id) gateIds.add(r.re_execute_gate_task_id);
    }

    for (const r of rows) {
      const epicId = r.epic_id;
      if (!epicId) continue;
      let epicStatus: "open" | "blocked" = "blocked";
      for (const gateId of [r.gate_task_id, r.re_execute_gate_task_id]) {
        if (!gateId) continue;
        try {
          const gateTask = this.show(r.project_id, gateId);
          if ((gateTask.status as string) === "closed") epicStatus = "open";
        } catch {
          // Gate task missing — treat as not approved
        }
      }
      db.run("UPDATE tasks SET status = ? WHERE id = ? AND project_id = ?", [
        epicStatus,
        epicId,
        r.project_id,
      ]);
    }

    for (const gateId of gateIds) {
      const planRow = rows.find(
        (r) => r.gate_task_id === gateId || r.re_execute_gate_task_id === gateId
      );
      if (!planRow) continue;
      db.run("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?", [
        gateId,
        gateId,
      ]);
      db.run("DELETE FROM tasks WHERE id = ? AND project_id = ?", [gateId, planRow.project_id]);
    }

    for (const r of rows) {
      db.run(
        "UPDATE plans SET gate_task_id = NULL, re_execute_gate_task_id = NULL WHERE project_id = ? AND plan_id = ?",
        [r.project_id, r.plan_id]
      );
    }
    log.info("Migrated plans with gate tasks to epic-blocked model", { count: rows.length });
  }

  protected ensureDb(): Database {
    if (!this.db) {
      throw new AppError(
        500,
        ErrorCodes.TASK_STORE_INIT_FAILED,
        "Task store not initialized. Call init() first."
      );
    }
    return this.db;
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

  private async saveToDisk(): Promise<void> {
    if (this.injectedDb) return;
    const db = this.ensureDb();
    const data = db.export();
    // Safeguard: never overwrite an existing non-empty DB with an empty in-memory state
    const taskCount = db.exec("SELECT COUNT(*) as c FROM tasks")[0]?.values[0]?.[0] ?? 0;
    if (taskCount === 0 && data.byteLength < 2048) {
      try {
        const st = await fs.promises.stat(this.dbPath);
        if (st.size > 2048) {
          log.error("Refusing to overwrite non-empty task DB with empty in-memory state", {
            path: this.dbPath,
            existingSize: st.size,
          });
          return;
        }
      } catch {
        // File doesn't exist, safe to write
      }
    }
    const tmp = this.dbPath + DB_EXT_TMP;
    const bak = this.dbPath + DB_EXT_BACKUP;
    const dir = path.dirname(this.dbPath);
    const maxAttempts = 3; // initial + 2 retries
    const delayMs = 100;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        const f = await fs.promises.open(tmp, "w");
        try {
          await f.write(Buffer.from(data));
          await f.sync();
        } finally {
          await f.close();
        }
        if (fs.existsSync(this.dbPath)) {
          await fs.promises.rename(this.dbPath, bak);
        }
        await fs.promises.rename(tmp, this.dbPath);
        return;
      } catch (err) {
        lastErr = err;
        if (fs.existsSync(tmp)) {
          try {
            await fs.promises.unlink(tmp);
          } catch {
            /* ignore */
          }
        }
        if (attempt < maxAttempts) {
          log.warn("Task store save failed, retrying", {
            attempt,
            maxAttempts,
            error: err instanceof Error ? err.message : String(err),
          });
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    throw lastErr;
  }

  /**
   * Schedule a debounced save. Multiple mutations within SAVE_DEBOUNCE_MS result in one save.
   * No-op for injected (in-memory) DB. Call flushPersist() to force an immediate save (e.g. on shutdown).
   */
  private scheduleSave(): void {
    if (this.injectedDb) return;
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.withWriteLock(async () => {
        await this.saveToDisk();
      }).catch((err) => {
        log.error("Task store debounced save failed", { error: err instanceof Error ? err.message : String(err) });
      });
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Cancel any pending debounced save and run save immediately under the write lock.
   * Use on graceful shutdown so the last burst of changes is persisted.
   */
  private async flushSave(): Promise<void> {
    if (this.injectedDb) return;
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    await this.withWriteLock(async () => {
      await this.saveToDisk();
    });
  }

  /**
   * Load all dependency rows and dependent counts for a project in two queries (batch).
   * Used by listAll/list to avoid N+1 when hydrating many tasks.
   */
  private loadDepsMapsForProject(projectId: string): {
    depsByTaskId: Map<string, Array<{ depends_on_id: string; type: string }>>;
    dependentCountByTaskId: Map<string, number>;
  } {
    const db = this.ensureDb();
    const depsByTaskId = new Map<string, Array<{ depends_on_id: string; type: string }>>();
    const dependentCountByTaskId = new Map<string, number>();

    const depStmt = db.prepare(
      "SELECT task_id, depends_on_id, dep_type FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)"
    );
    depStmt.bind([projectId]);
    while (depStmt.step()) {
      const row = depStmt.getAsObject();
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
    depStmt.free();

    const countStmt = db.prepare(
      "SELECT depends_on_id, COUNT(*) as cnt FROM task_dependencies WHERE depends_on_id IN (SELECT id FROM tasks WHERE project_id = ?) GROUP BY depends_on_id"
    );
    countStmt.bind([projectId]);
    while (countStmt.step()) {
      const row = countStmt.getAsObject();
      dependentCountByTaskId.set(row.depends_on_id as string, (row.cnt as number) ?? 0);
    }
    countStmt.free();

    return { depsByTaskId, dependentCountByTaskId };
  }

  private hydrateTask(
    row: Record<string, unknown>,
    depsByTaskId?: Map<string, Array<{ depends_on_id: string; type: string }>>,
    dependentCountByTaskId?: Map<string, number>
  ): StoredTask {
    const db = this.ensureDb();
    const labels: string[] = JSON.parse((row.labels as string) || "[]");
    const extra: Record<string, unknown> = JSON.parse((row.extra as string) || "{}");

    let deps: Array<{ depends_on_id: string; type: string }>;
    let dependentCount: number;

    if (depsByTaskId != null && dependentCountByTaskId != null) {
      deps = depsByTaskId.get(row.id as string) ?? [];
      dependentCount = dependentCountByTaskId.get(row.id as string) ?? 0;
    } else {
      deps = [];
      const depStmt = db.prepare(
        "SELECT depends_on_id, dep_type FROM task_dependencies WHERE task_id = ?"
      );
      depStmt.bind([row.id as string]);
      while (depStmt.step()) {
        const depRow = depStmt.getAsObject();
        deps.push({
          depends_on_id: depRow.depends_on_id as string,
          type: depRow.dep_type as string,
        });
      }
      depStmt.free();

      const depCountStmt = db.prepare(
        "SELECT COUNT(*) as cnt FROM task_dependencies WHERE depends_on_id = ?"
      );
      depCountStmt.bind([row.id as string]);
      depCountStmt.step();
      dependentCount = (depCountStmt.getAsObject().cnt as number) ?? 0;
      depCountStmt.free();
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

  /** Run query and hydrate rows using batched deps/counts for the project (avoids N+1). */
  private execAndHydrateWithDeps(
    projectId: string,
    sql: string,
    params?: unknown[]
  ): StoredTask[] {
    const db = this.ensureDb();
    const stmt = db.prepare(sql);
    if (params) stmt.bind(params);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    if (rows.length === 0) return [];
    const { depsByTaskId, dependentCountByTaskId } = this.loadDepsMapsForProject(projectId);
    return rows.map((row) =>
      this.hydrateTask(row, depsByTaskId, dependentCountByTaskId)
    );
  }

  private execAndHydrate(sql: string, params?: unknown[]): StoredTask[] {
    const db = this.ensureDb();
    const stmt = db.prepare(sql);
    if (params) stmt.bind(params);
    const results: StoredTask[] = [];
    while (stmt.step()) {
      results.push(this.hydrateTask(stmt.getAsObject()));
    }
    stmt.free();
    return results;
  }

  private generateId(projectId: string, parentId?: string): string {
    const db = this.ensureDb();
    if (parentId) {
      const stmt = db.prepare(
        "SELECT id FROM tasks WHERE id LIKE ? AND project_id = ? ORDER BY id"
      );
      const pattern = `${parentId}.%`;
      stmt.bind([pattern, projectId]);
      let maxSeq = 0;
      while (stmt.step()) {
        const childId = stmt.getAsObject().id as string;
        const suffix = childId.slice(parentId.length + 1);
        const seq = parseInt(suffix.split(".")[0], 10);
        if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
      }
      stmt.free();
      return `${parentId}.${maxSeq + 1}`;
    }
    const hex = crypto.randomBytes(2).toString("hex");
    return `os-${hex}`;
  }

  // ──── Read methods (synchronous SQL, no lock needed) ────

  show(projectId: string, id: string): StoredTask {
    const db = this.ensureDb();
    const stmt = db.prepare("SELECT * FROM tasks WHERE id = ? AND project_id = ?");
    stmt.bind([id, projectId]);
    if (!stmt.step()) {
      stmt.free();
      throw new AppError(404, ErrorCodes.ISSUE_NOT_FOUND, `Task ${id} not found`, { issueId: id });
    }
    const task = this.hydrateTask(stmt.getAsObject());
    stmt.free();
    return task;
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
    const blocked = this.execAndHydrateWithDeps(
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
      const issue = this.show(projectId, id);
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
      const db = this.ensureDb();
      const id = this.generateId(projectId, options.parentId);
      const now = new Date().toISOString();
      const type = (options.type as string) ?? "task";
      const priority = options.priority ?? 2;
      const complexity = clampTaskComplexity(options.complexity);
      const baseExtra: Record<string, unknown> = { ...options.extra };
      const extra = JSON.stringify(baseExtra);

      db.run(
        `INSERT INTO tasks (id, project_id, title, description, issue_type, status, priority, assignee, labels, created_at, updated_at, complexity, extra)
         VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, '[]', ?, ?, ?, ?)`,
        [id, projectId, title, options.description ?? null, type, priority, now, now, complexity ?? null, extra]
      );

      if (options.parentId) {
        db.run(
          "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, dep_type) VALUES (?, ?, 'parent-child')",
          [id, options.parentId]
        );
      }

      this.scheduleSave();
      const task = this.show(projectId, id);
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
      const db = this.ensureDb();
      // Pre-generate ids so we don't rely on SELECT seeing uncommitted rows inside the transaction
      const ids: string[] = [];
      const parentIdToNextSeq = new Map<string, number>();
      for (const input of inputs) {
        const parentId = input.parentId;
        if (!parentId) {
          ids.push(this.generateId(projectId, undefined));
          continue;
        }
        let next = parentIdToNextSeq.get(parentId);
        if (next === undefined) {
          const stmt = db.prepare(
            "SELECT id FROM tasks WHERE id LIKE ? AND project_id = ? ORDER BY id"
          );
          const pattern = `${parentId}.%`;
          stmt.bind([pattern, projectId]);
          let maxSeq = 0;
          while (stmt.step()) {
            const childId = stmt.getAsObject().id as string;
            const suffix = childId.slice(parentId.length + 1);
            const seq = parseInt(suffix.split(".")[0], 10);
            if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
          }
          stmt.free();
          next = maxSeq + 1;
        }
        parentIdToNextSeq.set(parentId, next + 1);
        ids.push(`${parentId}.${next}`);
      }
      db.run("BEGIN TRANSACTION");
      try {
        const now = new Date().toISOString();
        for (let i = 0; i < inputs.length; i++) {
          const input = inputs[i]!;
          const id = ids[i]!;
          const type = (input.type as string) ?? "task";
          const priority = input.priority ?? 2;
          const complexity = clampTaskComplexity(input.complexity);

          db.run(
            `INSERT INTO tasks (id, project_id, title, description, issue_type, status, priority, assignee, labels, created_at, updated_at, complexity, extra)
             VALUES (?, ?, ?, ?, ?, 'open', ?, NULL, '[]', ?, ?, ?, ?)`,
            [id, projectId, input.title, input.description ?? null, type, priority, now, now, complexity ?? null, "{}"]
          );

          if (input.parentId) {
            db.run(
              "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, dep_type) VALUES (?, ?, 'parent-child')",
              [id, input.parentId]
            );
          }
        }
        db.run("COMMIT");
      } catch (err) {
        db.run("ROLLBACK");
        throw err;
      }
      this.scheduleSave();
      const tasks = ids.map((id) => this.show(projectId, id));
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
      const db = this.ensureDb();
      const now = new Date().toISOString();
      const sets: string[] = ["updated_at = ?"];
      const vals: unknown[] = [now];

      if (options.title != null) {
        sets.push("title = ?");
        vals.push(options.title);
      }
      if (options.claim) {
        sets.push("status = ?");
        vals.push("in_progress");
        if (options.assignee != null) {
          sets.push("assignee = ?");
          vals.push(options.assignee);
        }
      } else {
        if (options.status != null) {
          sets.push("status = ?");
          vals.push(options.status);
        }
        if (options.assignee != null) {
          sets.push("assignee = ?");
          vals.push(options.assignee);
        }
      }

      // Set started_at when assignee is first set (first Coder agent picks up task)
      const assigneeBeingSet =
        options.assignee != null && options.assignee.trim() !== "";
      if (assigneeBeingSet) {
        const stmt = db.prepare("SELECT started_at FROM tasks WHERE id = ? AND project_id = ?");
        stmt.bind([id, projectId]);
        if (stmt.step()) {
          const row = stmt.getAsObject();
          const currentStartedAt = row.started_at as string | null | undefined;
          if (currentStartedAt == null || currentStartedAt === "") {
            sets.push("started_at = ?");
            vals.push(now);
          }
        }
        stmt.free();
      }

      if (options.description != null) {
        sets.push("description = ?");
        vals.push(options.description);
      }
      if (options.priority != null) {
        sets.push("priority = ?");
        vals.push(options.priority);
      }
      if (options.complexity !== undefined) {
        const c = clampTaskComplexity(options.complexity);
        sets.push("complexity = ?");
        vals.push(c ?? null);
      }

      if (
        options.extra != null ||
        options.block_reason !== undefined ||
        options.last_auto_retry_at !== undefined
      ) {
        const stmt = db.prepare("SELECT extra FROM tasks WHERE id = ? AND project_id = ?");
        stmt.bind([id, projectId]);
        if (stmt.step()) {
          const row = stmt.getAsObject();
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
          sets.push("extra = ?");
          vals.push(JSON.stringify(merged));
        }
        stmt.free();
      }

      vals.push(id, projectId);
      db.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND project_id = ?`, vals);
      if (db.getRowsModified() === 0) {
        throw new AppError(404, ErrorCodes.ISSUE_NOT_FOUND, `Task ${id} not found`, {
          issueId: id,
        });
      }
      this.scheduleSave();
      const task = this.show(projectId, id);
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
      const db = this.ensureDb();
      db.run("BEGIN TRANSACTION");
      try {
        for (const u of updates) {
          const now = new Date().toISOString();
          const sets: string[] = ["updated_at = ?"];
          const vals: unknown[] = [now];
          if (u.status != null) {
            sets.push("status = ?");
            vals.push(u.status);
          }
          if (u.assignee != null) {
            sets.push("assignee = ?");
            vals.push(u.assignee);
            if (u.assignee.trim() !== "") {
              const stmt = db.prepare("SELECT started_at FROM tasks WHERE id = ? AND project_id = ?");
              stmt.bind([u.id, projectId]);
              if (stmt.step()) {
                const row = stmt.getAsObject();
                const currentStartedAt = row.started_at as string | null | undefined;
                if (currentStartedAt == null || currentStartedAt === "") {
                  sets.push("started_at = ?");
                  vals.push(now);
                }
              }
              stmt.free();
            }
          }
          if (u.description != null) {
            sets.push("description = ?");
            vals.push(u.description);
          }
          if (u.priority != null) {
            sets.push("priority = ?");
            vals.push(u.priority);
          }
          vals.push(u.id, projectId);
          db.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ? AND project_id = ?`, vals);
        }
        db.run("COMMIT");
      } catch (err) {
        db.run("ROLLBACK");
        throw err;
      }
      this.scheduleSave();
      const tasks = updates.map((u) => this.show(projectId, u.id));
      for (const task of tasks) {
        this.emitTaskChange(projectId, "update", task);
      }
      return tasks;
    });
  }

  async close(projectId: string, id: string, reason: string, _force = false): Promise<StoredTask> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const db = this.ensureDb();
      const now = new Date().toISOString();
      db.run(
        "UPDATE tasks SET status = 'closed', close_reason = ?, completed_at = ?, updated_at = ? WHERE id = ? AND project_id = ?",
        [reason, now, now, id, projectId]
      );
      if (db.getRowsModified() === 0) {
        throw new AppError(404, ErrorCodes.ISSUE_NOT_FOUND, `Task ${id} not found`, {
          issueId: id,
        });
      }
      this.scheduleSave();
      const task = this.show(projectId, id);
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
      const db = this.ensureDb();
      const now = new Date().toISOString();
      db.run("BEGIN TRANSACTION");
      try {
        for (const item of items) {
          db.run(
            "UPDATE tasks SET status = 'closed', close_reason = ?, completed_at = ?, updated_at = ? WHERE id = ? AND project_id = ?",
            [item.reason, now, now, item.id, projectId]
          );
        }
        db.run("COMMIT");
      } catch (err) {
        db.run("ROLLBACK");
        throw err;
      }
      this.scheduleSave();
      const tasks = items.map((item) => this.show(projectId, item.id));
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
      const db = this.ensureDb();
      db.run(
        "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, dep_type) VALUES (?, ?, ?)",
        [childId, parentId, type ?? "blocks"]
      );
      this.scheduleSave();
    });
  }

  async addDependencies(
    _projectId: string,
    deps: Array<{ childId: string; parentId: string; type?: string }>
  ): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const db = this.ensureDb();
      db.run("BEGIN TRANSACTION");
      try {
        for (const dep of deps) {
          db.run(
            "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, dep_type) VALUES (?, ?, ?)",
            [dep.childId, dep.parentId, dep.type ?? "blocks"]
          );
        }
        db.run("COMMIT");
      } catch (err) {
        db.run("ROLLBACK");
        throw err;
      }
      this.scheduleSave();
    });
  }

  async delete(projectId: string, id: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const db = this.ensureDb();
      db.run("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?", [id, id]);
      db.run("DELETE FROM tasks WHERE id = ? AND project_id = ?", [id, projectId]);
      if (db.getRowsModified() === 0) {
        throw new AppError(404, ErrorCodes.ISSUE_NOT_FOUND, `Task ${id} not found`, {
          issueId: id,
        });
      }
      this.scheduleSave();
    });
  }

  /** Delete multiple tasks by ID. Skips tasks that don't exist (e.g. already deleted). */
  async deleteMany(projectId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const db = this.ensureDb();
      const uniqueIds = [...new Set(ids)];
      db.run("BEGIN TRANSACTION");
      try {
        for (const id of uniqueIds) {
          db.run("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?", [id, id]);
          db.run("DELETE FROM tasks WHERE id = ? AND project_id = ?", [id, projectId]);
        }
        db.run("COMMIT");
      } catch (err) {
        db.run("ROLLBACK");
        throw err;
      }
      this.scheduleSave();
    });
  }

  /** Delete all open_questions for a project. Used when archiving (index-only removal). */
  async deleteOpenQuestionsByProjectId(projectId: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const db = this.ensureDb();
      db.run("DELETE FROM open_questions WHERE project_id = ?", [projectId]);
      this.scheduleSave();
    });
  }

  /** Delete all data for a project from every project-scoped table. */
  async deleteByProjectId(projectId: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const db = this.ensureDb();
      const stmt = db.prepare("SELECT id FROM tasks WHERE project_id = ?");
      stmt.bind([projectId]);
      const ids: string[] = [];
      while (stmt.step()) {
        ids.push(stmt.getAsObject().id as string);
      }
      stmt.free();
      for (const id of ids) {
        db.run("DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?", [id, id]);
      }
      db.run("DELETE FROM tasks WHERE project_id = ?", [projectId]);
      db.run("DELETE FROM feedback WHERE project_id = ?", [projectId]);
      db.run("DELETE FROM feedback_inbox WHERE project_id = ?", [projectId]);
      db.run("DELETE FROM agent_sessions WHERE project_id = ?", [projectId]);
      db.run("DELETE FROM agent_stats WHERE project_id = ?", [projectId]);
      db.run("DELETE FROM orchestrator_events WHERE project_id = ?", [projectId]);
      db.run("DELETE FROM orchestrator_counters WHERE project_id = ?", [projectId]);
      db.run("DELETE FROM deployments WHERE project_id = ?", [projectId]);
      db.run("DELETE FROM plans WHERE project_id = ?", [projectId]);
      db.run("DELETE FROM open_questions WHERE project_id = ?", [projectId]);
      this.scheduleSave();
    });
  }

  async comment(_projectId: string, _id: string, _message: string): Promise<void> {
    // Comments not supported in sql.js store — no-op for API compatibility
  }

  async addLabel(projectId: string, id: string, label: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const db = this.ensureDb();
      const stmt = db.prepare("SELECT labels FROM tasks WHERE id = ? AND project_id = ?");
      stmt.bind([id, projectId]);
      if (!stmt.step()) {
        stmt.free();
        throw new AppError(404, ErrorCodes.ISSUE_NOT_FOUND, `Task ${id} not found`);
      }
      const labels: string[] = JSON.parse((stmt.getAsObject().labels as string) || "[]");
      stmt.free();

      if (!labels.includes(label)) {
        labels.push(label);
        const now = new Date().toISOString();
        db.run("UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ? AND project_id = ?", [
          JSON.stringify(labels),
          now,
          id,
          projectId,
        ]);
        this.scheduleSave();
      }
    });
  }

  async removeLabel(projectId: string, id: string, label: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const db = this.ensureDb();
      const stmt = db.prepare("SELECT labels FROM tasks WHERE id = ? AND project_id = ?");
      stmt.bind([id, projectId]);
      if (!stmt.step()) {
        stmt.free();
        return;
      }
      const labels: string[] = JSON.parse((stmt.getAsObject().labels as string) || "[]");
      stmt.free();

      const idx = labels.indexOf(label);
      if (idx >= 0) {
        labels.splice(idx, 1);
        const now = new Date().toISOString();
        db.run("UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ? AND project_id = ?", [
          JSON.stringify(labels),
          now,
          id,
          projectId,
        ]);
        this.scheduleSave();
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
    const issue = this.show(projectId, id);
    return this.getCumulativeAttemptsFromIssue(issue);
  }

  async setCumulativeAttempts(
    projectId: string,
    id: string,
    count: number,
    _options?: { currentLabels?: string[] }
  ): Promise<void> {
    const freshIssue = this.show(projectId, id);
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
    const issue = this.show(projectId, id);
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
      const db = this.ensureDb();
      const now = new Date().toISOString();
      db.run(
        `INSERT INTO plans (project_id, plan_id, epic_id, gate_task_id, re_execute_gate_task_id, content, metadata, shipped_content, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
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
      this.scheduleSave();
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
    const db = this.ensureDb();
    const stmt = db.prepare(
      "SELECT content, metadata, shipped_content, updated_at FROM plans WHERE project_id = ? AND plan_id = ?"
    );
    stmt.bind([projectId, planId]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject();
    stmt.free();
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
    const db = this.ensureDb();
    const stmt = db.prepare(
      "SELECT plan_id, content, metadata, shipped_content, updated_at FROM plans WHERE project_id = ? AND epic_id = ?"
    );
    stmt.bind([projectId, epicId]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject();
    stmt.free();
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
    const db = this.ensureDb();
    const stmt = db.prepare(
      "SELECT plan_id FROM plans WHERE project_id = ? ORDER BY updated_at ASC"
    );
    stmt.bind([projectId]);
    const ids: string[] = [];
    while (stmt.step()) {
      ids.push(stmt.getAsObject().plan_id as string);
    }
    stmt.free();
    return ids;
  }

  async planUpdateContent(projectId: string, planId: string, content: string): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const db = this.ensureDb();
      const existing = db.prepare("SELECT 1 FROM plans WHERE project_id = ? AND plan_id = ?");
      existing.bind([projectId, planId]);
      if (!existing.step()) {
        existing.free();
        throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
      }
      existing.free();
      const now = new Date().toISOString();
      db.run("UPDATE plans SET content = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?", [
        content,
        now,
        projectId,
        planId,
      ]);
      this.scheduleSave();
    });
  }

  async planUpdateMetadata(
    projectId: string,
    planId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const db = this.ensureDb();
      const existing = db.prepare("SELECT 1 FROM plans WHERE project_id = ? AND plan_id = ?");
      existing.bind([projectId, planId]);
      if (!existing.step()) {
        existing.free();
        throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
      }
      existing.free();
      const metaJson = JSON.stringify(metadata);
      const now = new Date().toISOString();
      db.run("UPDATE plans SET metadata = ?, updated_at = ? WHERE project_id = ? AND plan_id = ?", [
        metaJson,
        now,
        projectId,
        planId,
      ]);
      this.scheduleSave();
    });
  }

  async planSetShippedContent(
    projectId: string,
    planId: string,
    shippedContent: string
  ): Promise<void> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const db = this.ensureDb();
      const existing = db.prepare("SELECT 1 FROM plans WHERE project_id = ? AND plan_id = ?");
      existing.bind([projectId, planId]);
      if (!existing.step()) {
        existing.free();
        throw new AppError(404, ErrorCodes.PLAN_NOT_FOUND, `Plan ${planId} not found`, { planId });
      }
      existing.free();
      db.run("UPDATE plans SET shipped_content = ? WHERE project_id = ? AND plan_id = ?", [
        shippedContent,
        projectId,
        planId,
      ]);
      this.scheduleSave();
    });
  }

  async planGetShippedContent(projectId: string, planId: string): Promise<string | null> {
    await this.ensureInitialized();
    const db = this.ensureDb();
    const stmt = db.prepare(
      "SELECT shipped_content FROM plans WHERE project_id = ? AND plan_id = ?"
    );
    stmt.bind([projectId, planId]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const content = stmt.getAsObject().shipped_content as string | null;
    stmt.free();
    return content ?? null;
  }

  /** Delete a plan by project_id and plan_id. Returns true if a row was deleted. */
  async planDelete(projectId: string, planId: string): Promise<boolean> {
    return this.withWriteLock(async () => {
      await this.ensureInitialized();
      const db = this.ensureDb();
      const existing = db.prepare("SELECT 1 FROM plans WHERE project_id = ? AND plan_id = ?");
      existing.bind([projectId, planId]);
      const found = existing.step();
      existing.free();
      if (!found) return false;
      db.run("DELETE FROM plans WHERE project_id = ? AND plan_id = ?", [projectId, planId]);
      this.scheduleSave();
      return true;
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.db) {
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
    return this.runWrite(async (db) => {
      const countStmt = db.prepare("SELECT COUNT(*) as cnt FROM agent_sessions");
      countStmt.step();
      const total = (countStmt.getAsObject().cnt as number) ?? 0;
      countStmt.free();
      if (total <= 100) return 0;

      const cutoffStmt = db.prepare(
        "SELECT id FROM agent_sessions ORDER BY id DESC LIMIT 1 OFFSET 99"
      );
      cutoffStmt.step();
      const row = cutoffStmt.getAsObject();
      cutoffStmt.free();
      const cutoffId = row?.id as number | undefined;
      if (cutoffId == null) return 0;

      db.run("DELETE FROM agent_sessions WHERE id < ?", [cutoffId]);
      const pruned = db.getRowsModified();

      db.run("VACUUM");
      if (pruned > 0) {
        log.info("Pruned agent_sessions", { pruned, retained: 100 });
      }
      return pruned;
    });
  }

  /**
   * Return the shared DB for use by other stores (feedback, deployments, events, etc.).
   * Callers must await init() first (done at server startup in index.ts).
   */
  async getDb(): Promise<Database> {
    await this.ensureInitialized();
    return this.ensureDb();
  }

  /**
   * Run a write transaction under the shared write lock and persist to disk.
   * Use this from feedback-store, deploy-storage, event-log, agent-identity, orchestrator counters, sessions.
   */
  async runWrite<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    await this.ensureInitialized();
    return this.withWriteLock(async () => {
      const result = await fn(this.ensureDb());
      this.scheduleSave();
      return result;
    });
  }

  /** Wait for any in-flight writes to finish and persist to disk. Use on shutdown. */
  flushPersist(): Promise<void> {
    return this.flushSave();
  }
}

/** Process-wide singleton — all services share one in-memory database. */
export const taskStore = new TaskStoreService();
