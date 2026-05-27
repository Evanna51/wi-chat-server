const { v7: uuidv7 } = require("uuid");

/**
 * 携带用户对话语义、空 content 应被拒收的 role 集合。
 *
 * 注：进 memory pipeline 的只有 'user' 一种 —— assistant 的回复经过 T-08 后
 * 不再写 memory_items（仅留在 conversation_turns）。
 *
 * 'tool_call' / 'tool_result' / 'system' 是日志型 role，本来就只写 conversation_turns。
 */
const SEMANTIC_ROLES = new Set(["user", "assistant"]);

/** 真正进入 memory_items + facts + edges + 向量索引 + 分类管线的 role。 */
const MEMORY_ROLES = new Set(["user"]);

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
  toolCallsJson = null,
  toolCallId = null,
  toolName = null,
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
    toolCallsJson,
    toolCallId,
    toolName,
  });

  // 非 user role（assistant / tool_call / tool_result / system）：只写 conversation_turns，
  // 不进 memory pipeline、不分类、不索引、不出 outbox。
  // T-08 之前 assistant role 也写 memory_items，实测 0 facts、被排除出检索池，纯垃圾行。
  if (!MEMORY_ROLES.has(role)) {
    return { turnId, memoryId: null, factCount: 0, skipped: false, logOnly: true };
  }

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
    memoryType: "user_turn",
    salience: estimateSalience(role, content),
    confidence: 0.8,
    createdAt: now, // 用 turn 真实发生时间，不要用 server ingest 时间
  });

  // memory_facts 当前不再由 ingest 路径写入。旧 regex 抽取（"喜欢/讨厌/..."）
  // 在 2026-05-06 移除（产 garbage facts），LLM 抽取后续在 KG Phase B 上线，
  // 走独立 worker 写 kg_relations。这里只留 memoryId 供下游 fact-write 用。

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

module.exports = { ingestInteraction, SEMANTIC_ROLES, MEMORY_ROLES };
