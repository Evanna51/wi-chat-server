-- Migration 034: 角色日记 / 周记
--
-- 给角色一个"自我书写"的产物：每天/每周由 LLM 用角色第一人称写一段叙事
-- （素材来自 conversation_turns + narrative_episode，周记额外吃 reflection）。
--
-- 设计取舍：
--   - 单表 character_journal 同时存日记 / 周记，用 period_type 区分 —— 避免双表
--   - 不存中间原始数据（turns / episodes 引用），只存最终 LLM 文本，体量可控
--   - content 限长由 service 层 clip，schema 不加 CHECK 约束（SQLite ALTER 麻烦）
--   - UNIQUE(assistant_id, period_type, period_start) 防止同一周/同一天重复写入
--     （cron 重跑、admin force 重排、PM2 双实例等场景）

CREATE TABLE IF NOT EXISTS character_journal (
  id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,

  -- 'daily' | 'weekly'
  period_type TEXT NOT NULL,

  -- 该 entry 覆盖的素材时间窗（ms epoch）
  -- daily：昨天 00:00:00 ~ 昨天 23:59:59.999（本地时区）
  -- weekly：上周一 00:00:00 ~ 上周日 23:59:59.999
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,

  -- 'YYYY-MM-DD'，写入当日本地日期（10:30 / 周一 00:30 触发那一天）
  -- 跟 period_start/end 解耦：列表里既能"按 entry_date 显示"也能"按覆盖窗口排序"
  entry_date TEXT NOT NULL,

  -- 角色第一人称叙事文本，LLM 输出
  content TEXT NOT NULL,

  created_at INTEGER NOT NULL,

  UNIQUE (assistant_id, period_type, period_start)
);

CREATE INDEX IF NOT EXISTS idx_journal_assistant_created
  ON character_journal(assistant_id, period_type, created_at DESC);

-- ── assistant_profile 加日记 / 周记开关 ────────────────────────────────
--
-- 复用既有 enable_xxx 0/1 风格（参考 allow_proactive_message / allow_auto_life）。
-- cron tick 扫 enable_*=1 的 profile。

ALTER TABLE assistant_profile ADD COLUMN enable_daily_journal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assistant_profile ADD COLUMN enable_weekly_journal INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_assistant_profile_journal_daily
  ON assistant_profile(enable_daily_journal) WHERE enable_daily_journal = 1;
CREATE INDEX IF NOT EXISTS idx_assistant_profile_journal_weekly
  ON assistant_profile(enable_weekly_journal) WHERE enable_weekly_journal = 1;
