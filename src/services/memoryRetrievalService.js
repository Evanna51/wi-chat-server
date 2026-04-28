const { v7: uuidv7 } = require("uuid");
const config = require("../config");
const { db } = require("../db");
const { embedText } = require("./embeddingService");
const { vectorStore } = require("./vectorStore");

const QUALITY_WEIGHT = { A: 1.0, B: 0.8, C: 0.6, D: 0.3, E: 0.0 };

// source 参数 → memory_type IN (...) 映射
const SOURCE_TYPES = {
  user:      ["user_turn"],
  character: ["life_event", "work_event", "assistant_turn"],
  all:       null, // 不过滤
};

function normalize(value, min, max) {
  if (max <= min) return 0;
  return (value - min) / (max - min);
}

function scoreRecency(ts, now) {
  const oneDay = 24 * 3600 * 1000;
  const deltaDays = Math.max(0, (now - ts) / oneDay);
  return Math.max(0, 1 - deltaDays / config.retrievalWindowDays);
}

function scoreQuality(grade) {
  if (grade && QUALITY_WEIGHT[grade] !== undefined) return QUALITY_WEIGHT[grade];
  return 0.5; // 未分类按中性处理
}

function scoreCitePopularity(citeCount) {
  // log1p / log(50)：cite=0→0, cite=10→~0.61, cite=50→1
  return Math.min(1, Math.log1p(citeCount || 0) / Math.log(50));
}

function graphBoost(assistantId, memoryId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(weight), 0) AS total_weight
       FROM memory_edges
       WHERE assistant_id = ? AND (source_memory_id = ? OR target_memory_id = ?)`
    )
    .get(assistantId, memoryId, memoryId);
  return Math.min(1, normalize(row.total_weight || 0, 0, 5));
}

async function retrieveMemory({
  assistantId,
  sessionId = "",
  query,
  topK = config.retrievalTopK,
  strategy = config.retrievalStrategy,
  category = null,
  source = null,        // "user" | "character" | "all" | null（不过滤）
  minQuality = null,    // "A"|"B"|"C"|"D"|"E"，A 最严
}) {
  const now = Date.now();
  const queryVector = await embedText(query);
  // 有过滤条件时多取一些候选，避免 SQL 过滤后剩下太少
  const hasFilter = !!(category || source || minQuality);
  const vectorMatches = await vectorStore.search({
    assistantId,
    queryVector,
    topK: Math.max(topK * (hasFilter ? 5 : 2), 20),
  });
  const memoryIds = vectorMatches.map((item) => item.memoryId);
  if (!memoryIds.length) return [];

  const placeholders = memoryIds.map(() => "?").join(",");
  const whereClauses = [`assistant_id = ?`, `id IN (${placeholders})`];
  const params = [assistantId, ...memoryIds];

  if (category) {
    whereClauses.push("memory_category = ?");
    params.push(category);
  }

  const sourceTypes = source ? SOURCE_TYPES[source] : null;
  if (sourceTypes && sourceTypes.length > 0) {
    const typePlaceholders = sourceTypes.map(() => "?").join(",");
    whereClauses.push(`memory_type IN (${typePlaceholders})`);
    params.push(...sourceTypes);
  }

  if (minQuality) {
    // A < B < C < D < E 字典序，且 NULL（未分类）放行
    whereClauses.push(`(quality_grade IS NULL OR quality_grade <= ?)`);
    params.push(minQuality);
  }

  const sql = `SELECT id, assistant_id, session_id, memory_type, content, salience, confidence,
                      memory_category, quality_grade, cite_count, created_at
                 FROM memory_items
                WHERE ${whereClauses.join(" AND ")}`;
  const rows = db.prepare(sql).all(...params);

  const matchScoreMap = new Map(vectorMatches.map((item) => [item.memoryId, item.score]));
  const ranked = rows
    .map((row) => {
      const semantic       = (matchScoreMap.get(row.id) + 1) / 2;
      const recency        = scoreRecency(row.created_at, now);
      const salience       = row.salience || 0.5;
      const confidence     = row.confidence || 0.5;
      const qualityScore   = scoreQuality(row.quality_grade);
      const citePopularity = scoreCitePopularity(row.cite_count);
      const sessionBoost   = sessionId && row.session_id === sessionId ? 0.02 : 0;
      const edgeBoost      = graphBoost(assistantId, row.id);

      const finalScore =
        semantic        * 0.42
        + recency       * 0.18
        + salience      * 0.10
        + confidence    * 0.08
        + qualityScore  * 0.10
        + citePopularity * 0.05
        + edgeBoost     * 0.05
        + sessionBoost;

      return {
        id: row.id,
        content: row.content,
        sessionId: row.session_id,
        memoryType: row.memory_type,
        category: row.memory_category,
        quality: row.quality_grade,
        createdAt: row.created_at,
        score: finalScore,
        breakdown: {
          semantic, recency, salience, confidence,
          qualityScore, citePopularity, edgeBoost, sessionBoost,
        },
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // 批量自增 cite_count，记录被检索行为
  if (ranked.length > 0) {
    const ids = ranked.map((r) => r.id);
    const idPlaceholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE memory_items
          SET cite_count = cite_count + 1, last_cited_at = ?
        WHERE id IN (${idPlaceholders})`
    ).run(now, ...ids);
  }

  db.prepare(
    `INSERT INTO memory_retrieval_log
      (id, assistant_id, session_id, query_text, selected_memory_ids_json, score_breakdown_json, strategy, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuidv7(),
    assistantId,
    sessionId,
    query,
    JSON.stringify(ranked.map((item) => item.id)),
    JSON.stringify(ranked.map((item) => ({ id: item.id, ...item.breakdown, score: item.score }))),
    strategy,
    now
  );

  return ranked;
}

module.exports = { retrieveMemory };
