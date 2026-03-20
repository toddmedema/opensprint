import type { DatabaseDialect } from "@opensprint/shared";

/**
 * Postgres-compatible schema for Open Sprint.
 * Uses SERIAL/BIGSERIAL for auto-increment; TEXT/INTEGER for standard types.
 * Run on init.
 */
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

-- Agent sessions (SQL-only)
CREATE TABLE IF NOT EXISTS agent_sessions (
    id           SERIAL PRIMARY KEY,
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
    id           SERIAL PRIMARY KEY,
    project_id   TEXT NOT NULL,
    task_id      TEXT NOT NULL,
    agent_id     TEXT NOT NULL,
    role         TEXT,
    model        TEXT NOT NULL,
    attempt      INTEGER NOT NULL,
    started_at   TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    outcome      TEXT NOT NULL,
    duration_ms  INTEGER NOT NULL,
    flow         TEXT,
    prompt_fingerprint TEXT,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_stats_project ON agent_stats(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_stats_task ON agent_stats(task_id);
-- Add role column for existing tables (no-op if column exists)
ALTER TABLE agent_stats ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE agent_stats ADD COLUMN IF NOT EXISTS flow TEXT;
ALTER TABLE agent_stats ADD COLUMN IF NOT EXISTS prompt_fingerprint TEXT;
ALTER TABLE agent_stats ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER;
ALTER TABLE agent_stats ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER;

-- Orchestrator events (SQL-only)
CREATE TABLE IF NOT EXISTS orchestrator_events (
    id         SERIAL PRIMARY KEY,
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
    baseline_status TEXT NOT NULL DEFAULT 'unknown',
    baseline_checked_at TEXT,
    baseline_failure_summary TEXT,
    merge_validation_status TEXT NOT NULL DEFAULT 'healthy',
    merge_validation_failure_summary TEXT,
    dispatch_paused_reason TEXT,
    updated_at    TEXT NOT NULL
);
ALTER TABLE orchestrator_counters ADD COLUMN IF NOT EXISTS baseline_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE orchestrator_counters ADD COLUMN IF NOT EXISTS baseline_checked_at TEXT;
ALTER TABLE orchestrator_counters ADD COLUMN IF NOT EXISTS baseline_failure_summary TEXT;
ALTER TABLE orchestrator_counters ADD COLUMN IF NOT EXISTS merge_validation_status TEXT NOT NULL DEFAULT 'healthy';
ALTER TABLE orchestrator_counters ADD COLUMN IF NOT EXISTS merge_validation_failure_summary TEXT;
ALTER TABLE orchestrator_counters ADD COLUMN IF NOT EXISTS dispatch_paused_reason TEXT;

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

-- Plans (SQL-only: content and metadata moved from .opensprint/plans/)
-- gate_task_id nullable for epic-blocked model (no gate tasks)
CREATE TABLE IF NOT EXISTS plans (
    project_id                   TEXT NOT NULL,
    plan_id                      TEXT NOT NULL,
    epic_id                      TEXT NOT NULL,
    gate_task_id                 TEXT,
    re_execute_gate_task_id      TEXT,
    content                      TEXT NOT NULL,
    metadata                     TEXT NOT NULL,
    shipped_content              TEXT,
    updated_at                   TEXT NOT NULL,
    current_version_number       INTEGER NOT NULL DEFAULT 1,
    last_executed_version_number INTEGER,
    PRIMARY KEY (project_id, plan_id)
);
CREATE INDEX IF NOT EXISTS idx_plans_project_id ON plans(project_id);
CREATE INDEX IF NOT EXISTS idx_plans_project_epic ON plans(project_id, epic_id);

-- Plan versions (snapshots per plan: on execute or explicit save)
CREATE TABLE IF NOT EXISTS plan_versions (
    id                   SERIAL PRIMARY KEY,
    project_id           TEXT NOT NULL,
    plan_id              TEXT NOT NULL,
    version_number       INTEGER NOT NULL,
    title                TEXT,
    content              TEXT NOT NULL,
    metadata             TEXT,
    created_at           TEXT NOT NULL,
    is_executed_version  BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_versions_project_plan_version
  ON plan_versions(project_id, plan_id, version_number);

-- Add version columns for existing plans tables (no-op if columns exist)
ALTER TABLE plans ADD COLUMN IF NOT EXISTS current_version_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS last_executed_version_number INTEGER;

-- Auditor runs (final review Auditor execution records, enables plan-centric lookup and deep-linking)
CREATE TABLE IF NOT EXISTS auditor_runs (
    id           SERIAL PRIMARY KEY,
    project_id   TEXT NOT NULL,
    plan_id      TEXT NOT NULL,
    epic_id      TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    status       TEXT NOT NULL,
    assessment   TEXT
);
CREATE INDEX IF NOT EXISTS idx_auditor_runs_project_plan ON auditor_runs(project_id, plan_id);

-- Self-improvement run history (timestamp, status, tasks_created_count per run)
CREATE TABLE IF NOT EXISTS self_improvement_runs (
    id                   SERIAL PRIMARY KEY,
    project_id           TEXT NOT NULL,
    run_id               TEXT NOT NULL,
    completed_at         TEXT NOT NULL,
    status               TEXT NOT NULL,
    tasks_created_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_self_improvement_runs_project ON self_improvement_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_self_improvement_runs_completed ON self_improvement_runs(project_id, completed_at DESC);

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
    error_code   TEXT,
    scope_change_metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_open_questions_project_id ON open_questions(project_id);
CREATE INDEX IF NOT EXISTS idx_open_questions_status ON open_questions(status);
-- Add scope_change_metadata for existing tables (no-op if column exists)
ALTER TABLE open_questions ADD COLUMN IF NOT EXISTS scope_change_metadata TEXT;
ALTER TABLE open_questions ADD COLUMN IF NOT EXISTS responses TEXT;

-- PRD metadata (version/changeLog/sectionVersions) moved from .opensprint/spec-metadata.json
CREATE TABLE IF NOT EXISTS prd_metadata (
    project_id        TEXT PRIMARY KEY,
    version           INTEGER NOT NULL DEFAULT 0,
    change_log        TEXT NOT NULL DEFAULT '[]',
    section_versions  TEXT NOT NULL DEFAULT '{}',
    updated_at        TEXT NOT NULL
);

-- PRD snapshots: full SPEC.md content per document version (for diff/history)
CREATE TABLE IF NOT EXISTS prd_snapshots (
    project_id   TEXT NOT NULL,
    version      INTEGER NOT NULL,
    content      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_prd_snapshots_project_id ON prd_snapshots(project_id);

-- Chat conversations moved from .opensprint/conversations/*.json
CREATE TABLE IF NOT EXISTS project_conversations (
    project_id       TEXT NOT NULL,
    context          TEXT NOT NULL,
    conversation_id  TEXT NOT NULL,
    messages         TEXT NOT NULL DEFAULT '[]',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY (project_id, context)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_conversations_project_conversation
  ON project_conversations(project_id, conversation_id);

-- Plan status snapshots moved from .opensprint/planning-runs/*.json
CREATE TABLE IF NOT EXISTS planning_runs (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    prd_snapshot  TEXT NOT NULL,
    plans_created TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_planning_runs_project_created
  ON planning_runs(project_id, created_at DESC);

-- Role-specific agent instructions moved from .opensprint/agents/<role>.md
CREATE TABLE IF NOT EXISTS agent_instructions (
    project_id   TEXT NOT NULL,
    role         TEXT NOT NULL,
    content      TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (project_id, role)
);

-- Optional workflow override moved from .opensprint/workflow.json
CREATE TABLE IF NOT EXISTS project_workflows (
    project_id   TEXT PRIMARY KEY,
    workflow     TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

-- Help chat history (project + homepage) moved from file storage
CREATE TABLE IF NOT EXISTS help_chat_histories (
    scope_key    TEXT PRIMARY KEY,
    messages     TEXT NOT NULL DEFAULT '[]',
    updated_at   TEXT NOT NULL
);

-- Idempotency + audit for one-time repo file migration script
CREATE TABLE IF NOT EXISTS repo_file_migrations (
    project_id     TEXT NOT NULL,
    migration_key  TEXT NOT NULL,
    applied_at     TEXT NOT NULL,
    PRIMARY KEY (project_id, migration_key)
);
`;

/** SQLite schema: SERIAL -> INTEGER PRIMARY KEY AUTOINCREMENT; ALTER ADD COLUMN IF NOT EXISTS supported in 3.35+. */
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
    role         TEXT,
    model        TEXT NOT NULL,
    attempt      INTEGER NOT NULL,
    started_at   TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    outcome      TEXT NOT NULL,
    duration_ms  INTEGER NOT NULL,
    flow         TEXT,
    prompt_fingerprint TEXT,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER
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
    baseline_status TEXT NOT NULL DEFAULT 'unknown',
    baseline_checked_at TEXT,
    baseline_failure_summary TEXT,
    merge_validation_status TEXT NOT NULL DEFAULT 'healthy',
    merge_validation_failure_summary TEXT,
    dispatch_paused_reason TEXT,
    updated_at    TEXT NOT NULL
);
ALTER TABLE orchestrator_counters ADD COLUMN IF NOT EXISTS baseline_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE orchestrator_counters ADD COLUMN IF NOT EXISTS baseline_checked_at TEXT;
ALTER TABLE orchestrator_counters ADD COLUMN IF NOT EXISTS baseline_failure_summary TEXT;
ALTER TABLE orchestrator_counters ADD COLUMN IF NOT EXISTS merge_validation_status TEXT NOT NULL DEFAULT 'healthy';
ALTER TABLE orchestrator_counters ADD COLUMN IF NOT EXISTS merge_validation_failure_summary TEXT;
ALTER TABLE orchestrator_counters ADD COLUMN IF NOT EXISTS dispatch_paused_reason TEXT;

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
    project_id                   TEXT NOT NULL,
    plan_id                      TEXT NOT NULL,
    epic_id                      TEXT NOT NULL,
    gate_task_id                 TEXT,
    re_execute_gate_task_id      TEXT,
    content                      TEXT NOT NULL,
    metadata                     TEXT NOT NULL,
    shipped_content              TEXT,
    updated_at                   TEXT NOT NULL,
    current_version_number       INTEGER NOT NULL DEFAULT 1,
    last_executed_version_number INTEGER,
    PRIMARY KEY (project_id, plan_id)
);
CREATE INDEX IF NOT EXISTS idx_plans_project_id ON plans(project_id);
CREATE INDEX IF NOT EXISTS idx_plans_project_epic ON plans(project_id, epic_id);

CREATE TABLE IF NOT EXISTS plan_versions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id           TEXT NOT NULL,
    plan_id              TEXT NOT NULL,
    version_number       INTEGER NOT NULL,
    title                TEXT,
    content              TEXT NOT NULL,
    metadata             TEXT,
    created_at           TEXT NOT NULL,
    is_executed_version  INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_versions_project_plan_version
  ON plan_versions(project_id, plan_id, version_number);

CREATE TABLE IF NOT EXISTS auditor_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id   TEXT NOT NULL,
    plan_id      TEXT NOT NULL,
    epic_id      TEXT NOT NULL,
    started_at   TEXT NOT NULL,
    completed_at TEXT NOT NULL,
    status       TEXT NOT NULL,
    assessment   TEXT
);
CREATE INDEX IF NOT EXISTS idx_auditor_runs_project_plan ON auditor_runs(project_id, plan_id);

CREATE TABLE IF NOT EXISTS self_improvement_runs (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id           TEXT NOT NULL,
    run_id               TEXT NOT NULL,
    completed_at         TEXT NOT NULL,
    status               TEXT NOT NULL,
    tasks_created_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_self_improvement_runs_project ON self_improvement_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_self_improvement_runs_completed ON self_improvement_runs(project_id, completed_at DESC);

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
    error_code   TEXT,
    scope_change_metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_open_questions_project_id ON open_questions(project_id);
CREATE INDEX IF NOT EXISTS idx_open_questions_status ON open_questions(status);

CREATE TABLE IF NOT EXISTS prd_metadata (
    project_id        TEXT PRIMARY KEY,
    version           INTEGER NOT NULL DEFAULT 0,
    change_log        TEXT NOT NULL DEFAULT '[]',
    section_versions  TEXT NOT NULL DEFAULT '{}',
    updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prd_snapshots (
    project_id   TEXT NOT NULL,
    version      INTEGER NOT NULL,
    content      TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (project_id, version)
);
CREATE INDEX IF NOT EXISTS idx_prd_snapshots_project_id ON prd_snapshots(project_id);

CREATE TABLE IF NOT EXISTS project_conversations (
    project_id       TEXT NOT NULL,
    context          TEXT NOT NULL,
    conversation_id  TEXT NOT NULL,
    messages         TEXT NOT NULL DEFAULT '[]',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY (project_id, context)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_conversations_project_conversation
  ON project_conversations(project_id, conversation_id);

CREATE TABLE IF NOT EXISTS planning_runs (
    id            TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    prd_snapshot  TEXT NOT NULL,
    plans_created TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_planning_runs_project_created
  ON planning_runs(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_instructions (
    project_id   TEXT NOT NULL,
    role         TEXT NOT NULL,
    content      TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (project_id, role)
);

CREATE TABLE IF NOT EXISTS project_workflows (
    project_id   TEXT PRIMARY KEY,
    workflow     TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS help_chat_histories (
    scope_key    TEXT PRIMARY KEY,
    messages     TEXT NOT NULL DEFAULT '[]',
    updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS repo_file_migrations (
    project_id     TEXT NOT NULL,
    migration_key  TEXT NOT NULL,
    applied_at     TEXT NOT NULL,
    PRIMARY KEY (project_id, migration_key)
);

ALTER TABLE agent_stats ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE agent_stats ADD COLUMN IF NOT EXISTS flow TEXT;
ALTER TABLE agent_stats ADD COLUMN IF NOT EXISTS prompt_fingerprint TEXT;
ALTER TABLE agent_stats ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER;
ALTER TABLE agent_stats ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER;
ALTER TABLE open_questions ADD COLUMN IF NOT EXISTS scope_change_metadata TEXT;
ALTER TABLE open_questions ADD COLUMN IF NOT EXISTS responses TEXT;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS current_version_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS last_executed_version_number INTEGER;
`;

/** Strip leading comment-only and empty lines so statements starting with "-- Comment\nCREATE ..." are executed. */
function stripLeadingCommentLines(s: string): string {
  const lines = s.split("\n");
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (trimmed.length === 0 || trimmed.startsWith("--")) {
      i++;
      continue;
    }
    break;
  }
  return lines.slice(i).join("\n").trim();
}

/** Return schema SQL for the given dialect. */
export function getSchemaSql(dialect: DatabaseDialect): string {
  return dialect === "sqlite" ? SCHEMA_SQL_SQLITE : SCHEMA_SQL;
}

function parseSqliteAddColumnIfNotExists(
  stmt: string
): { table: string; column: string; definition: string } | null {
  const match = stmt.match(
    /^ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+)$/is
  );
  if (!match) return null;
  return {
    table: match[1],
    column: match[2],
    definition: match[3].trim(),
  };
}

function sqliteTableHasColumn(rows: unknown[], column: string): boolean {
  return rows.some((row) => {
    if (!row || typeof row !== "object") return false;
    const record = row as Record<string, unknown>;
    return record.name === column;
  });
}

/** Run schema SQL against a client. Splits by semicolon and executes each statement. */
export async function runSchema(
  client: {
    query(sql: string, params?: unknown[]): Promise<unknown[]>;
  },
  dialect: DatabaseDialect = "postgres"
): Promise<void> {
  const schemaSql = getSchemaSql(dialect);
  const statements = schemaSql
    .split(";")
    .map((s) => stripLeadingCommentLines(s.trim()))
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    if (dialect === "sqlite") {
      const sqliteAddColumn = parseSqliteAddColumnIfNotExists(stmt);
      if (sqliteAddColumn) {
        const columns = await client.query(`PRAGMA table_info(${sqliteAddColumn.table})`);
        if (!sqliteTableHasColumn(columns, sqliteAddColumn.column)) {
          await client.query(
            `ALTER TABLE ${sqliteAddColumn.table} ADD COLUMN ${sqliteAddColumn.column} ${sqliteAddColumn.definition}`
          );
        }
        continue;
      }
    }
    await client.query(stmt);
  }
}
