-- 修 memory_items_fts 持续膨胀的根因：原 AFTER UPDATE trigger 不带 WHEN 条件，
-- 导致每次 retrieveMemory 末尾的 cite_count 自增（line 358-367 in memoryRetrievalService.js）
-- 都触发一次 FTS delete+insert，content 根本没变也照 rebuild。
--
-- 修复：仅在 FTS 实际持有的字段（content / memory_type / assistant_id）发生变化时才重建索引。
-- 这样 cite_count / last_cited_at / vector_status / quality_grade / category 等高频更新对 FTS 透明，
-- 不再膨胀。consolidation 效应（cite_count 用于 scoreRecency）业务行为完全保留。
--
-- IS NOT 是 null-safe 比较；content/memory_type/assistant_id 实际都是 NOT NULL，但用 IS NOT 更稳妥。

DROP TRIGGER IF EXISTS memory_items_au;

CREATE TRIGGER memory_items_au AFTER UPDATE ON memory_items
WHEN OLD.content IS NOT NEW.content
  OR OLD.memory_type IS NOT NEW.memory_type
  OR OLD.assistant_id IS NOT NEW.assistant_id
BEGIN
  INSERT INTO memory_items_fts(memory_items_fts, rowid, content, assistant_id, memory_type)
  VALUES ('delete', old.rowid, old.content, old.assistant_id, old.memory_type);
  INSERT INTO memory_items_fts(rowid, content, assistant_id, memory_type)
  VALUES (new.rowid, new.content, new.assistant_id, new.memory_type);
END;
