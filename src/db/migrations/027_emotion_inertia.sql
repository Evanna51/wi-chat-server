-- Migration 027: Emotional Inertia Layer (Phase CC-1 / T-CC-04)
--
-- 现状：character_state 已有 mood_emotion + intensity + valence + arousal + 6h 半衰期。
-- 缺陷：mood 是"瞬时态"。用户上一句让角色 sad（intensity=0.7），下一句讲笑话，
--      mood 立刻跳到 cheerful——这不是活人。活人的反应是：
--      "表面笑了，但底下还压着难过"。
--
-- 加 4 列：
--   suppressed_emotion          压抑下去的旧情绪 id（GoEmotions vocab）
--   suppressed_emotion_intensity  压抑情绪的当前强度（独立衰减，半衰期 24h，比明面 6h 慢得多）
--   unresolved_emotion_topic    触发该情绪的话题/事件自由描述
--                                例 "被冷落"、"工作被否决"。
--                                必须由 reconciliation / 主动 clear 事件清掉。
--   mood_trend_24h              过去 24h valence 滑动均值（EMA），-1 ~ 1
--                                给 reflection 服务做"最近整体心情"判断的输入。

ALTER TABLE character_state ADD COLUMN suppressed_emotion TEXT;
ALTER TABLE character_state ADD COLUMN suppressed_emotion_intensity REAL NOT NULL DEFAULT 0;
ALTER TABLE character_state ADD COLUMN suppressed_emotion_updated_at INTEGER;
ALTER TABLE character_state ADD COLUMN unresolved_emotion_topic TEXT;
ALTER TABLE character_state ADD COLUMN mood_trend_24h REAL NOT NULL DEFAULT 0;
