import type { DbClient } from "./client.js";

/** Portable, additive schema. Project cursor row locks order commits on Postgres. */
export const COLLABORATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS collaboration_projects (
  project_id TEXT PRIMARY KEY,
  cursor INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS collaboration_messages (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE INDEX IF NOT EXISTS idx_collaboration_messages_cursor ON collaboration_messages(project_id, cursor);
CREATE TABLE IF NOT EXISTS collaboration_runs (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  controller_id TEXT,
  revision INTEGER NOT NULL,
  PRIMARY KEY (project_id, run_id)
);
CREATE TABLE IF NOT EXISTS collaboration_commands (
  project_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (project_id, command_id)
);
CREATE TABLE IF NOT EXISTS collaboration_events (
  project_id TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  event TEXT NOT NULL,
  PRIMARY KEY (project_id, cursor)
);
CREATE TABLE IF NOT EXISTS collaboration_message_context (
  project_id TEXT NOT NULL, message_id TEXT NOT NULL, task_id TEXT,
  context_json TEXT, mention_actor_ids TEXT NOT NULL DEFAULT '[]', decision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, message_id)
);
CREATE TABLE IF NOT EXISTS collaboration_control_requests (
  project_id TEXT NOT NULL, run_id TEXT NOT NULL, requested_by TEXT NOT NULL,
  target_actor_id TEXT NOT NULL, created_at TEXT NOT NULL, task_id TEXT,
  PRIMARY KEY (project_id, run_id)
);
CREATE TABLE IF NOT EXISTS collaboration_run_context (
  project_id TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
  PRIMARY KEY (project_id, run_id)
);
CREATE TABLE IF NOT EXISTS collaboration_invites (
  project_id TEXT NOT NULL, id TEXT NOT NULL, actor_id TEXT NOT NULL, display_name TEXT NOT NULL,
  role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, revoked_at TEXT,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS collaboration_presence (
  project_id TEXT NOT NULL, actor_id TEXT NOT NULL, client_id TEXT NOT NULL,
  display_name TEXT NOT NULL, role TEXT NOT NULL, task_id TEXT, last_seen_at TEXT NOT NULL,
  PRIMARY KEY (project_id, actor_id, client_id)
);
CREATE TABLE IF NOT EXISTS collaboration_preferences (
  project_id TEXT NOT NULL, actor_id TEXT NOT NULL, seen_cursor INTEGER NOT NULL DEFAULT 0,
  subscribed_task_ids TEXT NOT NULL DEFAULT '[]', seen_at TEXT, PRIMARY KEY (project_id, actor_id)
);`;

export async function runCollaborationSchema(client: DbClient): Promise<void> {
  for (const statement of COLLABORATION_SCHEMA_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await client.execute(statement);
  }
}
