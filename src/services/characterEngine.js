/**
 * characterEngine — 只保留 quiet hours 解析 / 判断两个工具函数。
 *
 * 其余历史 API（getTimeBucket / shouldTriggerProactive /
 * shouldAllowAutonomousMessage / buildProactivePrompt）已在 2026-05-16
 * 清理 —— 决策路径迁到 scheduleNextPushPlan gate 闸门 +
 * relationship_level / intimacy_score / relationshipDynamics。
 */

function parseQuietHours(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return [];
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((segment) => {
      const [start, end] = segment.split("-").map((v) => Number(v));
      if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
      if (start < 0 || start > 23 || end < 0 || end > 23) return null;
      return { start, end };
    })
    .filter(Boolean);
}

function isInQuietHours(date = new Date(), quietHours = []) {
  const hour = date.getHours();
  return quietHours.some(({ start, end }) => {
    if (start === end) return true;
    if (start < end) return hour >= start && hour < end;
    return hour >= start || hour < end;
  });
}

module.exports = {
  parseQuietHours,
  isInQuietHours,
};
