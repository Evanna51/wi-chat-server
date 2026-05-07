/**
 * knowledgeService — 知识库（memory_type='knowledge'）的 CRUD
 *
 * 设计：复用 memory_items 表，用 memory_type='knowledge' + kb_name + kb_tags_json
 * 区分知识库条目和对话型 memory。这样 memory-recall 加 source='knowledge' 就能搜，
 * 不需要重建索引基础设施。
 *
 * 跟 episodic memory 的差异：
 *   - source_turn_id 用占位 'knowledge:<kb>:<id>'（SQLite NOT NULL 约束需要）
 *   - recency 评分给 'knowledge' 类型设半衰期 = ∞（认为知识不衰减）
 *   - confidence 默认 1.0（用户主动写的视为权威）
 *   - quality_grade 默认 'A'
 *   - 不写 memory_facts（知识本身就是结构化）
 *   - 仍走 outbox 触发 embedding（让它能被向量检索）
 */

const { v7: uuidv7 } = require("uuid");
const {
  db,
  insertMemoryItem,
  insertOutboxEvent,
} = require("../db");

/**
 * 创建/更新一条知识库条目。
 *
 * @param {object} params
 * @param {string} params.assistantId
 * @param {string} params.kbName        知识空间名（'world_lore' / 'user_health' 等）
 * @param {string} params.content       知识正文
 * @param {string} [params.id]          幂等 update：传现有 id 则更新该条
 * @param {string[]} [params.tags]      可选标签
 * @param {number} [params.salience=0.9]
 * @param {string} [params.quality='A']
 * @returns {{ id, created: boolean }}
 */
function upsertKnowledgeItem({
  assistantId,
  kbName,
  content,
  id = null,
  tags = null,
  salience = 0.9,
  quality = "A",
}) {
  if (!assistantId || !kbName || !content) {
    throw new Error("assistantId / kbName / content required");
  }
  const now = Date.now();
  const tagsJson = Array.isArray(tags) && tags.length ? JSON.stringify(tags) : null;

  if (id) {
    // 更新现有条目
    const existing = db
      .prepare(
        "SELECT id, assistant_id, memory_type FROM memory_items WHERE id = ?"
      )
      .get(id);
    if (!existing) {
      throw new Error("knowledge_item_not_found");
    }
    if (existing.assistant_id !== assistantId) {
      throw new Error("assistant_mismatch");
    }
    if (existing.memory_type !== "knowledge") {
      throw new Error("not_a_knowledge_item");
    }
    db.prepare(
      `UPDATE memory_items
         SET content = ?, kb_name = ?, kb_tags_json = ?, salience = ?,
             quality_grade = ?, updated_at = ?,
             vector_status = 'pending', vector_updated_at = NULL
       WHERE id = ?`
    ).run(content, kbName, tagsJson, salience, quality, now, id);
    // 触发重 embed
    insertOutboxEvent({
      eventType: "memory_item.updated",
      aggregateType: "memory_item",
      aggregateId: id,
      dedupeKey: `knowledge-update:${id}:${now}`,
      payload: { memoryId: id, source: "knowledge_update" },
    });
    return { id, created: false };
  }

  // 新建
  const sourceTurnId = `knowledge:${kbName}:${uuidv7()}`;
  const newId = insertMemoryItem({
    assistantId,
    sessionId: "",
    sourceTurnId,
    content,
    memoryType: "knowledge",
    salience,
    confidence: 1.0,
    createdAt: now,
  });
  // 补 kb_name / kb_tags_json / quality_grade（insertMemoryItem 不直接支持这些字段）
  db.prepare(
    `UPDATE memory_items
       SET kb_name = ?, kb_tags_json = ?, quality_grade = ?, category_method = 'manual'
     WHERE id = ?`
  ).run(kbName, tagsJson, quality, newId);
  // 出 outbox 触发首次 embed
  insertOutboxEvent({
    eventType: "memory_item.created",
    aggregateType: "memory_item",
    aggregateId: newId,
    dedupeKey: `memory-index:${newId}`,
    payload: { memoryId: newId, source: "knowledge_create" },
  });
  return { id: newId, created: true };
}

/**
 * 列出 knowledge_items（管理面板 / AI 查目录用）
 */
function listKnowledgeItems({ assistantId, kbName = null, limit = 50, offset = 0 }) {
  const where = ["assistant_id = ?", "memory_type = 'knowledge'"];
  const params = [assistantId];
  if (kbName) {
    where.push("kb_name = ?");
    params.push(kbName);
  }
  const rows = db
    .prepare(
      `SELECT id, kb_name, kb_tags_json, content, salience, quality_grade,
              cite_count, created_at, updated_at
         FROM memory_items
        WHERE ${where.join(" AND ")}
        ORDER BY updated_at DESC
        LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset);
  return rows.map((r) => ({
    id: r.id,
    kbName: r.kb_name,
    tags: r.kb_tags_json ? JSON.parse(r.kb_tags_json) : [],
    content: r.content,
    salience: r.salience,
    quality: r.quality_grade,
    citeCount: r.cite_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

/**
 * 列出本 assistant 下的所有 kb_name + 条目数（管理面板 sidebar 用）
 */
function listKnowledgeBases({ assistantId }) {
  const rows = db
    .prepare(
      `SELECT kb_name, COUNT(*) AS n
         FROM memory_items
        WHERE assistant_id = ? AND memory_type = 'knowledge' AND kb_name IS NOT NULL
        GROUP BY kb_name
        ORDER BY MAX(updated_at) DESC`
    )
    .all(assistantId);
  return rows.map((r) => ({ kbName: r.kb_name, count: r.n }));
}

module.exports = {
  upsertKnowledgeItem,
  listKnowledgeItems,
  listKnowledgeBases,
};
