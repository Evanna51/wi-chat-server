/**
 * 监听 'turn.user.batch'：异步排下一条 next_push plan。
 *
 * scheduleNextPushPlan 内部会调 LLM（5-10s），必须 setImmediate 不阻塞 emit 调用方。
 * 同 assistant 短时间内多次触发由 scheduleNextPushPlan 内部
 * cancelExistingNextPushPlans + T-15 限流闸门兜底。
 */
const {
  scheduleNextPushPlan,
} = require("../services/proactivePlanService");

function register(turnEvents) {
  turnEvents.on("turn.user.batch", ({ assistantId, userId }) => {
    setImmediate(() => {
      scheduleNextPushPlan({ assistantId, userId }).catch((e) => {
        console.error("[subscriber:scheduleNextPush]", assistantId, e.message);
      });
    });
  });
}

module.exports = { register };
