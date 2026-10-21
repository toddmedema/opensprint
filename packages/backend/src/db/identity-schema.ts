export const IDENTITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS websocket_upgrade_tickets (
 token_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, credential_hash TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collaboration_users (
 actor_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collaboration_credentials (
 token_hash TEXT PRIMARY KEY, actor_id TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_collaboration_credentials_actor ON collaboration_credentials(actor_id);
CREATE TABLE IF NOT EXISTS collaboration_memberships (
 project_id TEXT NOT NULL, actor_id TEXT NOT NULL, role TEXT NOT NULL, permissions TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(project_id, actor_id)
);
CREATE TABLE IF NOT EXISTS collaboration_invitations (
 token_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, actor_id TEXT NOT NULL,
 expires_at TEXT NOT NULL, consumed_at TEXT
);
CREATE TABLE IF NOT EXISTS collaboration_presence (
 project_id TEXT NOT NULL, actor_id TEXT NOT NULL, connection_id TEXT NOT NULL,
 typing INTEGER NOT NULL DEFAULT 0, typing_expires_at TEXT, focus TEXT, expires_at TEXT NOT NULL,
 PRIMARY KEY(project_id, actor_id, connection_id)
);
CREATE TABLE IF NOT EXISTS collaboration_presenters (
 project_id TEXT PRIMARY KEY, actor_id TEXT, focus TEXT, revision INTEGER NOT NULL DEFAULT 0,
 expires_at TEXT
);
`;
