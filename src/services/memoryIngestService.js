const { v7: uuidv7 } = require("uuid");

function extractFacts(content = "") {
  const text = content.trim();
  if (!text) return [];
  const facts = [];
  const likesMatch = text.match(/喜欢([^，。！？\n]+)/);
  if (likesMatch) {
    facts.push({ key: "preference_like", value: likesMatch[1].trim(), confidence: 0.75 });
  }
  const dislikesMatch = text.match(/不喜欢([^，。！？\n]+)/);
  if (dislikesMatch) {
    facts.push({ key: "preference_dislike", value: dislikesMatch[1].trim(), confidence: 0.75 });
  }
  return facts;
}

function estimateSalience(role, content) {
  const lengthBoost = Math.min(0.3, (content.length || 0) / 400);
  const roleBoost = role === "user" ? 0.2 : 0.05;
  return Math.max(0.1, Math.min(1, 0.4 + roleBoost + lengthBoost));
}

/**
 * 幂等地把一条 interaction 写入 conversation_turns + memory_items + facts + edges + outbox。
 *
 * 幂等策略（应用层 SELECT-then-INSERT）：
 * - conversation_turns 由 db.js 的 INSERT OR IGNORE 兜底（PK 命中即 noop）。
 * - memory_items 在写入前 SELECT findMemoryItemBySourceTurnId(turnId)；命中则整个 ingest 跳过。
 * - facts / edges / outbox 与 memory_item 一对一，memoryItem 跳过则它们也跳过，
 *   不会出现重复 fact / 重复 outbox event。
 *
 * 调用方可选传 `turnId`，传了就以它作为 conversation_turns 的 PK；不传由 server 端生成。
 */
function ingestInteraction({
  db,
  assistantId,
  sessionId,
  role,
  content,
  now,
  turnId: providedTurnId,
  insertConversationTurn,
  insertMemoryItem,
  insertOutboxEvent,
  findMemoryItemBySourceTurnId,
}) {
  const turnId = insertConversationTurn({
    id: providedTurnId,
    assistantId,
    sessionId,
    role,
    content,
    createdAt: now,
  });

  // 幂等检查：同一 source_turn_id 已有 memory_item 直接 short-circuit
  const findFn = findMemoryItemBySourceTurnId;
  if (typeof findFn === "function") {
    const existing = findFn(turnId);
    if (existing && existing.id) {
      return {
        turnId,
        memoryId: existing.id,
        factCount: 0,
        skipped: true,
      };
    }
  }

  const memoryId = insertMemoryItem({
    assistantId,
    sessionId,
    sourceTurnId: turnId,
    content,
    memoryType: role === "user" ? "user_turn" : "assistant_turn",
    salience: estimateSalience(role, content),
    confidence: role === "user" ? 0.8 : 0.6,
  });

  const facts = extractFacts(content);
  const insertFactStmt = db.prepare(
    `INSERT INTO memory_facts
      (id, assistant_id, session_id, memory_item_id, fact_key, fact_value, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const fact of facts) {
    insertFactStmt.run(
      uuidv7(),
      assistantId,
      sessionId,
      memoryId,
      fact.key,
      fact.value,
      fact.confidence,
      now
    );
  }

  const previous = db
    .prepare(
      `SELECT id FROM memory_items
       WHERE assistant_id = ? AND session_id = ? AND id != ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(assistantId, sessionId, memoryId);
  if (previous?.id) {
    db.prepare(
      `INSERT INTO memory_edges
        (id, assistant_id, source_memory_id, target_memory_id, relation_type, weight, created_at)
       VALUES (?, ?, ?, ?, 'temporal_next', ?, ?)`
    ).run(uuidv7(), assistantId, previous.id, memoryId, 0.8, now);
  }

  const dedupeKey = `memory-index:${memoryId}`;
  insertOutboxEvent({
    eventType: "memory_item.created",
    aggregateType: "memory_item",
    aggregateId: memoryId,
    dedupeKey,
    payload: { memoryId },
  });

  return { turnId, memoryId, factCount: facts.length, skipped: false };
}

module.exports = { ingestInteraction };
