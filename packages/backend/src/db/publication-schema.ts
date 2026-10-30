export const PUBLICATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS spec_drafts (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, revision)
);
CREATE TABLE IF NOT EXISTS spec_draft_heads (
  project_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS spec_draft_approvals (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  destination TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (project_id, revision)
);
CREATE TABLE IF NOT EXISTS spec_publications (
  project_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  commit_sha TEXT,
  document_version INTEGER,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, operation_id)
);
`;
