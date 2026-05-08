/**
 * memoryEditService — 记忆删除/修正/事实级编辑
 *
 * 给三个调用方共用：
 *   1. 浏览器管理面板：DELETE /api/browse/conversation-turns/:id
 *   2. AI 工具调用：    POST   /api/tool/memory-correct
 *   3. 后续 admin/eval 脚本调用 service 函数
 *
 * 提供：
 *   - 单条 / 批量级联删除 (memory_item / conversation_turn)
 *   - content 修正 + 触发重 embed
 *   - quality 重新打分（标低让它不再被检索）
 *   - fact 级 add / remove
 *   - 所有变更写入 memory_audit_log（PR-11）
 */

const { v7: uuidv7 } = require("uuid");
const { db } = require("../db");

// 审计日志：动作类型常量。新动作往这里加即可，无需改 schema。
const AUDIT_ACTIONS = {
  DELETE_TURN: "delete_turn",
  DELETE_MEMORY: "delete_memory",
  UPDATE_CONTENT: "update_content",
  SET_QUALITY: "set_quality",
  ADD_FACT: "add_fact",
  REMOVE_FACT: "remove_fact",
  PIN: "pin",
  UNPIN: "unpin",
};

const VALID_QUALITY_GRADES = new Set(["A", "B", "C", "D", "E"]);

/**
 * 写一条审计日志。表 memory_audit_log 在 migration 017 创建。
 */
