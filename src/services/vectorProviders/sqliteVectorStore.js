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

function vectorToBlob(vec) {
  const float32 = new Float32Array(vec);
  return Buffer.from(float32.buffer, float32.byteOffset, float32.byteLength);
}

function blobToVector(buf) {
  if (!buf || !buf.byteLength) return null;
  const float32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(float32);
}

function decodeRowVector(row) {
  if (row.vector_blob) {
    const vec = blobToVector(row.vector_blob);
    if (vec) return vec;
  }
  if (row.vector_json) {
    try {
      return JSON.parse(row.vector_json);
    } catch (_) {
      return null;
    }
  }
  return null;
}

function createSqliteVectorStore(db) {
  return {
    name: "sqlite",
    async upsert({ memoryId, assistantId, vector }) {
      const blob = vectorToBlob(vector);
      db.prepare(
        `INSERT INTO memory_vectors (memory_item_id, assistant_id, vector_blob, vector_dim, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(memory_item_id) DO UPDATE SET
            assistant_id=excluded.assistant_id,
            vector_blob=excluded.vector_blob,
            vector_dim=excluded.vector_dim,
            updated_at=excluded.updated_at`
      ).run(memoryId, assistantId, blob, vector.length, Date.now());
    },
    async search({ assistantId, queryVector, topK = config.vectorK }) {
      const rows = db
        .prepare(
          "SELECT memory_item_id, vector_blob, vector_json FROM memory_vectors WHERE assistant_id = ?"
        )
        .all(assistantId);
      const scored = rows
        .map((row) => {
          const vector = decodeRowVector(row);
          if (!vector) return null;
          return {
            memoryId: row.memory_item_id,
            score: cosineSimilarity(queryVector, vector),
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return scored;
    },
  };
}

module.exports = { createSqliteVectorStore, cosineSimilarity };
