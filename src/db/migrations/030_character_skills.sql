-- Migration 030: Character Skills (Phase CC-5 / T-CC5-A+B)
--
-- 给 character_identity 加一个 skills_json 列，存"角色会用的表达技巧"。
--
-- 设计：
--   * 跟 disposition (trait) 分开 —— trait 是"想不想"，skill 是"会不会"。
--     同样 prideful + dry_witted 的两个角色，skill=[literary_allusion] 的会引用文学，
--     没这个 skill 的就直接讽。两层独立，downstream（LLM 自己）来组合。
--   * 自由文本数组（不 FK，跟 desires_json / insecurities_json 风格一致）。
--   * 支持两种 item 格式：
--       string                              —— 用全局 vocab 里的 skill 名
--       { "name": "...", "examples": [...] } —— 角色专属 voice 锚（few-shot 强于描述）
--   * COMMON_SKILLS vocab 在 src/services/character/identityVocab.js 里，
--     不在这个 SQL 里固化（vocab 演进比 schema 快）。

ALTER TABLE character_identity
  ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]';
