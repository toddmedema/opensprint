/** Identical SQL for SQLite and PostgreSQL; recovery never requires an external task store. */
export const LOCAL_RECOVERY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS local_validation_authorities (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_key TEXT NOT NULL,
  authority_hash TEXT NOT NULL,
  PRIMARY KEY(project_id,task_id,attempt_key)
);
CREATE TABLE IF NOT EXISTS local_recovery_incidents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  generation INTEGER NOT NULL,
  owner TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_host TEXT NOT NULL,
  state TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, workspace)
);
CREATE TABLE IF NOT EXISTS local_recovery_tasks (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  checkpoint TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id)
);
CREATE TABLE IF NOT EXISTS local_recovery_requests (
  project_id TEXT NOT NULL, task_id TEXT NOT NULL, request_id TEXT NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(project_id,task_id,request_id)
);
CREATE TABLE IF NOT EXISTS local_recovery_reviews (
  project_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_key TEXT NOT NULL, angle TEXT NOT NULL, outcome TEXT NOT NULL,
  PRIMARY KEY(project_id,task_id,attempt_key,angle)
);
CREATE TABLE IF NOT EXISTS local_execution_profiles (
  project_id TEXT NOT NULL,
  context_hash TEXT NOT NULL,
  failure_key TEXT NOT NULL DEFAULT '',
  recipe TEXT NOT NULL,
  evidence TEXT NOT NULL,
  contract TEXT NOT NULL DEFAULT '{}',
  verified_at TEXT NOT NULL,
  PRIMARY KEY(project_id, context_hash, failure_key)
);
`;
