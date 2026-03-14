CREATE TABLE IF NOT EXISTS assistant_profile (
  assistant_id TEXT PRIMARY KEY,
  character_name TEXT NOT NULL,
  character_background TEXT NOT NULL DEFAULT '',
  allow_auto_life INTEGER NOT NULL DEFAULT 0,
  allow_proactive_message INTEGER NOT NULL DEFAULT 0,
  last_session_id TEXT,
  last_proactive_check_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assistant_profile_auto_life
ON assistant_profile(allow_auto_life, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_assistant_profile_proactive
ON assistant_profile(allow_proactive_message, updated_at DESC);
