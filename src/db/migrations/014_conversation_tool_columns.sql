-- Migration 014: 工具调用 / 系统消息 row 支持
--
-- 给 conversation_turns 加 tool_calls_json / tool_call_id / tool_name 三列，
-- 配合 sync-push 接受 tool_call / tool_result / system 三种 role。
--
-- 这三种 role 仅写入 conversation_turns（日志型）：
--   - 不进 memory_items / memory_facts / memory_edges / memory_vectors
--   - 不触发 outbox 索引、不调 LLM 分类
--   - 但 conversation_turns_fts trigger 自动索引（共享现有 FTS5 表），
--     /api/search 仍可命中
--
-- 字段语义（与 chatbox-Android Message.kt 对齐）：
--   tool_calls_json — 仅 role='tool_call'。OpenAI 风格 tool_calls 数组 JSON
--   tool_call_id    — 仅 role='tool_result'。指向触发本结果的 assistant tool_call id
--   tool_name       — 仅 role='tool_result'。被调用的 tool 名 (e.g. search_memory)
--
-- 三列均允许 NULL，向后兼容老 row（user/assistant 行不填这三列）。

ALTER TABLE conversation_turns ADD COLUMN tool_calls_json TEXT;
ALTER TABLE conversation_turns ADD COLUMN tool_call_id    TEXT;
ALTER TABLE conversation_turns ADD COLUMN tool_name       TEXT;

CREATE INDEX IF NOT EXISTS idx_conversation_turns_tool_call_id
  ON conversation_turns(tool_call_id) WHERE tool_call_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_turns_tool_name
  ON conversation_turns(tool_name) WHERE tool_name IS NOT NULL;
