export const PROJECT_CATALOG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS project_catalog (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS project_catalog_clock (
  singleton INTEGER PRIMARY KEY,
  revision BIGINT NOT NULL
);
INSERT INTO project_catalog_clock (singleton,revision) VALUES (1,0) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS project_catalog_migrations (source TEXT PRIMARY KEY);
`;
