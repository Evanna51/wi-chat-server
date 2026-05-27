/**
 * lifeBeatTickService — life-beat-tick cron（默认每 15min）
 *
 * 流程：
 *   1. listPendingLifeBeats({ now }) 拿到所有到点的 pending beat
 *   2. 对每条 beat：
 *      a. 落 memory_items —— autonomous → memory_type='life_event_autonomous'
 *                            anchored   → memory_type='life_event'
 *         （anchored beat 是角色"想到 ta"的瞬间，跟 catchup 时代的 life_event 同质，
 *          走默认 retrieval；autonomous 是角色独立时刻，retrieval 默认不召回避免污染。）
 *      b. markBeatActivated 把 beat → 'activated'
 *      c. 触发判断（仅 anchored + importance ≥ THRESHOLD）：
 *         - 聊天活跃中（最近 CHAT_ACTIVE_WINDOW_MS 内有 user/assistant turn）→ skip，等下轮 chat 自然引用
 *         - 24h 已触发 anchored beat ≥ SOFT_CAP → skip
 *         - 否则：scheduleNextPushPlan({ reason: 'life_event_seed', seed: {...} })
 *
 * 设计文档：docs/character-life-beat-plan.md
 *
 * 注：proactive seed prompt 注入（reason='life_event_seed' 实际生效）属于 Phase 2；
 * 当前 Phase 1 已经把 reason 透传过去，Phase 2 在 nextPush.js 里加 seed 段。
 */

const { v7: uuidv7 } = require("uuid");
const {
  db,
  listPendingLifeBeats,
  markBeatActivated,
  markBeatSkipped,
  countActivatedAnchoredBeatsSince,
  getAssistantProfile,
  insertMemoryItem,
  insertOutboxEvent,
  insertBehaviorJournalEntry,
} = require("../../db");
const config = require("../../config");

// ── 阈值（可通过 env 覆盖） ──────────────────────────────────────────

const ANCHORED_IMPORTANCE_THRESHOLD = 0.5;
const CHAT_ACTIVE_WINDOW_MS_DEFAULT = 10 * 60 * 1000;     // 最近 10min 有对话 → 视为活跃
const ANCHORED_24H_SOFT_CAP_DEFAULT = 4;                   // 24h anchored 触发上限

function getChatActiveWindowMs() {
  return Number(config.lifeBeatChatActiveWindowMs) || CHAT_ACTIVE_WINDOW_MS_DEFAULT;
}

function getAnchored24hSoftCap() {
  return Number(config.lifeBeatAnchored24hSoftCap) || ANCHORED_24H_SOFT_CAP_DEFAULT;
}

// ── 是否聊天活跃 ─────────────────────────────────────────────────────

function isChatActive(assistantId, now) {
  const windowMs = getChatActiveWindowMs();
  const since = now - windowMs;
  const row = db
    .prepare(
      `SELECT 1 FROM conversation_turns
        WHERE assistant_id = ? AND created_at >= ?
        LIMIT 1`
    )
    .get(assistantId, since);
  return !!row;
}

// ── 单 beat 处理 ─────────────────────────────────────────────────────