function recordAudit({ assistantId, memoryId = null, turnId = null, action, actor = "ai", reason = null, payload = null }) {
  try {
    db.prepare(
      `INSERT INTO memory_audit_log
         (id, assistant_id, memory_item_id, turn_id, action, actor, reason, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuidv7(),
      assistantId || "",
      memoryId,
      turnId,
      action,
      actor,
      reason,
      payload ? JSON.stringify(payload) : null,
      Date.now()
    );
  } catch {
    // 审计失败不阻塞主流程
  }
}

/**
 * 级联删除 conversation_turn 及其下游所有衍生数据。
 *
 * @param {string} turnId
 * @returns {{ found: boolean, deleted: { turn: number, memoryItems: number, facts: number, edges: number, vectors: number, outboxEvents: number } }}
 */
function deleteConversationTurnCascade(turnId, opts = {}) {
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

  const result = runDeleteTransaction({ turnIds: [turnId], memoryIds });
  if (result.found) {
    recordAudit({
      assistantId: turnRow.assistant_id,
      turnId,
      memoryId: memoryIds[0] || null,
      action: AUDIT_ACTIONS.DELETE_TURN,
      actor: opts.actor || "user",
      reason: opts.reason || null,
      payload: { deleted: result.deleted, cascadedMemoryIds: memoryIds },
    });
  }
  return result;
}

/**
 * 直接级联删除 memory_item（含其源 conversation_turn）
 * AI 工具大多基于 memoryId 操作，所以提供这条入口。
 *
 * @param {string} memoryId
 * @param {string} [assistantId] 可选，如果给了就强校验 memory_item 必须属于这个 assistant
 * @returns {{ found: boolean, deleted: ..., reason?: string }}
 */
function deleteMemoryItemCascade(memoryId, assistantId = null, opts = {}) {
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
  const result = runDeleteTransaction({ turnIds, memoryIds: [memoryId] });
  if (result.found) {
    recordAudit({
      assistantId: memRow.assistant_id,
      memoryId,
      turnId: memRow.source_turn_id,
      action: AUDIT_ACTIONS.DELETE_MEMORY,
      actor: opts.actor || "ai",
      reason: opts.reason || null,
      payload: { deleted: result.deleted },
    });
  }
  return result;
}

/**
 * 批量删除一组 memory_items（含级联）。
 * 返回每个 id 的结果摘要 + 总计。AI 一次扫到一批垃圾时调用。
 */
function deleteMemoryItemsBatch(memoryIds, assistantId, opts = {}) {
  if (!Array.isArray(memoryIds) || memoryIds.length === 0) {
    return { totalDeleted: 0, details: [] };
  }
  const details = [];
  let totalDeleted = 0;
  for (const id of memoryIds) {
    const r = deleteMemoryItemCascade(id, assistantId, opts);
    if (r.found) totalDeleted += 1;
    details.push({ memoryId: id, found: r.found, reason: r.reason || null });
  }
  return { totalDeleted, details };
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

  const memRow = db.prepare("SELECT id, assistant_id, content FROM memory_items WHERE id = ?").get(memoryId);
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

  recordAudit({
    assistantId: memRow.assistant_id,
    memoryId,
    action: AUDIT_ACTIONS.UPDATE_CONTENT,
    actor: opts.actor || "ai",
    reason: opts.reason || null,
    payload: { oldContent: memRow.content, newContent },
  });

  return { found: true, updated: true };
}

/**
 * 重新打 quality 等级。AI 评估某条记忆为低价值时调用，标低后会被 minQuality 过滤掉
 * 但保留 row（用于审计）。
 */
function setMemoryQuality(memoryId, grade, opts = {}) {
  if (!memoryId) return { found: false, updated: false, reason: "missing_memoryId" };
  if (!VALID_QUALITY_GRADES.has(grade)) {
    return { found: false, updated: false, reason: "invalid_grade" };
  }

  const memRow = db.prepare("SELECT id, assistant_id, quality_grade FROM memory_items WHERE id = ?").get(memoryId);
  if (!memRow) return { found: false, updated: false, reason: "memory_not_found" };
  if (opts.assistantId && memRow.assistant_id !== opts.assistantId) {
    return { found: false, updated: false, reason: "assistant_mismatch" };
  }

  db.prepare(
    `UPDATE memory_items SET quality_grade = ?, category_method = 'manual', updated_at = ? WHERE id = ?`
  ).run(grade, Date.now(), memoryId);

  recordAudit({
    assistantId: memRow.assistant_id,
    memoryId,
    action: AUDIT_ACTIONS.SET_QUALITY,
    actor: opts.actor || "ai",
    reason: opts.reason || null,
    payload: { oldGrade: memRow.quality_grade, newGrade: grade },
  });

  return { found: true, updated: true, oldGrade: memRow.quality_grade, newGrade: grade };
}

/**
 * 给一条 memory 加 fact。如果 (memory_id, fact_key) 已存在，按 confidence 决定覆盖/丢弃。
 *
 * importance（0-1，默认 0.5）= 这个 fact 对角色行为影响多大，与 confidence 正交。
 * 健康/重大身份建议 0.9+；偏好/兴趣 0.3-0.5。bootstrap 的 coreFacts 按其综合分排序。
 */
function addFact({ memoryId, factKey, factValue, confidence = 0.8, importance = 0.5, opts = {} }) {
  if (!memoryId || !factKey || !factValue) {
    return { added: false, reason: "missing_required_field" };
  }
  const memRow = db.prepare("SELECT id, assistant_id, session_id, created_at FROM memory_items WHERE id = ?").get(memoryId);
  if (!memRow) return { added: false, reason: "memory_not_found" };
  if (opts.assistantId && memRow.assistant_id !== opts.assistantId) {
    return { added: false, reason: "assistant_mismatch" };
  }

  const existing = db
    .prepare("SELECT id, confidence FROM memory_facts WHERE memory_item_id = ? AND fact_key = ?")
    .get(memoryId, factKey);
  if (existing && existing.confidence >= confidence) {
    return { added: false, reason: "existing_higher_confidence" };
  }

  const clampedImportance = Math.max(0, Math.min(1, importance));
  const eventTime = memRow.created_at || Date.now();

  db.transaction(() => {
    if (existing) {
      db.prepare("DELETE FROM memory_facts WHERE id = ?").run(existing.id);
    }
    db.prepare(
      `INSERT INTO memory_facts
         (id, assistant_id, session_id, memory_item_id, fact_key, fact_value, confidence, importance, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuidv7(),
      memRow.assistant_id,
      memRow.session_id || "",
      memoryId,
      factKey,
      factValue,
      confidence,
      clampedImportance,
      eventTime
    );
  })();

  recordAudit({
    assistantId: memRow.assistant_id,
    memoryId,
    action: AUDIT_ACTIONS.ADD_FACT,
    actor: opts.actor || "ai",
    reason: opts.reason || null,
    payload: { factKey, factValue, confidence, importance: clampedImportance, replacedExisting: !!existing },
  });

  return { added: true, replacedExisting: !!existing };
}

/**
 * 删 memory 下的某个 fact_key（或全删）。
 *   - factKey 给定 → 只删该 key
 *   - factKey 省略 → 删该 memory 下所有 facts
 */
