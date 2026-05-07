-- Migration 018: knowledge 类型 memory + pinned（关键记忆）支持
--
-- 1. memory_items 接受新 memory_type='knowledge'（知识库条目，非对话副产品）
--    - source_turn_id 仍 NOT NULL；knowledge 类型用 'knowledge:<kb_name>:<uuid>' 占位
--      （SQLite ALTER 不支持改列约束，但占位字符串 + index 足够语义清晰）
--    - 加 kb_name 字段：知识空间分组（'world_lore' / 'user_health' / 'novel_outline' 等）
--    - 加 kb_tags_json 字段：可选标签数组
--    - kb_name + kb_tags_json 仅 knowledge 类型使用，其它类型为 NULL
--
-- 2. is_pinned + pinned_at：关键记忆标记
--    - is_pinned=1 的记忆通过 memory-context 始终注入到对话 system prompt（"核心记忆"）
--    - 不依赖 query，是 always-on 注入
--    - AI 通过 memory-correct action='pin'/'unpin' 维护
--    - 用户也可以在浏览器 UI 上手动 pin

ALTER TABLE memory_items ADD COLUMN kb_name TEXT;
ALTER TABLE memory_items ADD COLUMN kb_tags_json TEXT;
ALTER TABLE memory_items ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_items ADD COLUMN pinned_at INTEGER;

-- knowledge 检索按 (assistant_id, kb_name) 过滤
CREATE INDEX IF NOT EXISTS idx_memory_items_kb
  ON memory_items(assistant_id, kb_name, created_at DESC)
  WHERE kb_name IS NOT NULL;

-- 关键记忆查询：按 (assistant, pinned=1, salience DESC)
CREATE INDEX IF NOT EXISTS idx_memory_items_pinned
  ON memory_items(assistant_id, is_pinned, salience DESC)
  WHERE is_pinned = 1;
