/** Portable SQL: execution ownership never depends on a PID or a shared filesystem. */
export const EXECUTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS execution_leases (
  project_id TEXT NOT NULL,
  run_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  leader_generation INTEGER,
  expires_ms BIGINT NOT NULL,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, run_key)
);
CREATE INDEX IF NOT EXISTS idx_execution_task ON execution_leases(project_id, task_id);
CREATE TABLE IF NOT EXISTS execution_output_streams (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  start_offset BIGINT NOT NULL DEFAULT 0,
  end_offset BIGINT NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, attempt_id)
);
CREATE TABLE IF NOT EXISTS execution_output_chunks (
  project_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  start_offset BIGINT NOT NULL,
  end_offset BIGINT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (project_id, attempt_id, start_offset)
);
`;
