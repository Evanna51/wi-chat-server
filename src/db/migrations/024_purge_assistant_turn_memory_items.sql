-- T-08: 清理所有 assistant_turn 类 memory_items 及其衍生数据。
--
-- 背景：assistant_turn 实测 0 facts、retrieval DEFAULT_TYPES 已排除、indexer 标 skipped，
-- 占用空间却毫无用处。改完 memoryIngestService 后 assistant role 不再写 memory_items；
-- 这次 migration 把存量也清干净。
--
-- 级联（按当前数据 627 行 assistant_turn）：
--   - memory_facts            (0 行级联，本来就不抽 fact)
--   - memory_vectors          (1 行残留，cleanup 脚本漏掉的)
--   - memory_edges            (~1000 行级联，temporal_next 链)
--   - memory_audit_log        (0 行)
--   - outbox_events           (~627 行 aggregate)
--
-- conversation_turns 中的 role='assistant' 原文 **保留不动** —— 原文是真实交互记录，
-- 仅是不再派生记忆抽象。

-- 子查询展开为临时 view 提升可读性
WITH targets AS (
  SELECT id FROM memory_items WHERE memory_type = 'assistant_turn'
)
DELETE FROM memory_facts WHERE memory_item_id IN (SELECT id FROM targets);

DELETE FROM memory_vectors
 WHERE memory_item_id IN (SELECT id FROM memory_items WHERE memory_type = 'assistant_turn');

DELETE FROM memory_edges
 WHERE source_memory_id IN (SELECT id FROM memory_items WHERE memory_type = 'assistant_turn')
    OR target_memory_id IN (SELECT id FROM memory_items WHERE memory_type = 'assistant_turn');

DELETE FROM memory_audit_log
 WHERE memory_item_id IN (SELECT id FROM memory_items WHERE memory_type = 'assistant_turn');

DELETE FROM outbox_events
 WHERE aggregate_type = 'memory_item'
   AND aggregate_id IN (SELECT id FROM memory_items WHERE memory_type = 'assistant_turn');

DELETE FROM memory_items WHERE memory_type = 'assistant_turn';