function removeFact({ memoryId, factKey = null, opts = {} }) {
  if (!memoryId) return { removed: 0, reason: "missing_memoryId" };
  const memRow = db.prepare("SELECT assistant_id FROM memory_items WHERE id = ?").get(memoryId);
  if (!memRow) return { removed: 0, reason: "memory_not_found" };
  if (opts.assistantId && memRow.assistant_id !== opts.assistantId) {
    return { removed: 0, reason: "assistant_mismatch" };
  }

  let res;
  if (factKey) {
    res = db
      .prepare("DELETE FROM memory_facts WHERE memory_item_id = ? AND fact_key = ?")
      .run(memoryId, factKey);
  } else {
    res = db.prepare("DELETE FROM memory_facts WHERE memory_item_id = ?").run(memoryId);
  }

  if (res.changes > 0) {
    recordAudit({
      assistantId: memRow.assistant_id,
      memoryId,
      action: AUDIT_ACTIONS.REMOVE_FACT,
      actor: opts.actor || "ai",
      reason: opts.reason || null,
      payload: { factKey: factKey || "*", removed: res.changes },
    });
  }

  return { removed: res.changes };
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

/**
 * Pin / unpin 一条 memory（关键记忆开关）。
 * is_pinned=1 的记忆会被 memory-context 始终注入到 system prompt 作为"核心记忆"。
 * 不同于"高质量"或"高置信"——pin 是显式人工/AI 决策。
 */
function setMemoryPinned(memoryId, pinned, opts = {}) {
  if (!memoryId) return { found: false, reason: "missing_memoryId" };
  const memRow = db.prepare("SELECT id, assistant_id, is_pinned FROM memory_items WHERE id = ?").get(memoryId);
  if (!memRow) return { found: false, reason: "memory_not_found" };
  if (opts.assistantId && memRow.assistant_id !== opts.assistantId) {
    return { found: false, reason: "assistant_mismatch" };
  }
  const flag = pinned ? 1 : 0;
  if (memRow.is_pinned === flag) {
    return { found: true, changed: false, isPinned: !!flag };
  }
  const now = Date.now();
  db.prepare(
    `UPDATE memory_items SET is_pinned = ?, pinned_at = ?, updated_at = ? WHERE id = ?`
  ).run(flag, flag ? now : null, now, memoryId);

  recordAudit({
    assistantId: memRow.assistant_id,
    memoryId,
    action: pinned ? AUDIT_ACTIONS.PIN : AUDIT_ACTIONS.UNPIN,
    actor: opts.actor || "ai",
    reason: opts.reason || null,
    payload: { wasPinned: !!memRow.is_pinned, nowPinned: !!flag },
  });

  return { found: true, changed: true, isPinned: !!flag };
}

/**
 * 拉取本 assistant 的关键记忆（pinned=1）—— 给 memory-context 注入用。
 * 按 (salience DESC, pinned_at DESC) 排序，限 limit 条防 prompt 爆。
 */
function getCoreMemories(assistantId, { limit = 8 } = {}) {
  if (!assistantId) return [];
  const rows = db
    .prepare(
      `SELECT id, content, memory_type, memory_category, quality_grade,
              salience, created_at, pinned_at, kb_name
         FROM memory_items
        WHERE assistant_id = ? AND is_pinned = 1
        ORDER BY salience DESC, pinned_at DESC
        LIMIT ?`
    )
    .all(assistantId, limit);
  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    memoryType: r.memory_type,
    category: r.memory_category,
    quality: r.quality_grade,
    salience: r.salience,
    kbName: r.kb_name || null,
    createdAt: r.created_at,
    pinnedAt: r.pinned_at,
  }));
}

/**
 * 拉取本 assistant 的关键 facts（importance + confidence 综合分高的）—— 给 bootstrap 注入用。
 *
 * 综合分 = importance * 0.6 + confidence * 0.4
 *   importance 主导：让"对角色行为影响大"的 fact 浮上来
 *   confidence 收尾：同等重要时，提取得更准的优先
 *
 * minScore 默认 0.55：滤掉两者都偏低的 fact（importance=0.5 + confidence=0.6 的存量数据
 * 综合分 0.54，正好不进；新写入由 LLM 显式打分通常 > 0.55）。
 *
 * 同 fact_key 在不同 memory_item 上可能重复（例如多次提到偏好），按 key 去重保最高分。
 */
function getCoreFacts(assistantId, { limit = 15, minScore = 0.55 } = {}) {
  if (!assistantId) return [];
  const rows = db
    .prepare(
      `SELECT id, fact_key, fact_value, confidence, importance,
              memory_item_id, created_at,
              (importance * 0.6 + confidence * 0.4) AS composite_score
         FROM memory_facts
        WHERE assistant_id = ?
          AND (importance * 0.6 + confidence * 0.4) >= ?
        ORDER BY composite_score DESC, created_at DESC
        LIMIT ?`
    )
    .all(assistantId, minScore, limit * 3); // 多取 3x 留给 dedup

  const byKey = new Map();
  for (const r of rows) {
    const prev = byKey.get(r.fact_key);
    if (!prev || r.composite_score > prev.composite_score) {
      byKey.set(r.fact_key, r);
    }
  }
  const deduped = Array.from(byKey.values())
    .sort((a, b) => b.composite_score - a.composite_score)
    .slice(0, limit);

  return deduped.map((r) => ({
    id: r.id,
    factKey: r.fact_key,
    factValue: r.fact_value,
    confidence: r.confidence,
    importance: r.importance,
    score: Number(r.composite_score.toFixed(3)),
    memoryItemId: r.memory_item_id,
    createdAt: r.created_at,
  }));
}

module.exports = {
  deleteConversationTurnCascade,
  deleteMemoryItemCascade,
  deleteMemoryItemsBatch,
  updateMemoryItemContent,
  setMemoryQuality,
  addFact,
  removeFact,
  setMemoryPinned,
  getCoreMemories,
  getCoreFacts,
  AUDIT_ACTIONS,
};
