-- Migration 011: 角色情绪 & 关系状态机字段
-- 在现有 character_state 表上增列，不破坏已有数据。

ALTER TABLE character_state ADD COLUMN mood_emotion    TEXT    NOT NULL DEFAULT 'calm';
ALTER TABLE character_state ADD COLUMN mood_intensity  REAL    NOT NULL DEFAULT 0.3;
ALTER TABLE character_state ADD COLUMN mood_valence    REAL    NOT NULL DEFAULT 0.1;
ALTER TABLE character_state ADD COLUMN mood_arousal    REAL    NOT NULL DEFAULT 0.2;
ALTER TABLE character_state ADD COLUMN mood_updated_at INTEGER;
ALTER TABLE character_state ADD COLUMN relationship_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE character_state ADD COLUMN intimacy_score  REAL    NOT NULL DEFAULT 0.0;
ALTER TABLE character_state ADD COLUMN energy          REAL    NOT NULL DEFAULT 0.7;
ALTER TABLE character_state ADD COLUMN energy_updated_at INTEGER;
ALTER TABLE character_state ADD COLUMN focus_topic     TEXT;
ALTER TABLE character_state ADD COLUMN focus_depth     INTEGER NOT NULL DEFAULT 0;
