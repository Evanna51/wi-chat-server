-- Migration 017: memory_audit_log
--
-- 记录所有 memory 编辑动作（删除/修改/质量重打/事实增删），方便追溯
-- "AI 改了/删了什么"。actor 可以是 'ai' / 'user' / 'system' / 自定义。
-- payload_json 存动作前后的 diff（如 oldContent/newContent、oldGrade/newGrade）。

CREATE TABLE IF NOT EXISTS memory_audit_log (
  id              TEXT PRIMARY KEY,                -- uuid v7
  assistant_id    TEXT NOT NULL,
  memory_item_id  TEXT,                            -- 可选：动作针对哪条 memory
  turn_id         TEXT,                            -- 可选：动作影响哪条 conversation_turn
  action          TEXT NOT NULL,                   -- delete_turn | delete_memory | update_content | set_quality | add_fact | remove_fact
  actor           TEXT NOT NULL DEFAULT 'ai',      -- ai | user | system | <custom>
  reason          TEXT,
  payload_json    TEXT,                            -- 行为细节 JSON
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_audit_log_assistant
  ON memory_audit_log(assistant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_audit_log_memory
  ON memory_audit_log(memory_item_id, created_at DESC)
  WHERE memory_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_audit_log_action
  ON memory_audit_log(action, created_at DESC);
