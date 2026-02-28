/**
 * Test helpers for database: SQLite-compatible schema and DbClient wrapper for sql.js.
 * Used by tests that need a real DB without requiring Postgres/Docker.
 */

import type { Database } from "sql.js";
import type { DbClient, DbRow } from "../db/client.js";

/** SQLite-compatible schema (SERIAL -> INTEGER PRIMARY KEY AUTOINCREMENT). */
export const SCHEMA_SQL_SQLITE = `
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
    proposed_tasks   TEXT,
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

CREATE TABLE IF NOT EXISTS orchestrator_counters (
    project_id    TEXT PRIMARY KEY,
    total_done    INTEGER NOT NULL DEFAULT 0,
    total_failed  INTEGER NOT NULL DEFAULT 0,
    queue_depth   INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL
);

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

/** Convert $1, $2, ... placeholders to ? for sql.js. Remove Postgres ::type casts (SQLite incompatible). */
function toSqliteParams(sql: string): string {
  let s = sql.replace(/\$(\d+)/g, "?");
  s = s.replace(/::\w+/g, ""); // ::int, ::bigint, etc. - SQLite returns correct types from COUNT/LENGTH
  return s;
}

/** Create a DbClient that wraps sql.js Database. For tests only. */
export function createSqliteDbClient(db: Database): DbClient {
  return {
    async query(sql: string, params?: unknown[]): Promise<DbRow[]> {
      const q = toSqliteParams(sql);
      const stmt = db.prepare(q);
      stmt.bind(params ?? []);
      const rows: DbRow[] = [];
      while (stmt.step()) {
        const row = stmt.getAsObject() as DbRow;
        rows.push(row);
      }
      stmt.free();
      return rows;
    },
    async queryOne(sql: string, params?: unknown[]): Promise<DbRow | undefined> {
      const rows = await this.query(sql, params);
      return rows.length > 0 ? rows[0] : undefined;
    },
    async execute(sql: string, params?: unknown[]): Promise<number> {
      const q = toSqliteParams(sql);
      db.run(q, params ?? []);
      return db.getRowsModified();
    },
    async runInTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
      db.run("BEGIN");
      try {
        const result = await fn(this);
        db.run("COMMIT");
        return result;
      } catch (err) {
        db.run("ROLLBACK");
        throw err;
      }
    },
  };
}

/** Create a mock DbClient for tests that don't need real DB. */
export function createMockDbClient(overrides?: Partial<DbClient>): DbClient {
  const base: DbClient = {
    query: async () => [],
    queryOne: async () => undefined,
    execute: async () => 0,
    runInTransaction: async (fn) => fn(base),
  };
  return { ...base, ...overrides };
}
