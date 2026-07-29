const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  result_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0,
  not_before_ms INTEGER NOT NULL DEFAULT 0,
  locked_until_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_claimable
ON jobs(type, state, not_before_ms, locked_until_ms, created_at);

CREATE TABLE IF NOT EXISTS capture_sessions (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  requested_name TEXT NOT NULL DEFAULT '',
  discord_thread_id TEXT NOT NULL DEFAULT '',
  discord_thread_name TEXT NOT NULL DEFAULT '',
  apps_script_session_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_capture_sessions_thread
ON capture_sessions(discord_thread_id);
`;

module.exports = {
  SCHEMA_SQL
};
