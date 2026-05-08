-- Migration 025: Character Identity Layer (Phase CC-1 / T-CC-01)
--
-- Phase 1 of the 7-layer Character Cognition redesign.
-- 把"人格底色"做成第一公民。在此之前 assistant_profile.character_background 是
-- 一段裸 TEXT，无法被任何下游服务结构化消费 —— relationship dynamics、emotion inertia、
-- social mode selection、reflection 都需要"这个角色到底是什么样的人"作为系数来源。
--
-- 设计要点：
--   * 1:1 relation to assistant_profile（assistant_id UNIQUE），不允许多 identity per assistant。
--     角色"成长"通过 identity_version + 字段就地更新表达，不是新建 identity 行。
--   * 所有结构化字段用 JSON：不是因为懒，而是 vocab 在 src/services/character/identityVocab.js
--     里维护，进 DB 反而限制 evolution 速度。SQLite JSON1 支持 json_extract，未来要 query 不难。
--   * 不加 FK 约束：与现有 schema 风格一致（其它表也没用 FK，运行时 service 层维护引用）。
--   * 不让 character_background 退役：保留向后兼容，identity 是 character_background 的结构化升级版。

CREATE TABLE IF NOT EXISTS character_identity (
  identity_id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL UNIQUE,
  identity_version INTEGER NOT NULL DEFAULT 1,

  -- ── 基本属性 ───────────────────────────────────────────
  age_years INTEGER,                                   -- nullable，未必所有角色有"年龄"
  gender_expression TEXT,                              -- 自由文本，但建议从 vocab 取
  speaking_style TEXT NOT NULL DEFAULT '',             -- "克制理性，少用感叹号" "口语化，常带语气词"
  worldview TEXT NOT NULL DEFAULT '',                  -- 世界观/人生观自由描述

  -- ── 人格结构 ───────────────────────────────────────────
  -- personality_traits_json: string[]，受控 vocab，例 ["high_sensitivity","avoidant_attachment"]
  personality_traits_json TEXT NOT NULL DEFAULT '[]',
  -- attachment_style: 'secure' | 'anxious' | 'avoidant' | 'disorganized' | NULL
  attachment_style TEXT,
  emotional_sensitivity REAL NOT NULL DEFAULT 0.5,     -- 0-1，影响所有 mood delta 的放大系数
  empathy_level REAL NOT NULL DEFAULT 0.5,             -- 0-1，影响关心型 proactive 频率
  expressiveness REAL NOT NULL DEFAULT 0.5,            -- 0-1，影响回复长度倾向
  -- social_strategy_default: 默认主导 social mode，可被运行时 chooseSocialMode 覆盖
  social_strategy_default TEXT,

  -- ── 价值观 / 边界 ─────────────────────────────────────
  values_json TEXT NOT NULL DEFAULT '[]',              -- string[]
  -- hard_boundaries_json: string[]，绝对禁忌，触碰即触发 defensive mode
  hard_boundaries_json TEXT NOT NULL DEFAULT '[]',
  -- soft_boundaries_json: string[]，柔性边界，反复触碰才会升级为冲突
  soft_boundaries_json TEXT NOT NULL DEFAULT '[]',
  -- avoidance_topics_json: string[]，会主动回避谈论的话题
  avoidance_topics_json TEXT NOT NULL DEFAULT '[]',
  -- triggering_topics_json: string[]，一谈起就情绪激动的话题（与 avoidance 不同：会聊但激动）
  triggering_topics_json TEXT NOT NULL DEFAULT '[]',

  -- ── 内核（决定 dynamics 初始值与衰减系数） ───────────
  -- insecurities_json: string[]，例 ["fear_of_abandonment","fear_of_being_boring"]
  insecurities_json TEXT NOT NULL DEFAULT '[]',
  -- core_wounds_json: string[]，root cause，比 insecurities 更深，例 ["childhood_neglect"]
  core_wounds_json TEXT NOT NULL DEFAULT '[]',
  desires_json TEXT NOT NULL DEFAULT '[]',
  -- care_languages_json: { "give": string[], "receive": string[] }，区分给和收
  care_languages_json TEXT NOT NULL DEFAULT '{"give":[],"receive":[]}',
  -- tensions_json: { tension_id: 0-1 }，例 {"intimacy_vs_independence": 0.7}
  --   值越大越倾向左侧；0.5 = 平衡；
  --   下游 reflection / behavior 会基于 tension 当前值挑选行为路径
  tensions_json TEXT NOT NULL DEFAULT '{}',

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_character_identity_assistant
  ON character_identity(assistant_id);

-- assistant_profile 加引用列。允许 NULL（向后兼容旧 assistant），
-- 但 service 层在 ensureDefaultIdentity 时会自动回填。
ALTER TABLE assistant_profile ADD COLUMN identity_id TEXT;
CREATE INDEX IF NOT EXISTS idx_assistant_profile_identity
  ON assistant_profile(identity_id);
