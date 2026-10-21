/** Additive portable storage for operations, resource versions, messages and guidance. */
export const DURABLE_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS resource_revisions (
  project_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, resource_type, resource_id)
);
CREATE TABLE IF NOT EXISTS project_settings (
  project_id TEXT PRIMARY KEY,
  settings TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings_store_migrations (
  source TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS durable_operations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  expected_revision INTEGER,
  fingerprint TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_operations_status ON durable_operations(project_id, status);
CREATE TABLE IF NOT EXISTS operation_owners (
  owner_id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_messages (
  project_id TEXT NOT NULL,
  context TEXT NOT NULL,
  id TEXT NOT NULL,
  position INTEGER NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, context, id),
  UNIQUE (project_id, context, position),
  FOREIGN KEY (project_id, context) REFERENCES project_conversations(project_id, context) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS guidance_messages (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, actor_id, client_message_id)
);
CREATE INDEX IF NOT EXISTS idx_guidance_attempt ON guidance_messages(project_id, task_id, attempt_id);
`;
