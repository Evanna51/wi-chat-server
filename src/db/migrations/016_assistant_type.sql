-- Migration 016: assistant_profile 加 assistant_type 列
--
-- 与 chatbox-Android `MyAssistant.type` 对齐。当前观测到的取值：
--   "character"  人物型陪伴角色（锡金 / 金琉宵 等）— 显示自驱生活 / 主动消息开关
--   "writer"     写作助手（小说）                  — 隐藏自驱开关，flag 强制视为关
--   "default"    通用助手                          — 同 writer 处理
--   ""           尚未携带 type 的老数据             — 向后兼容，UI 沿用 character 行为
--
-- 业务上，listAutoLifeAssistantProfiles / listProactiveAssistantProfiles 不在 SQL 层过滤，
-- 由 UI 决定是否暴露开关；server 端调度仍尊重 allow_auto_life / allow_proactive_message 字段。
-- 这样保留 escape hatch：如果某天想给 writer 也开自驱，改 UI 即可，无需改 schema。

ALTER TABLE assistant_profile ADD COLUMN assistant_type TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_assistant_profile_type ON assistant_profile(assistant_type);
