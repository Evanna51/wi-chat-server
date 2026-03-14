const { v7: uuidv7 } = require("uuid");
const config = require("../config");
const { db } = require("../db");
const { embedText } = require("./embeddingService");
const { vectorStore } = require("./vectorStore");

function normalize(value, min, max) {
  if (max <= min) return 0;
  return (value - min) / (max - min);
}

function scoreRecency(ts, now) {
  const oneDay = 24 * 3600 * 1000;
  const deltaDays = Math.max(0, (now - ts) / oneDay);
  return Math.max(0, 1 - deltaDays / config.retrievalWindowDays);
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
}) {
  const now = Date.now();
  const queryVector = await embedText(query);
  const vectorMatches = await vectorStore.search({
    assistantId,
    queryVector,
    topK: Math.max(topK * 2, 20),
  });
  const memoryIds = vectorMatches.map((item) => item.memoryId);
  if (!memoryIds.length) return [];

  const placeholders = memoryIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, assistant_id, session_id, content, salience, confidence, created_at
       FROM memory_items
       WHERE assistant_id = ? AND id IN (${placeholders})`
    )
    .all(assistantId, ...memoryIds);

  const matchScoreMap = new Map(vectorMatches.map((item) => [item.memoryId, item.score]));
  const ranked = rows
    .map((row) => {
      const semantic = (matchScoreMap.get(row.id) + 1) / 2;
      const recency = scoreRecency(row.created_at, now);
      const salience = row.salience || 0.5;
      const confidence = row.confidence || 0.5;
      // Keep assistant-level recall as primary behavior. Session only provides a tiny tie-break boost.
      const sessionBoost = sessionId && row.session_id === sessionId ? 0.02 : 0;
      const edgeBoost = graphBoost(assistantId, row.id);
      const finalScore =
        semantic * 0.48 +
        recency * 0.2 +
        salience * 0.15 +
        confidence * 0.1 +
        edgeBoost * 0.05 +
        sessionBoost;

      return {
        id: row.id,
        content: row.content,
        sessionId: row.session_id,
        score: finalScore,
        breakdown: { semantic, recency, salience, confidence, edgeBoost, sessionBoost },
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

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
