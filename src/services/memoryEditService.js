/**
 * memoryEditService — 记忆删除/修正
 *
 * 给两个调用方共用：
 *   1. 浏览器管理面板：DELETE /api/browse/conversation-turns/:id
 *   2. AI 工具调用：    POST   /api/tool/memory-correct
 *
 * 删除是**级联硬删**：
 *   conversation_turn → memory_item (源) → memory_facts → memory_edges → memory_vectors
 *                                       → outbox_events (memory_item.created)
 *   所有相关 FTS5 trigger 自动清理。
 *
 * 修正是**就地改 content**：
 *   memory_item.content 写入新值 + updated_at 推进 + vector_status 标 'pending' 触发重新 embed
 *   conversation_turn 不动（保留原始对话历史）
 *   facts/edges 不动（如果新内容语义变化，应当先 delete 老 fact / edge 再让分类器重跑）
 */

const { v7: uuidv7 } = require("uuid");
const { db } = require("../db");

/**
 * 级联删除 conversation_turn 及其下游所有衍生数据。
 *
 * @param {string} turnId
 * @returns {{ found: boolean, deleted: { turn: number, memoryItems: number, facts: number, edges: number, vectors: number, outboxEvents: number } }}
 */
function deleteConversationTurnCascade(turnId) {
  if (!turnId) return { found: false, deleted: zeroDeleted() };

  const turnRow = db
    .prepare("SELECT id, assistant_id FROM conversation_turns WHERE id = ?")
    .get(turnId);
  if (!turnRow) return { found: false, deleted: zeroDeleted() };

  // 找到由这个 turn 衍生的 memory_items
  const memoryRows = db
    .prepare("SELECT id FROM memory_items WHERE source_turn_id = ?")
    .all(turnId);
  const memoryIds = memoryRows.map((r) => r.id);

  return runDeleteTransaction({ turnIds: [turnId], memoryIds });
}

/**
 * 直接级联删除 memory_item（含其源 conversation_turn）
 * AI 工具大多基于 memoryId 操作，所以提供这条入口。
 *
 * @param {string} memoryId
 * @param {string} [assistantId] 可选，如果给了就强校验 memory_item 必须属于这个 assistant
 * @returns {{ found: boolean, deleted: ..., reason?: string }}
 */
function deleteMemoryItemCascade(memoryId, assistantId = null) {
  if (!memoryId) return { found: false, deleted: zeroDeleted(), reason: "missing_memoryId" };

  const memRow = db
    .prepare("SELECT id, assistant_id, source_turn_id FROM memory_items WHERE id = ?")
    .get(memoryId);
  if (!memRow) return { found: false, deleted: zeroDeleted(), reason: "memory_not_found" };
  if (assistantId && memRow.assistant_id !== assistantId) {
    return { found: false, deleted: zeroDeleted(), reason: "assistant_mismatch" };
  }

  // 同时删 conversation_turn 让历史也消失（如果还在）。
  // 如果你只想删 memory 但保留原始对话，应该用 update 而非 delete。
  const turnIds = memRow.source_turn_id ? [memRow.source_turn_id] : [];
  return runDeleteTransaction({ turnIds, memoryIds: [memoryId] });
}

/**
 * 修正 memory_item content，触发重新 embed。
 *
 * 不删 conversation_turn（保留原始对话历史不可篡改），
 * 也不删 facts/edges（让 backfill cron 重新分类）。
 *
 * @param {string} memoryId
 * @param {string} newContent
 * @param {object} [opts]
 * @param {string} [opts.assistantId] 校验属主
 * @param {string} [opts.reason] 写进 memory_retrieval_log 的修正原因
 * @returns {{ found: boolean, updated: boolean, reason?: string }}
 */
function updateMemoryItemContent(memoryId, newContent, opts = {}) {
  if (!memoryId) return { found: false, updated: false, reason: "missing_memoryId" };
  if (typeof newContent !== "string" || newContent.trim().length === 0) {
    return { found: false, updated: false, reason: "empty_content" };
  }

  const memRow = db.prepare("SELECT id, assistant_id FROM memory_items WHERE id = ?").get(memoryId);
  if (!memRow) return { found: false, updated: false, reason: "memory_not_found" };
  if (opts.assistantId && memRow.assistant_id !== opts.assistantId) {
    return { found: false, updated: false, reason: "assistant_mismatch" };
  }

  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      `UPDATE memory_items
         SET content = ?,
             updated_at = ?,
             vector_status = 'pending',
             vector_updated_at = NULL
       WHERE id = ?`
    ).run(newContent, now, memoryId);

    // 触发 outbox 重新索引（embedding worker 会消费）
    db.prepare(
      `INSERT INTO outbox_events
         (id, event_type, aggregate_type, aggregate_id, dedupe_key, payload_json, status, created_at, updated_at)
       VALUES (?, 'memory_item.updated', 'memory_item', ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(dedupe_key) DO UPDATE SET
         status='pending',
         retry_count=0,
         next_retry_at=NULL,
         last_error=NULL,
         updated_at=excluded.updated_at`
    ).run(
      uuidv7(),
      memoryId,
      `memory-update:${memoryId}:${now}`,
      JSON.stringify({ memoryId, reason: opts.reason || null }),
      now,
      now
    );
  })();

  return { found: true, updated: true };
}

// ── internals ──────────────────────────────────────────────────────────────

function zeroDeleted() {
  return { turn: 0, memoryItems: 0, facts: 0, edges: 0, vectors: 0, outboxEvents: 0 };
}

function runDeleteTransaction({ turnIds = [], memoryIds = [] }) {
  const deleted = zeroDeleted();
  if (turnIds.length === 0 && memoryIds.length === 0) {
    return { found: false, deleted };
  }

  db.transaction(() => {
    if (memoryIds.length > 0) {
      const ph = memoryIds.map(() => "?").join(",");
      deleted.facts = db
        .prepare(`DELETE FROM memory_facts WHERE memory_item_id IN (${ph})`)
        .run(...memoryIds).changes;
      deleted.edges = db
        .prepare(
          `DELETE FROM memory_edges
            WHERE source_memory_id IN (${ph}) OR target_memory_id IN (${ph})`
        )
        .run(...memoryIds, ...memoryIds).changes;
      deleted.vectors = db
        .prepare(`DELETE FROM memory_vectors WHERE memory_item_id IN (${ph})`)
        .run(...memoryIds).changes;
      deleted.outboxEvents = db
        .prepare(
          `DELETE FROM outbox_events
             WHERE aggregate_type = 'memory_item' AND aggregate_id IN (${ph})`
        )
        .run(...memoryIds).changes;
      deleted.memoryItems = db
        .prepare(`DELETE FROM memory_items WHERE id IN (${ph})`)
        .run(...memoryIds).changes;
    }
    if (turnIds.length > 0) {
      const ph = turnIds.map(() => "?").join(",");
      deleted.turn = db
        .prepare(`DELETE FROM conversation_turns WHERE id IN (${ph})`)
        .run(...turnIds).changes;
    }
  })();

  return { found: true, deleted };
}

module.exports = {
  deleteConversationTurnCascade,
  deleteMemoryItemCascade,
  updateMemoryItemContent,
};
