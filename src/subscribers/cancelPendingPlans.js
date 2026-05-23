/**
 * 监听 'turn.user.batch'：取消 long-term trigger 的 pending plan。
 *
 * 用户主动发消息说明他在线 / 在意，长期 plan（inactive_7d / daily_greeting 等）
 * 应当让位，由 next_push 接手。next_push 自己的 pending 由 scheduleNextPushPlan
 * 内部 cancelExistingNextPushPlans 处理，这里**只**清长期 trigger 的。
 */
const {
  cancelPendingPlansForAssistant,
} = require("../services/proactive");

function register(turnEvents) {
  turnEvents.on("turn.user.batch", ({ assistantId }) => {
    try {
      cancelPendingPlansForAssistant(assistantId, "user_active");
    } catch (e) {
      console.error("[subscriber:cancelPendingPlans]", assistantId, e.message);
    }
  });
}

module.exports = { register };
