const config = require("../../config");

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function createSqliteVectorStore(db) {
  return {
    name: "sqlite",
    async upsert({ memoryId, assistantId, vector }) {
      db.prepare(
        `INSERT INTO memory_vectors (memory_item_id, assistant_id, vector_json, vector_dim, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(memory_item_id) DO UPDATE SET
            assistant_id=excluded.assistant_id,
            vector_json=excluded.vector_json,
            vector_dim=excluded.vector_dim,
            updated_at=excluded.updated_at`
      ).run(memoryId, assistantId, JSON.stringify(vector), vector.length, Date.now());
    },
    async search({ assistantId, queryVector, topK = config.vectorK }) {
      const rows = db
        .prepare("SELECT memory_item_id, vector_json FROM memory_vectors WHERE assistant_id = ?")
        .all(assistantId);
      const scored = rows
        .map((row) => {
          const vector = JSON.parse(row.vector_json);
          return {
            memoryId: row.memory_item_id,
            score: cosineSimilarity(queryVector, vector),
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return scored;
    },
  };
}

module.exports = { createSqliteVectorStore, cosineSimilarity };
