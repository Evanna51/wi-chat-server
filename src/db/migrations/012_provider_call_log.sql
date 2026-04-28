-- Migration 012: LLM provider 调用日志，用于 token 计数和成本追踪
CREATE TABLE IF NOT EXISTS provider_call_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  provider     TEXT    NOT NULL,
  call_type    TEXT    NOT NULL,   -- 'chat' | 'embed'
  model        TEXT    NOT NULL DEFAULT '',
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms   INTEGER NOT NULL DEFAULT 0,
  ok           INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_call_log_created
  ON provider_call_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_provider_call_log_provider
  ON provider_call_log(provider, call_type, created_at DESC);
