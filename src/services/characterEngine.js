/**
 * characterEngine — 只保留 quiet hours 解析 / 判断两个工具函数。
 *
 * 历史包袱已清（2026-05-16）：
 *   - getTimeBucket            未被调用（proactivePlanService 自己实现了 _timeBucket）
 *   - shouldTriggerProactive   未被调用（被 scheduleNextPushPlan 的 gate 闸门取代）
 *   - shouldAllowAutonomousMessage 未被调用（同上）
 *   - buildProactivePrompt     未被调用 + 内部按 familiarity 阈值切换语气是
 *                              废弃逻辑（现行 prompt 走 relationship_level /
 *                              intimacy_score / relationshipDynamics）
 *
 * familiarity 字段本身仍由 characterStateUpdater 写入、由 /api/browse 暴露给
 * 客户端展示；T-03 CR-02 客户端发版完成后可一并删除。
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
