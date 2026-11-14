export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  accepted_by TEXT,
  created_at TEXT NOT NULL,
  accepted_at TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  remote_url TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  runtime_json TEXT NOT NULL,
  credential_id TEXT,
  governance_mode TEXT NOT NULL DEFAULT 'disabled',
  runbook_locked INTEGER NOT NULL DEFAULT 0,
  active_runbook_digest TEXT,
  shadow_record INTEGER NOT NULL DEFAULT 0,
  evolve_cursor TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS frame_versions (
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  markdown TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, version)
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  parent_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  owner_user_id TEXT,
  frame_version INTEGER,
  scope_json TEXT NOT NULL DEFAULT '[]',
  blocked_reason TEXT,
  ship_commit TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dependencies (
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  PRIMARY KEY (work_item_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL UNIQUE,
  cursor INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS thread_entries (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  author_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (thread_id, cursor),
  UNIQUE (thread_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  work_item_id TEXT,
  attempt INTEGER NOT NULL,
  state TEXT NOT NULL,
  role TEXT NOT NULL,
  runbook_digest TEXT,
  execution_contract_hash TEXT,
  base_revision TEXT,
  frame_version INTEGER,
  pid INTEGER,
  heartbeat_at TEXT,
  controller_user_id TEXT,
  control_revision INTEGER NOT NULL DEFAULT 0,
  policy_rule TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  verify_heal_count INTEGER NOT NULL DEFAULT 0,
  code_retry_count INTEGER NOT NULL DEFAULT 0,
  failure_signature TEXT,
  guidance_json TEXT NOT NULL DEFAULT '[]',
  answers_json TEXT NOT NULL DEFAULT '[]',
  failure_note TEXT,
  mid_turn TEXT,
  tool_bindings_json TEXT NOT NULL DEFAULT '{}',
  runtime_argv_json TEXT NOT NULL DEFAULT '[]',
  result_status TEXT,
  result_summary TEXT,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  questions_json TEXT NOT NULL DEFAULT '[]',
  worktree_path TEXT,
  assignment_path TEXT,
  patch_hash TEXT,
  policy_pin_id TEXT,
  slot_released INTEGER NOT NULL DEFAULT 0,
  gate_evaluated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runbook_revisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  document_json TEXT NOT NULL,
  status TEXT NOT NULL,
  probe_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_releases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT,
  UNIQUE (project_id, version)
);

CREATE TABLE IF NOT EXISTS policy_rules (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  text TEXT NOT NULL,
  detector TEXT NOT NULL,
  paths_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS policy_pins (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  release_id TEXT NOT NULL,
  instruction_snapshot TEXT NOT NULL,
  original_scope TEXT NOT NULL,
  base_revision TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  rule_key TEXT,
  rule_revision INTEGER,
  evidence TEXT NOT NULL,
  status TEXT NOT NULL,
  appeal_json TEXT,
  judge_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_cases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  finding_id TEXT,
  work_item_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_rulings (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,
  allowance_json TEXT,
  patch_hash TEXT,
  rule_key TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS allowances (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  patch_hash TEXT,
  paths_json TEXT NOT NULL DEFAULT '[]',
  expires_at TEXT,
  used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scope_grants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  paths_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS congress_nominations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  status TEXT NOT NULL,
  supporting_json TEXT NOT NULL,
  contrary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS congress_proposals (
  id TEXT PRIMARY KEY,
  nomination_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  text TEXT NOT NULL,
  detector TEXT NOT NULL,
  paths_json TEXT NOT NULL DEFAULT '[]',
  author_kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS replay_fixtures (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  inputs_json TEXT NOT NULL,
  held_out_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS replay_evaluations (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  status TEXT NOT NULL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notify_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_items_project ON work_items(project_id, status);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, state);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
`;
