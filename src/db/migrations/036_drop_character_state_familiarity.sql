-- Migration 036: Drop character_state.familiarity (T-03)
--
-- familiarity = floor(total_turns / 3) capped 100 — 纯派生值，已被 intimacy_score
-- (0..200, LLM cognition router 推动) + relationship_level (12 档) 取代。
-- 见 docs/refactor-plan.md T-03。
--
-- SQLite 3.35+ 支持原生 DROP COLUMN，无需 table rebuild。

ALTER TABLE character_state DROP COLUMN familiarity;
