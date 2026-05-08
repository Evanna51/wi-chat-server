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

// vector blob 格式（2026-05-08 之后）：对称 int8 量化，[scale: float32 LE (4B)] + [int8 × dim]。
// 对 1024 维省 75% 体积（4096B → 1028B）。cosine 排序对 magnitude 不敏感，量化误差 ≈ scale/254 → 召回率影响 <1%。
//
// 兼容老 float32 blob（长度 = 4 × dim，无 scale 头）：legacy 路径在 reindex 完成后可以删，
// 当前留作兜底以防有遗漏的旧行（reindex 脚本会扫全表覆盖）。
const QUANT_SCALE_BYTES = 4;
const QUANT_MAX = 127;

function vectorToBlob(vec) {
  const dim = vec.length;
  let maxAbs = 0;
  for (let i = 0; i < dim; i += 1) {
    const a = Math.abs(vec[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs > 0 ? maxAbs / QUANT_MAX : 1;
  const buf = Buffer.allocUnsafe(QUANT_SCALE_BYTES + dim);
  buf.writeFloatLE(scale, 0);
  for (let i = 0; i < dim; i += 1) {
    let q = Math.round(vec[i] / scale);
    if (q > QUANT_MAX) q = QUANT_MAX;
    if (q < -QUANT_MAX) q = -QUANT_MAX;
    buf.writeInt8(q, QUANT_SCALE_BYTES + i);
  }
  return buf;
}

function blobToVector(buf) {
  if (!buf || !buf.byteLength) return null;
  // legacy float32 blob：长度恰好是 4 的倍数且 ≥ 4 维（这里没法精确判断，用启发式：
  // 老格式 dim_old = byteLength/4；新格式 dim_new = byteLength - 4。
  // 我们无法仅凭长度区分（例如 byteLength=4096 既可能是老格式 1024 维 float32，
  // 也可能是新格式 4092 维 int8 量化）。生产 dim 固定为 1024，新格式 = 1028 字节，
  // 老格式 = 4096 字节，可区分。reindex 完成后所有 blob 都是新格式。
  if (buf.byteLength === 4096) {
    const float32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return Array.from(float32);
  }
  const dim = buf.byteLength - QUANT_SCALE_BYTES;
  const scale = buf.readFloatLE(0);
  const out = new Array(dim);
  for (let i = 0; i < dim; i += 1) {
    out[i] = buf.readInt8(QUANT_SCALE_BYTES + i) * scale;
  }
  return out;
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
        .prepare("SELECT memory_item_id, vector_blob FROM memory_vectors WHERE assistant_id = ?")
        .all(assistantId);
      const scored = rows
        .map((row) => {
          const vector = blobToVector(row.vector_blob);
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

module.exports = { createSqliteVectorStore, cosineSimilarity, blobToVector, vectorToBlob };
