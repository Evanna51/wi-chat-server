-- Migration 013: 用户记忆分类 + 质量评级 + 引用计数
-- 给 memory_items 加语义维度，让 catchup/proactivePlan/RAG 能按维度筛选与加权。
-- 仅对 memory_type='user_turn' 的行做分类，其它类型保持 NULL。

ALTER TABLE memory_items ADD COLUMN memory_category    TEXT;
ALTER TABLE memory_items ADD COLUMN category_confidence REAL    NOT NULL DEFAULT 0.0;
ALTER TABLE memory_items ADD COLUMN category_method     TEXT;    -- heuristic | llm | manual
ALTER TABLE memory_items ADD COLUMN quality_grade       TEXT;    -- 'A'..'E'
ALTER TABLE memory_items ADD COLUMN cite_count          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_items ADD COLUMN last_cited_at       INTEGER;

CREATE INDEX IF NOT EXISTS idx_memory_items_category
  ON memory_items(assistant_id, memory_category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_items_unclassified
  ON memory_items(memory_type, memory_category)
  WHERE memory_category IS NULL;
