CREATE TABLE IF NOT EXISTS local_subscribers (
  user_id TEXT PRIMARY KEY,
  device_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS local_outbox_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'character_proactive',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  available_at INTEGER NOT NULL,
  expires_at INTEGER,
  pull_count INTEGER NOT NULL DEFAULT 0,
  pulled_at INTEGER,
  acked_at INTEGER,
  ack_status TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_local_outbox_user_status_created
ON local_outbox_messages(user_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_local_outbox_available
ON local_outbox_messages(status, available_at, expires_at);
