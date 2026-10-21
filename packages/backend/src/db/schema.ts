import type { DatabaseDialect } from "@opensprint/shared";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { COLLABORATION_SCHEMA_SQL } from "./collaboration-schema.js";
import { PUBLICATION_SCHEMA_SQL } from "./publication-schema.js";

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
CREATE INDEX IF NOT EXISTS idx_tasks_project_id_status ON tasks(project_id, status);
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

-- Agentic repair telemetry (debug artifact summary, repair iteration count)
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS debug_artifact_summary TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS repair_iterations INTEGER;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS root_cause_category TEXT;

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
    parent_plan_id               TEXT,
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

-- Execute-all batch queue (survives UI refresh, one running batch per project)
CREATE TABLE IF NOT EXISTS plan_execute_batches (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    items_json      TEXT NOT NULL,
    current_index   INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL,
    error_plan_id   TEXT,
    error_message   TEXT,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_execute_batches_project_id ON plan_execute_batches(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_execute_batches_project_running
  ON plan_execute_batches(project_id) WHERE status = 'running';

-- Add version columns for existing plans tables (no-op if columns exist)
ALTER TABLE plans ADD COLUMN IF NOT EXISTS current_version_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS last_executed_version_number INTEGER;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS parent_plan_id TEXT;
CREATE INDEX IF NOT EXISTS idx_plans_parent ON plans(project_id, parent_plan_id);

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

-- Self-improvement run history (timestamp, status, tasks_created_count, mode, outcome, summary, version ids)
CREATE TABLE IF NOT EXISTS self_improvement_runs (
    id                     SERIAL PRIMARY KEY,
    project_id             TEXT NOT NULL,
    run_id                 TEXT NOT NULL,
    completed_at           TEXT NOT NULL,
    status                 TEXT NOT NULL,
    tasks_created_count    INTEGER NOT NULL DEFAULT 0,
    run_mode               TEXT NOT NULL DEFAULT 'audit_only',
    outcome                TEXT NOT NULL DEFAULT 'no_changes',
    summary                TEXT NOT NULL DEFAULT '',
    promoted_version_id    TEXT,
    pending_candidate_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_self_improvement_runs_project ON self_improvement_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_self_improvement_runs_completed ON self_improvement_runs(project_id, completed_at DESC);
ALTER TABLE self_improvement_runs ADD COLUMN IF NOT EXISTS run_mode TEXT NOT NULL DEFAULT 'audit_only';
ALTER TABLE self_improvement_runs ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'no_changes';
ALTER TABLE self_improvement_runs ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';
ALTER TABLE self_improvement_runs ADD COLUMN IF NOT EXISTS promoted_version_id TEXT;
ALTER TABLE self_improvement_runs ADD COLUMN IF NOT EXISTS pending_candidate_id TEXT;

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

-- Promoted / candidate agent behavior bundles (version ids are store-generated or experiment-assigned strings)
CREATE TABLE IF NOT EXISTS behavior_versions (
    id                   TEXT NOT NULL,
    project_id           TEXT NOT NULL,
    template_version_id  TEXT,
    promoted_at          TEXT,
    created_at           TEXT NOT NULL,
    bundle               TEXT,
    version_type         TEXT NOT NULL DEFAULT 'promoted',
    PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_behavior_versions_project ON behavior_versions(project_id);
ALTER TABLE behavior_versions ADD COLUMN IF NOT EXISTS version_type TEXT NOT NULL DEFAULT 'promoted';

CREATE TABLE IF NOT EXISTS project_behavior_state (
    project_id                    TEXT PRIMARY KEY,
    active_promoted_version_id    TEXT
);

-- Integration connections (provider-agnostic OAuth connections)
CREATE TABLE IF NOT EXISTS integration_connections (
    id                     TEXT PRIMARY KEY,
    project_id             TEXT NOT NULL,
    provider               TEXT NOT NULL,
    provider_user_id       TEXT,
    provider_user_email    TEXT,
    provider_resource_id   TEXT,
    provider_resource_name TEXT,
    access_token_enc       TEXT NOT NULL,
    refresh_token_enc      TEXT,
    token_expires_at       TEXT,
    scopes                 TEXT,
    status                 TEXT NOT NULL DEFAULT 'active',
    last_sync_at           TEXT,
    last_error             TEXT,
    config                 TEXT DEFAULT '{}',
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    UNIQUE (project_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_integration_connections_project_id ON integration_connections(project_id);
CREATE INDEX IF NOT EXISTS idx_integration_connections_project_provider_status ON integration_connections(project_id, provider, status);

-- Integration import ledger (tracks imported items for idempotency and delete-after-import)
CREATE TABLE IF NOT EXISTS integration_import_ledger (
    id               SERIAL PRIMARY KEY,
    project_id       TEXT NOT NULL,
    provider         TEXT NOT NULL,
    external_item_id TEXT NOT NULL,
    feedback_id      TEXT NOT NULL,
    import_status    TEXT NOT NULL DEFAULT 'pending_delete',
    last_error       TEXT,
    retry_count      INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE (project_id, provider, external_item_id)
);
CREATE INDEX IF NOT EXISTS idx_integration_import_ledger_project_provider_status ON integration_import_ledger(project_id, provider, import_status);

-- Worktree leases: durable ownership tracking to prevent recovery/cleanup races
CREATE TABLE IF NOT EXISTS worktree_leases (
    worktree_key   TEXT PRIMARY KEY,
    task_id        TEXT NOT NULL,
    project_id     TEXT NOT NULL,
    worktree_path  TEXT NOT NULL,
    branch_name    TEXT,
    lease_owner    TEXT NOT NULL,
    generation     INTEGER NOT NULL DEFAULT 1,
    acquired_at    TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    released_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_worktree_leases_project ON worktree_leases(project_id);
CREATE INDEX IF NOT EXISTS idx_worktree_leases_task ON worktree_leases(task_id);

-- Intake items: normalized work items from integration providers
CREATE TABLE IF NOT EXISTS intake_items (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    provider            TEXT NOT NULL,
    external_item_id    TEXT NOT NULL,
    source_ref          TEXT,
    title               TEXT NOT NULL,
    body                TEXT,
    author              TEXT,
    labels              TEXT DEFAULT '[]',
    triage_status       TEXT NOT NULL DEFAULT 'new',
    triage_suggestion   TEXT,
    converted_feedback_id TEXT,
    converted_task_id   TEXT,
    external_created_at TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    UNIQUE (project_id, provider, external_item_id)
);
CREATE INDEX IF NOT EXISTS idx_intake_items_project_provider ON intake_items(project_id, provider);
CREATE INDEX IF NOT EXISTS idx_intake_items_triage_status ON intake_items(project_id, triage_status);
CREATE INDEX IF NOT EXISTS idx_intake_items_created_at ON intake_items(project_id, created_at);

-- Command runs: audit log for NL command execution
CREATE TABLE IF NOT EXISTS command_runs (
    id                    TEXT PRIMARY KEY,
    project_id            TEXT NOT NULL,
    actor                 TEXT NOT NULL,
    raw_input             TEXT NOT NULL,
    interpreted_command   TEXT,
    risk_level            TEXT,
    status                TEXT NOT NULL DEFAULT 'interpreting',
    preview               TEXT,
    result                TEXT,
    idempotency_key       TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_command_runs_project ON command_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_command_runs_project_status ON command_runs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_command_runs_idempotency ON command_runs(idempotency_key);
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
CREATE INDEX IF NOT EXISTS idx_tasks_project_id_status ON tasks(project_id, status);
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
    parent_plan_id               TEXT,
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

CREATE TABLE IF NOT EXISTS plan_execute_batches (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    items_json      TEXT NOT NULL,
    current_index   INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL,
    error_plan_id   TEXT,
    error_message   TEXT,
    updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_execute_batches_project_id ON plan_execute_batches(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_execute_batches_project_running
  ON plan_execute_batches(project_id) WHERE status = 'running';

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
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id             TEXT NOT NULL,
    run_id                 TEXT NOT NULL,
    completed_at           TEXT NOT NULL,
    status                 TEXT NOT NULL,
    tasks_created_count    INTEGER NOT NULL DEFAULT 0,
    run_mode               TEXT NOT NULL DEFAULT 'audit_only',
    outcome                TEXT NOT NULL DEFAULT 'no_changes',
    summary                TEXT NOT NULL DEFAULT '',
    promoted_version_id    TEXT,
    pending_candidate_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_self_improvement_runs_project ON self_improvement_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_self_improvement_runs_completed ON self_improvement_runs(project_id, completed_at DESC);
ALTER TABLE self_improvement_runs ADD COLUMN IF NOT EXISTS run_mode TEXT NOT NULL DEFAULT 'audit_only';
ALTER TABLE self_improvement_runs ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'no_changes';
ALTER TABLE self_improvement_runs ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';
ALTER TABLE self_improvement_runs ADD COLUMN IF NOT EXISTS promoted_version_id TEXT;
ALTER TABLE self_improvement_runs ADD COLUMN IF NOT EXISTS pending_candidate_id TEXT;

-- Promoted / candidate agent behavior bundles (version ids are store-generated or experiment-assigned strings)
CREATE TABLE IF NOT EXISTS behavior_versions (
    id                   TEXT NOT NULL,
    project_id           TEXT NOT NULL,
    template_version_id  TEXT,
    promoted_at          TEXT,
    created_at           TEXT NOT NULL,
    bundle               TEXT,
    version_type         TEXT NOT NULL DEFAULT 'promoted',
    PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_behavior_versions_project ON behavior_versions(project_id);
ALTER TABLE behavior_versions ADD COLUMN IF NOT EXISTS version_type TEXT NOT NULL DEFAULT 'promoted';

CREATE TABLE IF NOT EXISTS project_behavior_state (
    project_id                    TEXT PRIMARY KEY,
    active_promoted_version_id    TEXT
);

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
ALTER TABLE plans ADD COLUMN IF NOT EXISTS parent_plan_id TEXT;
CREATE INDEX IF NOT EXISTS idx_plans_parent ON plans(project_id, parent_plan_id);

-- Integration connections (provider-agnostic OAuth connections)
CREATE TABLE IF NOT EXISTS integration_connections (
    id                     TEXT PRIMARY KEY,
    project_id             TEXT NOT NULL,
    provider               TEXT NOT NULL,
    provider_user_id       TEXT,
    provider_user_email    TEXT,
    provider_resource_id   TEXT,
    provider_resource_name TEXT,
    access_token_enc       TEXT NOT NULL,
    refresh_token_enc      TEXT,
    token_expires_at       TEXT,
    scopes                 TEXT,
    status                 TEXT NOT NULL DEFAULT 'active',
    last_sync_at           TEXT,
    last_error             TEXT,
    config                 TEXT DEFAULT '{}',
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    UNIQUE (project_id, provider)
);
CREATE INDEX IF NOT EXISTS idx_integration_connections_project_id ON integration_connections(project_id);
CREATE INDEX IF NOT EXISTS idx_integration_connections_project_provider_status ON integration_connections(project_id, provider, status);

-- Integration import ledger (tracks imported items for idempotency and delete-after-import)
CREATE TABLE IF NOT EXISTS integration_import_ledger (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id       TEXT NOT NULL,
    provider         TEXT NOT NULL,
    external_item_id TEXT NOT NULL,
    feedback_id      TEXT NOT NULL,
    import_status    TEXT NOT NULL DEFAULT 'pending_delete',
    last_error       TEXT,
    retry_count      INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    UNIQUE (project_id, provider, external_item_id)
);
CREATE INDEX IF NOT EXISTS idx_integration_import_ledger_project_provider_status ON integration_import_ledger(project_id, provider, import_status);

-- Agentic repair telemetry (debug artifact summary, repair iteration count)
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS debug_artifact_summary TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS repair_iterations INTEGER;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS root_cause_category TEXT;

-- Worktree leases: durable ownership tracking to prevent recovery/cleanup races
CREATE TABLE IF NOT EXISTS worktree_leases (
    worktree_key   TEXT PRIMARY KEY,
    task_id        TEXT NOT NULL,
    project_id     TEXT NOT NULL,
    worktree_path  TEXT NOT NULL,
    branch_name    TEXT,
    lease_owner    TEXT NOT NULL,
    generation     INTEGER NOT NULL DEFAULT 1,
    acquired_at    TEXT NOT NULL,
    expires_at     TEXT NOT NULL,
    released_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_worktree_leases_project ON worktree_leases(project_id);
CREATE INDEX IF NOT EXISTS idx_worktree_leases_task ON worktree_leases(task_id);

-- Intake items: normalized work items from integration providers
CREATE TABLE IF NOT EXISTS intake_items (
    id                  TEXT PRIMARY KEY,
    project_id          TEXT NOT NULL,
    provider            TEXT NOT NULL,
    external_item_id    TEXT NOT NULL,
    source_ref          TEXT,
    title               TEXT NOT NULL,
    body                TEXT,
    author              TEXT,
    labels              TEXT DEFAULT '[]',
    triage_status       TEXT NOT NULL DEFAULT 'new',
    triage_suggestion   TEXT,
    converted_feedback_id TEXT,
    converted_task_id   TEXT,
    external_created_at TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    UNIQUE (project_id, provider, external_item_id)
);
CREATE INDEX IF NOT EXISTS idx_intake_items_project_provider ON intake_items(project_id, provider);
CREATE INDEX IF NOT EXISTS idx_intake_items_triage_status ON intake_items(project_id, triage_status);
CREATE INDEX IF NOT EXISTS idx_intake_items_created_at ON intake_items(project_id, created_at);

-- Command runs: audit log for NL command execution
CREATE TABLE IF NOT EXISTS command_runs (
    id                    TEXT PRIMARY KEY,
    project_id            TEXT NOT NULL,
    actor                 TEXT NOT NULL,
    raw_input             TEXT NOT NULL,
    interpreted_command   TEXT,
    risk_level            TEXT,
    status                TEXT NOT NULL DEFAULT 'interpreting',
    preview               TEXT,
    result                TEXT,
    idempotency_key       TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_command_runs_project ON command_runs(project_id);
CREATE INDEX IF NOT EXISTS idx_command_runs_project_status ON command_runs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_command_runs_idempotency ON command_runs(idempotency_key);
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

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

interface MigrationFile {
  version: number;
  filename: string;
}

/**
 * Resolve the migrations directory. Checks both the directory adjacent to this
 * module (works when running from source) and a fallback for compiled output
 * where the dist layout differs from src.
 */
let _cachedMigrationsDir: string | undefined;
async function resolveMigrationsDir(): Promise<string> {
  if (_cachedMigrationsDir) return _cachedMigrationsDir;
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const localDir = path.join(thisDir, "migrations");
  try {
    await fs.access(localDir);
    _cachedMigrationsDir = localDir;
    return localDir;
  } catch {
    const srcFallback = path.resolve(thisDir, "../../src/db/migrations");
    try {
      await fs.access(srcFallback);
      _cachedMigrationsDir = srcFallback;
      return srcFallback;
    } catch {
      _cachedMigrationsDir = localDir;
      return localDir;
    }
  }
}

function parseMigrationVersion(filename: string): number {
  const match = filename.match(/^(\d+)-/);
  return match ? parseInt(match[1], 10) : -1;
}

async function discoverMigrationFiles(dialect: DatabaseDialect): Promise<MigrationFile[]> {
  const dir = await resolveMigrationsDir();
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  return entries
    .filter((f) => {
      if (dialect === "sqlite") return f.endsWith(".sqlite.sql");
      return f.endsWith(".sql") && !f.endsWith(".sqlite.sql");
    })
    .map((f) => ({ version: parseMigrationVersion(f), filename: f }))
    .filter((m) => m.version >= 0)
    .sort((a, b) => a.version - b.version);
}

async function executeSqlStatements(
  client: { query(sql: string, params?: unknown[]): Promise<unknown[]> },
  sql: string,
  dialect: DatabaseDialect
): Promise<void> {
  if (dialect === "postgres") {
    await client.query(sql);
    return;
  }

  const statements = sql
    .split(";")
    .map((s) => stripLeadingCommentLines(s.trim()))
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
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
    await client.query(stmt);
  }
}

/**
 * Run schema migrations against a client. Reads SQL migration files from the
 * `migrations/` directory, tracks applied versions in a `schema_versions`
 * table, and applies any pending migrations in order.
 *
 * For existing databases that predate the migration system, the initial
 * migration (001) is fully idempotent (CREATE TABLE IF NOT EXISTS / ALTER
 * TABLE ADD COLUMN IF NOT EXISTS) so it safely runs on an already-populated
 * database.
 */
export async function runSchema(
  client: {
    query(sql: string, params?: unknown[]): Promise<unknown[]>;
  },
  dialect: DatabaseDialect = "postgres"
): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`
  );

  const appliedRows = await client.query(`SELECT version FROM schema_versions ORDER BY version`);
  const appliedVersions = new Set(
    appliedRows.map((r) => Number((r as Record<string, unknown>).version))
  );

  const migrations = await discoverMigrationFiles(dialect);
  const migrationsDir = await resolveMigrationsDir();

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;

    const filePath = path.join(migrationsDir, migration.filename);
    const sql = await fs.readFile(filePath, "utf-8");

    await executeSqlStatements(client, sql, dialect);

    const insertVersionSql =
      dialect === "postgres"
        ? `INSERT INTO schema_versions (version, applied_at) VALUES ($1, $2)`
        : `INSERT INTO schema_versions (version, applied_at) VALUES (?, ?)`;
    await client.query(insertVersionSql, [migration.version, new Date().toISOString()]);
  }
  await executeSqlStatements(client, COLLABORATION_SCHEMA_SQL, dialect);
  await executeSqlStatements(client, PUBLICATION_SCHEMA_SQL, dialect);
}
