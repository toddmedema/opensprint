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
);`;

export async function runCollaborationSchema(client: DbClient): Promise<void> {
  for (const statement of COLLABORATION_SCHEMA_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean)) {
    await client.execute(statement);
  }
}