async function processBeat(beat, { now = Date.now() } = {}) {
  const profile = getAssistantProfile(beat.assistant_id);
  if (!profile) {
    markBeatSkipped({ beatId: beat.id, activatedAt: now });
    return { beatId: beat.id, status: "skipped", reason: "no_profile" };
  }

  // 落 memory_item
  const memoryType = beat.beat_type === "anchored" ? "life_event" : "life_event_autonomous";
  const sourceTurnId = `auto-life-beat:${uuidv7()}`;
  // 用 beat.scheduled_at 作为 memory 的 event time —— 这是事件"发生时刻"
  const memoryId = insertMemoryItem({
    assistantId: beat.assistant_id,
    sessionId: profile.last_session_id || `persona:${beat.assistant_id}`,
    sourceTurnId,
    content: beat.activity,
    memoryType,
    salience: 0.5 + (Number(beat.importance) || 0) * 0.3, // 0.5 ~ 0.8
    confidence: 0.7,
    createdAt: beat.scheduled_at,
  });

  // 让 outbox 把这条 memory 入向量索引
  try {
    insertOutboxEvent({
      eventType: "memory_item.created",
      aggregateType: "memory_item",
      aggregateId: memoryId,
      dedupeKey: `memory-index:${memoryId}`,
      payload: { memoryId },
    });
  } catch (e) {
    // outbox 写失败不影响主流程
  }

  markBeatActivated({ beatId: beat.id, memoryItemId: memoryId, activatedAt: now });

  // 决定要不要触发 proactive
  let proactiveOutcome = { triggered: false, reason: "" };
  if (beat.beat_type === "anchored" && (Number(beat.importance) || 0) >= ANCHORED_IMPORTANCE_THRESHOLD) {
    if (profile.allow_proactive_message !== 1) {
      proactiveOutcome = { triggered: false, reason: "proactive_disabled" };
    } else if (isChatActive(beat.assistant_id, now)) {
      proactiveOutcome = { triggered: false, reason: "chat_active" };
    } else {
      const recent = countActivatedAnchoredBeatsSince({
        assistantId: beat.assistant_id,
        sinceMs: now - 24 * 60 * 60 * 1000,
      });
      if (recent > getAnchored24hSoftCap()) {
        proactiveOutcome = { triggered: false, reason: "24h_soft_cap" };
      } else {
        try {
          // 懒加载避免循环依赖（proactive → character → proactive 闭环）
          const { scheduleNextPushPlan } = require("../proactive");
          const r = await scheduleNextPushPlan({
            assistantId: beat.assistant_id,
            now,
            reason: "life_event_seed",
            // Phase 2: seed 参数将在 nextPush.js 加 seed 处理后真正生效
            seed: {
              activity: beat.activity,
              reachSeed: beat.reach_seed || "",
              importance: beat.importance,
              beatScheduledAt: beat.scheduled_at,
            },
          });
          proactiveOutcome = { triggered: !!r?.ok, reason: r?.skipped || r?.reason || (r?.ok ? "scheduled" : "unknown") };
        } catch (err) {
          proactiveOutcome = { triggered: false, reason: `schedule_failed:${err.message}` };
        }
      }
    }
  } else {
    proactiveOutcome = {
      triggered: false,
      reason: beat.beat_type === "anchored" ? "importance_below_threshold" : "autonomous_no_trigger",
    };
  }

  return {
    beatId: beat.id,
    assistantId: beat.assistant_id,
    status: "activated",
    memoryItemId: memoryId,
    beatType: beat.beat_type,
    importance: beat.importance,
    proactive: proactiveOutcome,
  };
}

// ── cron tick ────────────────────────────────────────────────────────

/**
 * 每 15min 跑一次（cron `*\/15 * * * *`）。
 *
 * 失败处理：单条 beat 抛错只影响这一条，其他继续；最后一并写 behavior_journal。
 * 不重试 —— 错过这次 tick，下次 (`scheduled_at <= now` 仍然真) 还会被扫到。
 */
async function runLifeBeatTickOnce({ now = Date.now(), limit = 50 } = {}) {
  const due = listPendingLifeBeats({ now, limit });
  if (!due.length) {
    return { scanned: 0, activated: 0, proactiveTriggered: 0, results: [] };
  }

  const summary = {
    scanned: due.length,
    activated: 0,
    proactiveTriggered: 0,
    errors: 0,
    results: [],
  };
  // 按 assistant 串行写 behavior_journal 时不会冲突，processBeat 之间相互独立可直接 for-await
  for (const beat of due) {
    try {
      const r = await processBeat(beat, { now });
      if (r.status === "activated") summary.activated += 1;
      if (r.proactive?.triggered) summary.proactiveTriggered += 1;
      summary.results.push(r);
    } catch (err) {
      summary.errors += 1;
      // 不 mark skipped 避免下次 tick 再扫 —— 标 skipped 防死循环
      try {
        markBeatSkipped({ beatId: beat.id, activatedAt: now });
      } catch {}
      summary.results.push({
        beatId: beat.id,
        assistantId: beat.assistant_id,
        status: "error",
        error: err.message,
      });
    }
  }

  // 写一条聚合 behavior_journal（按 assistant 拆开太碎了，每次 tick 一条总览）
  try {
    insertBehaviorJournalEntry({
      runType: "life_beat_tick",
      assistantId: "_system",
      sessionId: null,
      shouldPersist: true,
      status: summary.errors ? "partial_error" : "ok",
      reason: "tick_done",
      input: { now, dueCount: due.length, limit },
      result: {
        activated: summary.activated,
        proactiveTriggered: summary.proactiveTriggered,
        errors: summary.errors,
      },
      createdAt: now,
    });
  } catch {}

  return summary;
}

module.exports = {
  runLifeBeatTickOnce,
  // 暴露给测试
  processBeat,
  isChatActive,
};
