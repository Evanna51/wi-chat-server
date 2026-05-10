-- Migration 032: setup_prompt + lore (Phase 3 / Persona Extraction)
--
-- 把 assistant_profile.character_background 的"混合体"拆成两个字段：
--   - setup_prompt: 用户原始输入（创建/编辑角色时填的全文，存档不直接进 prompt）
--   - lore         : LLM 提炼后的纯叙事段（剥离了 identity 已覆盖的 speaking_style /
--                    boundaries / values 等），进 system prompt 的 <background> slot
--
-- 关系：
--   setup_prompt → personaExtractor (本地 LLM, introspection family)
--                → { identity_fields, lore }
--                → upsert character_identity + 更新 lore 字段
--
-- character_background 列保留（向后兼容 + 未来 fallback 路径）；新写入时同步写
-- setup_prompt（通过 db.js upsertAssistantProfile 双写）。lore 默认 = setup_prompt
-- 直到 LLM 提炼跑完后被替换。
--
-- 为什么不直接 ALTER 重命名 character_background？
--   - SQLite ALTER COLUMN 支持有限
--   - 读写代码大量引用 character_background；逐步迁移更稳
--   - 重命名牵连 sync/snapshot 协议、admin UI、客户端等多处

ALTER TABLE assistant_profile
  ADD COLUMN setup_prompt TEXT NOT NULL DEFAULT '';

ALTER TABLE assistant_profile
  ADD COLUMN lore TEXT NOT NULL DEFAULT '';

-- 一次性 backfill：现有 character_background 复制到 setup_prompt + lore。
-- LLM 提炼跑完后，identity 字段会被 upsert，lore 会被替换为净化后的叙事段。
UPDATE assistant_profile
   SET setup_prompt = COALESCE(character_background, ''),
       lore         = COALESCE(character_background, '')
 WHERE setup_prompt = '' AND lore = '';

-- 提炼状态字段：
--   pending  — 已写 setup_prompt，等待异步提炼
--   ready    — 提炼完成（identity + lore 已更新）
--   failed   — 提炼失败（保留旧 lore + 记 error）
--   skipped  — 不参与提炼（writer / general 类）
--
-- character 类初始化为 'pending'（subscriber 异步触发提炼），
-- 其它类型 'skipped'（identity 字段对它们无意义）。
ALTER TABLE assistant_profile
  ADD COLUMN extraction_status TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE assistant_profile
  ADD COLUMN extraction_error TEXT NOT NULL DEFAULT '';

ALTER TABLE assistant_profile
  ADD COLUMN extracted_at INTEGER NOT NULL DEFAULT 0;

-- 现有数据：character 类标 ready（已有 identity + 老 background 直接当 lore），
-- 其它类型标 skipped（writer 等）。
UPDATE assistant_profile
   SET extraction_status = CASE
     WHEN assistant_type = 'character' THEN 'ready'
     WHEN assistant_type = '' OR assistant_type IS NULL THEN 'pending'
     ELSE 'skipped'
   END
 WHERE extraction_status = 'pending';
