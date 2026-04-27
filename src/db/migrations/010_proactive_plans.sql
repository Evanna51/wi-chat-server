CREATE TABLE IF NOT EXISTS proactive_plans (
  id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  trigger_reason TEXT NOT NULL,
  intent TEXT NOT NULL,
  draft_title TEXT,
  draft_body TEXT NOT NULL,
  anchor_topic TEXT,
  rationale TEXT,
  scheduled_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  cancelled_reason TEXT,
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proactive_plans_scheduled
  ON proactive_plans(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_proactive_plans_assistant
  ON proactive_plans(assistant_id, created_at DESC);
