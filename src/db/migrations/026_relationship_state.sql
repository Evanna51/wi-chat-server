-- Migration 026: Multi-dimensional Relationship State + Event Log (Phase CC-1 / T-CC-02)
--
-- 现状：character_state 只有 1 维 intimacy_score + relationship_level (0-9)。
-- 缺陷：没法表达"trust 高但 abandonment_fear 也高"这种活人特有的多维张力，
--      proactive / reflection 都拿不到细分信号。
--
-- 设计：
--   * relationship_state 与 character_state 共存，不替换。
--     character_state = 实时态（每条消息更新，秒/分钟级，已有 38 测试断言）
--     relationship_state = 中期累积态（事件触发更新，小时/天级）
--     Phase 3 reflection = 长期态（cron 周期，天/周级）
--   * 12 维全部 0-1，独立衰减半衰期（在 relationshipDynamicsService 里配置）
--   * 时间戳字段记录关键事件最近发生时刻 → "上次袒露 5 天前" 这类查询是 O(1)
--   * relationship_event 是事件流水，给 reflection 服务做数据源
--
-- 维度选取（用户列了 10 个，扩展加 2 个）：
--   原 10：trust, dependency, emotional_safety, attachment, tension,
--          unresolved_conflict, abandonment_fear, reciprocity_balance,
--          emotional_closeness, social_distance
--   新增 2：
--     resentment（怨气）— 累积的未表达不满。和 unresolved_conflict 不同：
--       conflict 是显性，resentment 是隐性，会慢慢转化成 cold_response 倾向
--     gratitude（感激度）— 被照顾后累积，决定 reciprocated_care 的反向触发概率

CREATE TABLE IF NOT EXISTS relationship_state (
  assistant_id TEXT PRIMARY KEY,

  -- ── 12 维动力学（全部 0-1）────────────────────────────
  trust REAL NOT NULL DEFAULT 0.3,
  dependency REAL NOT NULL DEFAULT 0.1,
  emotional_safety REAL NOT NULL DEFAULT 0.4,
  attachment REAL NOT NULL DEFAULT 0.2,
  tension REAL NOT NULL DEFAULT 0.0,
  unresolved_conflict REAL NOT NULL DEFAULT 0.0,
  abandonment_fear REAL NOT NULL DEFAULT 0.0,
  -- reciprocity_balance: 0 = AI 单方付出, 0.5 = 平衡, 1 = 用户单方付出
  reciprocity_balance REAL NOT NULL DEFAULT 0.5,
  emotional_closeness REAL NOT NULL DEFAULT 0.2,
  social_distance REAL NOT NULL DEFAULT 0.7,
  resentment REAL NOT NULL DEFAULT 0.0,
  gratitude REAL NOT NULL DEFAULT 0.0,

  -- ── 关键事件最近发生时间 ──────────────────────────────
  last_trust_event_at INTEGER,
  last_conflict_at INTEGER,
  last_reassurance_at INTEGER,
  last_vulnerable_share_at INTEGER,
  last_reciprocated_care_at INTEGER,
  last_distancing_signal_at INTEGER,

  -- ── 元数据 ────────────────────────────────────────────
  -- 来源 identity，初始化时拷贝；identity 变更后下次刷新
  initialized_from_identity_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 关系事件流水。给 reflection 服务做数据源 + 调试用。
-- 写入路径：relationshipDynamicsService.applyRelationshipEvent
-- 不打 source_turn_id 索引（按时间倒序拉是主要 query pattern）
CREATE TABLE IF NOT EXISTS relationship_event (
  id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  -- intensity: 0-1，事件强度，决定 delta 量级
  intensity REAL NOT NULL DEFAULT 0.5,
  -- source_turn_id: 可关联到 conversation_turns.id，nullable（系统事件如 silence 触发时为 NULL）
  source_turn_id TEXT,
  -- delta_json: 实际写入到 12 维的 delta，例 {"trust":+0.05,"abandonment_fear":-0.02}
  delta_json TEXT NOT NULL DEFAULT '{}',
  -- description: 可选，人类可读说明，admin/调试用
  description TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relationship_event_assistant_time
  ON relationship_event(assistant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_relationship_event_type_time
  ON relationship_event(event_type, created_at DESC);
