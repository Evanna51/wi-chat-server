/**
 * proactive 模块入口 —— 重新导出原 src/services/proactivePlanService.js 的所有公开 API。
 *
 * 拆分自原 proactivePlanService.js（2026-05-23）。模块层次：
 *
 *   shared.js     工具 / LLM 调用 / 跨模块常量（无内部依赖）
 *     ↑
 *   store.js      DB prepared statements（依赖 db.js 和 shared 的常量）
 *     ↑
 *   longTerm.js   inactive_7d / daily_greeting + generatePlans
 *   nextPush.js   72h 滚动事件驱动 + scheduleNextPushPlan
 *     ↑
 *   watchdog.js   周期性给 AI 重新决定的机会
 *
 * 改一处时只需要看一文件。watchdog/nextPush 死循环那种跨函数交互的坑，
 * 都在 nextPush.js 顶部和函数注释里写清了。
 */

const {
  NEXT_PUSH_TRIGGER_REASON,
  NEXT_PUSH_FRESHNESS_WINDOW_MS,
} = require("./shared");
const {
  getRecentDraftsForAssistant,
  listPendingPlans,
  listPlansByStatus,
  findPlanById,
  fetchDuePendingPlans,
  cancelPendingPlansForAssistant,
  cancelExistingNextPushPlans,
  cancelPlanById,
  markPlanSent,
} = require("./store");
const { generatePlans } = require("./longTerm");
const { scheduleNextPushPlan } = require("./nextPush");
const { runProactiveWatchdogOnce, WATCHDOG_INTERVAL_MS } = require("./watchdog");

module.exports = {
  // 主入口
  generatePlans,
  scheduleNextPushPlan,
  runProactiveWatchdogOnce,
  // plan-executor / route 用到的 DB helpers
  fetchDuePendingPlans,
  markPlanSent,
  cancelPlanById,
  findPlanById,
  listPendingPlans,
  listPlansByStatus,
  getRecentDraftsForAssistant,
  // subscribers 用到
  cancelPendingPlansForAssistant,
  cancelExistingNextPushPlans,
  // 常量
  NEXT_PUSH_TRIGGER_REASON,
  NEXT_PUSH_FRESHNESS_WINDOW_MS,
  WATCHDOG_INTERVAL_MS,
};
