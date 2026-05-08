-- Migration 029: Relationship Reflection (Phase CC-3)
--
-- Phase 1 给了"角色是谁"，Phase 2 给了"过去发生了什么"。
-- Phase 3 给"AI 对当下整体关系的综合理解"——不是 retrieval 也不是 narrative，
-- 而是 synthesis："最近你跟 ta 之间在哪个方向" / "ta 现在主要的需要是什么" /
-- "你应该担心 / 抓住的是什么"。
--
-- 这个层是 AI 的元认知。下面的 promptFragment 注入它，让 LLM 不只看到具体事实，
-- 还看到"你自己（角色）是怎么理解你跟 ta 此刻的处境的"。
--
-- 写入路径：
--   reflection_type='weekly'           周级 cron（每周日 03:30）
--   reflection_type='event_triggered'  事件触发（trust 跌幅 > 0.15 / silence > 14d / unresolved_conflict 持续 > 7d）
--   reflection_type='manual'           admin / API 手动触发
--
-- 同一 assistant 的 reflection 不替换旧行 —— 累积成时间线，类似日记。
-- 检索时取 ORDER BY created_at DESC LIMIT 1（最新一条）。
-- 旧行可作为 reflection.previousSummary 在新一轮 LLM 输入里用，做"接续上一次反思"。

CREATE TABLE IF NOT EXISTS relationship_reflection (
  id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  reflection_type TEXT NOT NULL,           -- 'weekly' | 'event_triggered' | 'manual'

  -- 核心：一段 80-200 字的自然语言总结，会进 prompt
  summary TEXT NOT NULL,

  -- 情绪走向：'improving' | 'declining' | 'stable' | 'volatile'
  emotional_trend TEXT NOT NULL DEFAULT 'stable',

  -- 关系方向：'deepening' | 'cooling' | 'stable' | 'tense' | 'reconnecting'
  relationship_direction TEXT NOT NULL DEFAULT 'stable',

  -- 用户需求识别：JSON string[]，例 ["需要被肯定","希望保持距离","想要建议"]
  -- vocab 不强制（自由文本），但建议从 Phase 4 behaviorPlanner 用得上的常见集挑
  user_needs_json TEXT NOT NULL DEFAULT '[]',

  -- 担忧的事 / AI 自己担心的（基于 abandonment_fear / unresolved_conflict 等动力）
  concerns_json TEXT NOT NULL DEFAULT '[]',

  -- 接近 / 增进关系的机会（给 Phase 4 behaviorPlanner 用）
  -- 例 ["用户生日临近 → ritualistic 模式","钢琴比赛下周 → 主动问候"]
  opportunities_json TEXT NOT NULL DEFAULT '[]',

  -- source_data: 哪些 episodes/topics/events 产出的，便于回溯/调试
  -- {episodeIds: [], topicIds: [], eventIds: [], snapshotTs: <ms>}
  source_data_json TEXT NOT NULL DEFAULT '{}',

  -- 时间窗：reflection 涵盖的时间范围
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL,

  -- 触发原因（event_triggered 时记录）
  trigger_reason TEXT,

  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relationship_reflection_assistant_time
  ON relationship_reflection(assistant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_relationship_reflection_type
  ON relationship_reflection(assistant_id, reflection_type, created_at DESC);
