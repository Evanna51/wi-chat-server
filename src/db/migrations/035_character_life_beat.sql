-- Migration 035: character life beat —— 取代 catchupService 的"角色独立时间线"
--
-- 思路：每天 04:00 给每个 active 角色生成 10-20 个 beat（具体时刻 + 在做什么）；
-- */15min cron 扫到点的 pending beat → 落 memory_items + 视情况触发 proactive。
-- 设计文档：docs/character-life-beat-plan.md
--
-- beat_type 区分两种 beat：
--   autonomous —— 角色自己的独立时刻（喝咖啡 / 通勤），不直接驱动 proactive
--   anchored   —— 引用了用户事实/对话 anchor 的时刻（"想到 ta 上次说的 X"），
--                  importance ≥ 阈值 + 当前独处 → 驱动 proactive seed
--
-- scheduled_at = ms epoch（绝对时刻）；plan_date 'YYYY-MM-DD' 本地。这两冗余存
-- 是因为查询路径不同：tick 用 scheduled_at 范围扫，daily plan 用 plan_date 过期。
--
-- status：
--   pending    —— 还没到点
--   activated  —— 已落 memory_item
--   skipped    —— 评估后决定不落（dedup / 越窗）
--   expired    —— 第二天 daily-life-plan tick 把过期 pending 转 expired

CREATE TABLE IF NOT EXISTS character_life_beat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assistant_id TEXT NOT NULL,
  plan_date TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  activity TEXT NOT NULL,
  beat_type TEXT NOT NULL,
  reach_seed TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'pending',
  activated_at INTEGER,
  memory_item_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (assistant_id, plan_date, scheduled_at)
);

-- tick 主查询：where status='pending' AND scheduled_at <= now ORDER BY scheduled_at
CREATE INDEX IF NOT EXISTS idx_life_beat_pending_scheduled
  ON character_life_beat(status, scheduled_at)
  WHERE status = 'pending';

-- planner / debug 查"角色今天的全表"：where assistant_id=? AND plan_date=?
CREATE INDEX IF NOT EXISTS idx_life_beat_assistant_date
  ON character_life_beat(assistant_id, plan_date);

-- context builder 拼"当前正在做什么"用：where assistant_id=? AND status='activated' ORDER BY activated_at DESC LIMIT 1
CREATE INDEX IF NOT EXISTS idx_life_beat_activated
  ON character_life_beat(assistant_id, activated_at DESC)
  WHERE status = 'activated';

-- ── assistant_profile 加睡眠时段 ────────────────────────────────────
--
-- 'HH:MM-HH:MM' 形如 '23:00-07:30'。允许跨午夜（end < start 时表示跨日）。
-- nullable → LLM 自己根据 identity 判断作息（多数角色不需要单独配）。
-- planner 拿到这个字段后会把睡眠时段在 prompt 里标"这段时间空着"。

ALTER TABLE assistant_profile ADD COLUMN life_sleep_hours TEXT;
