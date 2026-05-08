-- 砍掉 conversation_turns_fts：trigram FTS 7x 膨胀，且只被 /admin/search-fts 调试接口用到。
-- 主检索链路走 vector + memory_items_fts，conversation 检索改回 LIKE（1k 行级毫秒级）。
-- 预期回收：~7.5 MB（含 fts_data/fts_idx/fts_docsize/fts_config 等内部表）。

DROP TRIGGER IF EXISTS conversation_turns_ai;
DROP TRIGGER IF EXISTS conversation_turns_au;
DROP TRIGGER IF EXISTS conversation_turns_ad;

DROP TABLE IF EXISTS conversation_turns_fts;
