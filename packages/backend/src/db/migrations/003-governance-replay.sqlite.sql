ALTER TABLE governance_replay_inputs ADD COLUMN IF NOT EXISTS attempt INTEGER;
ALTER TABLE governance_replay_inputs ADD COLUMN IF NOT EXISTS status TEXT;
CREATE TABLE IF NOT EXISTS governance_replay_fixtures (
  project_id TEXT NOT NULL, session_id INTEGER NOT NULL, task_id TEXT NOT NULL,
  release_id TEXT NOT NULL, hash TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,session_id)
);
