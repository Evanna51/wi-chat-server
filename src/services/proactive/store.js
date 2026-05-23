/**
 * proactive_plans 表的所有 prepared statements + 相关读写 helpers。
 *
 * 拆分自原 src/services/proactivePlanService.js（2026-05-23）。
 *
 * 这一层只依赖 db.js，不依赖 LLM / business logic，方便单测和复用。
 * 唯一的"业务边界"在 markPlanSent —— 它同事务 upsert character_state.last_proactive_at，
 * 因为那是 NEXT_PUSH_MIN_GAP_FROM_LAST_MS / WATCHDOG_MIN_GAP_FROM_PROACTIVE_MS 两道
 * gap 闸门生效的前提（改它的话两道闸门都失效，整个 proactive 节奏崩）。
 */

const { v7: uuidv7 } = require("uuid");
const { db } = require("../../db");
const { NEXT_PUSH_TRIGGER_REASON } = require("./shared");

// ── 查询 ─────────────────────────────────────────────────────────────

function findRecentPendingByTriggerWithin({ assistantId, triggerReason, now, withinMs }) {
  return db
    .prepare(
      `SELECT id, status, scheduled_at, created_at
       FROM proactive_plans
       WHERE assistant_id = ?
         AND trigger_reason = ?
         AND status = 'pending'
         AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(assistantId, triggerReason, now - withinMs);
}

function findUsedAnchorTopicWithin({ assistantId, anchorTopic, withinMs, now }) {
  if (!anchorTopic) return null;
  return db
    .prepare(
      `SELECT id, status, scheduled_at, anchor_topic
       FROM proactive_plans
       WHERE assistant_id = ?
         AND anchor_topic = ?
         AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(assistantId, anchorTopic, now - withinMs);
}

function getRecentDraftsForAssistant(assistantId, limit = 10) {
  return db
    .prepare(
      `SELECT id, trigger_reason, draft_body, anchor_topic, status, created_at
       FROM proactive_plans
       WHERE assistant_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(assistantId, limit);
}

function listPendingPlans({ assistantId } = {}) {
  if (assistantId) {
    return db
      .prepare(
        `SELECT * FROM proactive_plans
         WHERE assistant_id = ? AND status = 'pending'
         ORDER BY scheduled_at ASC`
      )
      .all(assistantId);
  }
  return db
    .prepare(
      `SELECT * FROM proactive_plans
       WHERE status = 'pending'
       ORDER BY scheduled_at ASC`
    )
    .all();
}

function listPlansByStatus({ assistantId, status }) {
  const rows = db
    .prepare(
      `SELECT * FROM proactive_plans
       WHERE ${assistantId ? "assistant_id = ? AND " : ""}status = ?
       ORDER BY scheduled_at ASC`
    )
    .all(...(assistantId ? [assistantId, status] : [status]));
  return rows;
}

function findPlanById(id) {
  return db.prepare("SELECT * FROM proactive_plans WHERE id = ?").get(id);
}

function fetchDuePendingPlans(now = Date.now()) {
  return db
    .prepare(
      `SELECT * FROM proactive_plans
       WHERE status = 'pending' AND scheduled_at <= ?
       ORDER BY scheduled_at ASC
       LIMIT 50`
    )
    .all(now);
}

function getLastProactiveAt(assistantId) {
  try {
    const row = db
      .prepare("SELECT last_proactive_at FROM character_state WHERE assistant_id = ?")
      .get(assistantId);
    return row?.last_proactive_at || null;
  } catch {
    return null;
  }
}

function countNextPushIn24h(assistantId, now) {
  const since = now - 24 * 60 * 60 * 1000;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM proactive_plans
        WHERE assistant_id = ?
          AND trigger_reason = ?
          AND status IN ('sent', 'pending')
          AND created_at >= ?`
    )
    .get(assistantId, NEXT_PUSH_TRIGGER_REASON, since);
  return row?.n || 0;
}

function getLastUserMessageAt(assistantId) {
  const row = db
    .prepare(
      `SELECT created_at FROM conversation_turns
        WHERE assistant_id = ? AND role = 'user'
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(assistantId);
  return row?.created_at || null;
}

// ── 写 ───────────────────────────────────────────────────────────────

function insertProactivePlan({
  assistantId,
  userId,
  triggerReason,
  intent,
  draftTitle,
  draftBody,
  anchorTopic,
  rationale,
  scheduledAt,
  now = Date.now(),
}) {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO proactive_plans
      (id, assistant_id, user_id, trigger_reason, intent, draft_title, draft_body, anchor_topic, rationale, scheduled_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    id,
    assistantId,
    userId,
    triggerReason,
    intent,
    draftTitle,
    draftBody,
    anchorTopic || null,
    rationale || null,
    scheduledAt,
    now,
    now
  );
  return id;
}

function cancelPendingPlansForAssistant(assistantId, reason = "user_active") {
  if (!assistantId) return 0;
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE proactive_plans
       SET status = 'cancelled', cancelled_reason = ?, updated_at = ?
       WHERE assistant_id = ? AND status = 'pending'`
    )
    .run(reason, now, assistantId);
  return result.changes || 0;
}

function cancelExistingNextPushPlans(assistantId, reason = "replaced_by_new_turn") {
  const now = Date.now();
  return db
    .prepare(
      `UPDATE proactive_plans
          SET status = 'cancelled', cancelled_reason = ?, updated_at = ?
        WHERE assistant_id = ?
          AND trigger_reason = ?
          AND status = 'pending'`
    )
    .run(reason, now, assistantId, NEXT_PUSH_TRIGGER_REASON).changes || 0;
}

function cancelPlanById(planId, reason = "manual") {
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE proactive_plans
       SET status = 'cancelled', cancelled_reason = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`
    )
    .run(reason, now, planId);
  return result.changes || 0;
}

/**
 * 标记 plan 已派发，并把 character_state.last_proactive_at 推到 now —— 让
 * scheduleNextPushPlan / runProactiveWatchdogOnce 里那俩 gap 闸门
 * （NEXT_PUSH_MIN_GAP_FROM_LAST_MS / WATCHDOG_MIN_GAP_FROM_PROACTIVE_MS）真正生效。
 *
 * 之前 last_proactive_at 字段没人写，闸门永远 falsy → option A 自递归循环没人拦
 * → 每 30~40min 重复推同一条 LLM 输出。
 *
 * 把两步包进 SQLite 事务：plan 没 marked sent（已 sent / cancelled）就不动 state。
 */
function markPlanSent(planId, now = Date.now()) {
  const tx = db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE proactive_plans
         SET status = 'sent', sent_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(now, now, planId);
    if (result.changes && result.changes > 0) {
      const row = db
        .prepare("SELECT assistant_id FROM proactive_plans WHERE id = ?")
        .get(planId);
      if (row?.assistant_id) {
        // 不强行 require characterStateService（避免循环依赖）；直接 SQL upsert。
        // character_state 表至少有 (assistant_id PK, last_proactive_at, updated_at,
        // created_at)，由 ensureDefaultState 初始化。如果还没初始化（理论上派 plan
        // 前已经 onUserMessage 过），fall back 用 INSERT OR IGNORE 兜一道。
        db.prepare(
          `INSERT INTO character_state (assistant_id, last_proactive_at, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(assistant_id) DO UPDATE SET
             last_proactive_at = excluded.last_proactive_at,
             updated_at = excluded.updated_at`
        ).run(row.assistant_id, now, now, now);
      }
    }
    return result.changes || 0;
  });
  return tx();
}

module.exports = {
  // 读
  findRecentPendingByTriggerWithin,
  findUsedAnchorTopicWithin,
  getRecentDraftsForAssistant,
  listPendingPlans,
  listPlansByStatus,
  findPlanById,
  fetchDuePendingPlans,
  getLastProactiveAt,
  countNextPushIn24h,
  getLastUserMessageAt,
  // 写
  insertProactivePlan,
  cancelPendingPlansForAssistant,
  cancelExistingNextPushPlans,
  cancelPlanById,
  markPlanSent,
};
