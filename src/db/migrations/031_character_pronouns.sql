-- Migration 031: Character Pronouns (Phase CC-5.C / 性别配置)
--
-- 给 character_identity 加 pronouns 列。这是英文 voice anchor 渲染的关键 ——
-- 之前硬编码 "Speak as her" 假设所有角色都是女性，男性 / non-binary 角色就错了。
--
-- 字段是 string（不是 JSON）：值通常是 "she/her" / "he/him" / "they/them" 之一，
-- 也接受自由文本（如 xe/xem、自定义）。空字符串 → service 层 fallback 到 "they/them"
-- （gender-neutral 默认）。
--
-- 与 gender_expression 的区别：
--   - gender_expression：性别表达（自由文本，如 "feminine" / "masculine" / "androgynous"）
--   - pronouns：英文人称代词（结构化，driver of voice anchor 渲染）
-- 二者可独立 —— 一个 "feminine" 表达的角色完全可以用 they/them。

ALTER TABLE character_identity
  ADD COLUMN pronouns TEXT NOT NULL DEFAULT '';
