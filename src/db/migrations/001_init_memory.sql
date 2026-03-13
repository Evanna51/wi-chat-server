CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS character_state (
  assistant_id TEXT PRIMARY KEY,
  active_session_id TEXT,
  familiarity INTEGER NOT NULL DEFAULT 0,
  total_turns INTEGER NOT NULL DEFAULT 0,
  last_user_message_at INTEGER,
  last_proactive_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS push_token (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT 'android',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS interaction_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assistant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proactive_message_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assistant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  time_bucket TEXT NOT NULL,
  message TEXT NOT NULL,
  pushed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_turns_assistant_created
ON conversation_turns(assistant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  content TEXT NOT NULL,
  salience REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  vector_status TEXT NOT NULL DEFAULT 'pending',
  vector_provider TEXT,
  vector_updated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_items_assistant_created
ON memory_items(assistant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_item_id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  vector_dim INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_vectors_assistant
ON memory_vectors(assistant_id);

CREATE TABLE IF NOT EXISTS memory_facts (
  id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  memory_item_id TEXT NOT NULL,
  fact_key TEXT NOT NULL,
  fact_value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_facts_assistant_key
ON memory_facts(assistant_id, fact_key);

CREATE TABLE IF NOT EXISTS memory_edges (
  id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  source_memory_id TEXT NOT NULL,
  target_memory_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_edges_assistant_source
ON memory_edges(assistant_id, source_memory_id);

CREATE TABLE IF NOT EXISTS outbox_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbox_status_next_retry
ON outbox_events(status, next_retry_at, created_at);

CREATE TABLE IF NOT EXISTS dead_letter_events (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_checkpoints (
  name TEXT PRIMARY KEY,
  last_event_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_retrieval_log (
  id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  query_text TEXT NOT NULL,
  selected_memory_ids_json TEXT NOT NULL,
  score_breakdown_json TEXT NOT NULL,
  strategy TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduler_locks (
  lock_name TEXT PRIMARY KEY,
  leader_id TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
