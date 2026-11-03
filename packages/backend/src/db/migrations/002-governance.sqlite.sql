
CREATE TABLE IF NOT EXISTS project_governance (
  project_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0,
  active_release_id TEXT, config TEXT NOT NULL, decision_cursor TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_rules (
  project_id TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(project_id,id)
);
CREATE TABLE IF NOT EXISTS policy_rule_revisions (
  project_id TEXT NOT NULL, id TEXT NOT NULL, rule_id TEXT NOT NULL, revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(project_id,id), UNIQUE(project_id,rule_id,revision),
  FOREIGN KEY(project_id,rule_id) REFERENCES policy_rules(project_id,id)
);
CREATE TABLE IF NOT EXISTS policy_releases (
  project_id TEXT NOT NULL, id TEXT NOT NULL, content_hash TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(project_id,id)
);
CREATE TABLE IF NOT EXISTS governance_task_scopes (
  project_id TEXT NOT NULL, task_id TEXT NOT NULL, scope TEXT NOT NULL,
  PRIMARY KEY(project_id,task_id)
);
CREATE TABLE IF NOT EXISTS governance_replay_inputs (
  project_id TEXT NOT NULL, session_id INTEGER NOT NULL, task_id TEXT NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY(project_id,session_id)
);
CREATE TABLE IF NOT EXISTS governance_task_pins (
  project_id TEXT NOT NULL, task_id TEXT NOT NULL, release_id TEXT NOT NULL, payload TEXT NOT NULL,
  tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
  elapsed_ms INTEGER NOT NULL DEFAULT 0, appeals INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(project_id,task_id),
  FOREIGN KEY(project_id,release_id) REFERENCES policy_releases(project_id,id)
);
CREATE TABLE IF NOT EXISTS review_cases (
  project_id TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL, release_id TEXT NOT NULL,
  state TEXT NOT NULL, version INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,id), UNIQUE(project_id,idempotency_key),
  FOREIGN KEY(project_id,release_id) REFERENCES policy_releases(project_id,id)
);
CREATE INDEX IF NOT EXISTS idx_review_cases_task ON review_cases(project_id,task_id,state);
CREATE TABLE IF NOT EXISTS review_findings (
  project_id TEXT NOT NULL, case_id TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(project_id,case_id,id),
  FOREIGN KEY(project_id,case_id) REFERENCES review_cases(project_id,id)
);
CREATE TABLE IF NOT EXISTS policy_decisions (
  project_id TEXT NOT NULL, id TEXT NOT NULL, case_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,id), UNIQUE(project_id,idempotency_key),
  FOREIGN KEY(project_id,case_id) REFERENCES review_cases(project_id,id)
);
CREATE INDEX IF NOT EXISTS idx_policy_decisions_case ON policy_decisions(project_id,case_id);
CREATE TABLE IF NOT EXISTS governance_events (
  project_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,id)
);
CREATE INDEX IF NOT EXISTS idx_governance_events_kind ON governance_events(project_id,kind);
CREATE TABLE IF NOT EXISTS governance_outbox (
  project_id TEXT NOT NULL, id TEXT NOT NULL, case_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL,
  PRIMARY KEY(project_id,id),
  FOREIGN KEY(project_id,case_id) REFERENCES review_cases(project_id,id)
);
CREATE TABLE IF NOT EXISTS governance_jobs (
  project_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY(project_id,id)
);
CREATE TABLE IF NOT EXISTS policy_proposals (
  project_id TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL,
  source_nomination_id TEXT, payload TEXT NOT NULL, PRIMARY KEY(project_id,id)
);

CREATE TABLE IF NOT EXISTS governance_review_approvals (
  project_id TEXT NOT NULL, task_id TEXT NOT NULL, head_sha TEXT NOT NULL, diff_hash TEXT NOT NULL,
  release_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(project_id,task_id),
  FOREIGN KEY(project_id,release_id) REFERENCES policy_releases(project_id,id)
);

CREATE TABLE IF NOT EXISTS governance_publication_leases (
 project_id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at TEXT NOT NULL, owner TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_proposals_nomination ON policy_proposals(project_id,source_nomination_id);
