CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  last_connection_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  destroyed_at INTEGER,
  session_init_json TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  connection_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_session_created
ON events(session_id, created_at, id);

CREATE TABLE IF NOT EXISTS opencode_session_metadata (
  session_id TEXT PRIMARY KEY,
  metadata_json TEXT NOT NULL
);
