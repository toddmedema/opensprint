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
CREATE TABLE IF NOT EXISTS spec_local_publication_requests (
  project_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  policy TEXT NOT NULL,
  not_before TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS spec_approval_receipts (
  project_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  destination TEXT NOT NULL,
  action TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (project_id, revision)
);
CREATE TABLE IF NOT EXISTS spec_hil_proposals (
  request_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  base_content_hash TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  base_sha TEXT NOT NULL,
  destination TEXT NOT NULL,
  action TEXT NOT NULL,
  decision TEXT NOT NULL,
  decision_actor_id TEXT,
  status TEXT NOT NULL,
  draft_revision INTEGER,
  created_at TEXT NOT NULL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS worker_artifact_publications (
  project_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, attempt_id, generation)
);
`;
