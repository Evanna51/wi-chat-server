-- Migration 019: 给 memory_facts 加 importance 维度
--
-- 与 confidence 正交：
--   confidence = 这个 fact 提取得准不准（事实抽取质量）
--   importance = 对角色行为影响多大（"用户是糖尿病人" 比 "用户喜欢蓝色" 重要得多）
--
-- 取值 0-1，默认 0.5（存量数据 retrofit 用）；新写入由 LLM 抽取时打分或 add_fact API 显式传入。
-- 后续 bootstrap 的 coreFacts 排序按 (importance * 0.6 + confidence * 0.4) DESC，
-- 让"准且重要"的 fact 浮上来。

ALTER TABLE memory_facts ADD COLUMN importance REAL NOT NULL DEFAULT 0.5;

-- coreFacts 取数路径：按 assistant 过滤 + importance/confidence 综合分排序
CREATE INDEX IF NOT EXISTS idx_memory_facts_assistant_importance
  ON memory_facts(assistant_id, importance DESC, confidence DESC);
