-- T-01: drop legacy proactive_message_log table.
-- 该表是早期 FCM 推送记录，新链路（proactive_plans + plan-executor）不再写入；
-- 也不在 retentionSweeper 扫描范围内，纯死表。
-- 影响：scripts/db-query.js 不能再 --table proactive_message_log（已同步删除该选项）。

DROP TABLE IF EXISTS proactive_message_log;
