/**
 * Proactive Watchdog
 *
 * 拆分自原 src/services/proactivePlanService.js（2026-05-23）。
 *
 * 2026-05-10: 解决"AI 一次 ai_chose_skip → 整个 next_push 链断了"死链问题。
 * 之前只有用户发消息或 plan 派发后才 schedule —— 如果 AI 说 skip 后用户也没动作，
 * 就再也不会有触发点。watchdog 周期性扫所有 active assistant，超过阈值就重新调
 * scheduleNextPushPlan 给 AI 重新判断的机会（AI 可能因为 attention/intent 变化而改变决定）。
 *
 * 触发条件（通用）：
 *   - profile.allow_proactive_message=1
 *   - 离上次用户消息 30min ~ 72h（30min 内别打扰，72h 外让 long-term trigger 接管）
 *   - 离上次主动消息 ≥ 1h（用户说的"超过 1 小时就问一下"）
 *
 * 触发条件（life event 加速）：
 *   - 最近 1h 内有 life_event / work_event 写入（可能是用户刚分享了重要事件）
 *   - 此时 sinceLastProactive 阈值放宽到 30min（更积极反应）
 *
 * 注意：watchdog 调 scheduleNextPushPlan 时必须传 reason='watchdog'，否则
 * scheduleNextPushPlan 内部会 cancel 还没派发的 pending plan → 死循环。
 */

const { db, getRecentMemoryItems } = require("../../db");
const { NEXT_PUSH_FRESHNESS_WINDOW_MS } = require("./shared");
const { getLastProactiveAt, getLastUserMessageAt } = require("./store");
const { scheduleNextPushPlan } = require("./nextPush");

const WATCHDOG_INTERVAL_MS = 30 * 60 * 1000;          // cron 30 min
const WATCHDOG_MIN_GAP_FROM_PROACTIVE_MS = 60 * 60 * 1000;  // 默认 1h
const WATCHDOG_LIFE_EVENT_FAST_GAP_MS = 30 * 60 * 1000;     // 有新 life event 时 30min
const WATCHDOG_LIFE_EVENT_FRESHNESS_MS = 60 * 60 * 1000;    // life event 1h 内算"新鲜"
const WATCHDOG_MIN_GAP_FROM_USER_MS = 30 * 60 * 1000;       // 离用户消息 < 30min 别打扰

function _hasFreshLifeEvent(assistantId, now) {
  try {
    const events = getRecentMemoryItems({
      assistantId,
      memoryTypes: ["life_event", "work_event"],
      limit: 3,
    });
    return events.some((e) => {
      const ts = e.created_at || e.createdAt || 0;
      return ts && now - ts < WATCHDOG_LIFE_EVENT_FRESHNESS_MS;
    });
  } catch {
    return false;
  }
}

/**
 * 跑一次 watchdog 扫描。返回 { scanned, triggered, skipped: {...}, results: [...] }。
 * 内部调用 scheduleNextPushPlan，scheduleNextPushPlan 自己会做 LLM 决策（也可能再 skip）。
 *
 * 暴露给 scheduler 跑 cron，也可独立 invoke 做 debug。
 */
async function runProactiveWatchdogOnce({ now = Date.now() } = {}) {
  const profiles = db
    .prepare("SELECT assistant_id FROM assistant_profile WHERE allow_proactive_message = 1")
    .all();

  const summary = {
    scanned: 0,
    triggered: 0,
    skipped: {},
    results: [],
  };
  const incSkip = (k) => { summary.skipped[k] = (summary.skipped[k] || 0) + 1; };

  for (const { assistant_id: assistantId } of profiles) {
    summary.scanned++;

    const lastUserAt = getLastUserMessageAt(assistantId);
    if (!lastUserAt) { incSkip("no_user_history"); continue; }

    const sinceLastUser = now - lastUserAt;
    if (sinceLastUser > NEXT_PUSH_FRESHNESS_WINDOW_MS) { incSkip("past_72h"); continue; }
    if (sinceLastUser < WATCHDOG_MIN_GAP_FROM_USER_MS) { incSkip("user_too_recent"); continue; }

    const lastProactiveAt = getLastProactiveAt(assistantId);
    const sinceLastProactive = lastProactiveAt ? now - lastProactiveAt : Infinity;

    const hasLifeEvent = _hasFreshLifeEvent(assistantId, now);
    const minGap = hasLifeEvent ? WATCHDOG_LIFE_EVENT_FAST_GAP_MS : WATCHDOG_MIN_GAP_FROM_PROACTIVE_MS;

    if (sinceLastProactive < minGap) {
      incSkip(hasLifeEvent ? "fast_gap_not_yet" : "min_gap_not_yet");
      continue;
    }

    // 调 scheduleNextPushPlan — 它内部还会做更多 gate（24h cap / intent='none' / LLM skip）
    // reason='watchdog'：若已有 pending plan 在排队，跳过；避免 watchdog 自己 cancel 自己刚生成的 plan
    try {
      const result = await scheduleNextPushPlan({ assistantId, now, reason: "watchdog" });
      summary.triggered++;
      summary.results.push({
        assistantId,
        triggeredBy: hasLifeEvent ? "life_event" : "regular",
        sinceLastProactive: Number.isFinite(sinceLastProactive)
          ? Math.round(sinceLastProactive / (60 * 1000)) + "min"
          : "never",
        ...result,
      });
    } catch (e) {
      summary.results.push({ assistantId, error: e.message });
    }
  }

  return summary;
}

module.exports = {
  runProactiveWatchdogOnce,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_MIN_GAP_FROM_PROACTIVE_MS,
};
