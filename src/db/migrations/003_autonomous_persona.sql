CREATE TABLE IF NOT EXISTS autonomous_run_log (
  id TEXT PRIMARY KEY,
  run_type TEXT NOT NULL,
  assistant_id TEXT NOT NULL,
  session_id TEXT,
  should_persist INTEGER,
  should_initiate INTEGER,
  status TEXT NOT NULL,
  reason TEXT,
  message_intent TEXT,
  draft_message TEXT,
  input_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  error_message TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_autonomous_run_log_type_created
ON autonomous_run_log(run_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_autonomous_run_log_assistant_created
ON autonomous_run_log(assistant_id, created_at DESC);
