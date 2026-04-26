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

function ingestInteraction({
  db,
  assistantId,
  sessionId,
  role,
  content,
  now,
  insertConversationTurn,
  insertMemoryItem,
  insertOutboxEvent,
}) {
  const turnId = insertConversationTurn({ assistantId, sessionId, role, content, createdAt: now });
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

  return { turnId, memoryId, factCount: facts.length };
}

module.exports = { ingestInteraction };
