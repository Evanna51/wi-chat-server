#!/usr/bin/env node
/**
 * 一次性把 memory_vectors.vector_blob 从 float32 (4×dim 字节) 重写为 int8 量化 (4 + dim 字节)。
 *
 * 用法：
 *   node scripts/quantize-vectors.js          # dry-run，对比若干样本的召回排序，不写库
 *   node scripts/quantize-vectors.js --apply  # 写库
 *
 * 安全：
 *   - 操作幂等（已是新格式的 blob 跳过）
 *   - 写库前先做 dry-run 校验（取若干 query，对比 float32 / int8 两种 blob 的 top-K 召回 Jaccard）
 *   - dry-run 跑完会输出 Jaccard 平均值；<0.95 时建议放弃
 */

const { db } = require("../src/db");
const {
  vectorToBlob,
  blobToVector,
  cosineSimilarity,
} = require("../src/services/vectorProviders/sqliteVectorStore");

const APPLY = process.argv.includes("--apply");

function loadAllVectors() {
  return db
    .prepare("SELECT memory_item_id, assistant_id, vector_blob, vector_dim FROM memory_vectors")
    .all();
}

// 直接读 float32 blob（绕过 blobToVector 的兼容路径，明确按老格式解）
function readF32(buf) {
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(f32);
}

function topK(query, vectors, k = 10) {
  const scored = vectors
    .map(({ id, vec }) => ({ id, score: cosineSimilarity(query, vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return scored.map((s) => s.id);
}

function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

function main() {
  const rows = loadAllVectors();
  if (!rows.length) {
    console.log("[quantize] no vectors, nothing to do");
    return;
  }

  const oldFormat = [];
  const newFormat = [];
  for (const row of rows) {
    if (!row.vector_blob || !row.vector_blob.byteLength) continue;
    if (row.vector_blob.byteLength === row.vector_dim * 4) {
      oldFormat.push(row);
    } else {
      newFormat.push(row);
    }
  }

  console.log(`[quantize] total=${rows.length}, old_f32=${oldFormat.length}, already_int8=${newFormat.length}`);
  if (!oldFormat.length) {
    console.log("[quantize] all vectors already in int8 format, exit");
    return;
  }

  // dry-run: sample 5 query 向量，分别在 float32 / int8 表示下取 top-10，比较 Jaccard
  const dim = oldFormat[0].vector_dim;
  const allF32 = oldFormat.map((r) => ({ id: r.memory_item_id, vec: readF32(r.vector_blob) }));
  const allInt8 = oldFormat.map((r) => {
    const f32vec = readF32(r.vector_blob);
    const requantBlob = vectorToBlob(f32vec);
    return { id: r.memory_item_id, vec: blobToVector(requantBlob) };
  });

  const sampleSize = Math.min(5, oldFormat.length);
  const samples = [];
  for (let i = 0; i < sampleSize; i += 1) {
    const idx = Math.floor((oldFormat.length / sampleSize) * i);
    samples.push(allF32[idx].vec);
  }

  let jaccardSum = 0;
  for (const q of samples) {
    const topF32 = topK(q, allF32, 10);
    const topInt8 = topK(q, allInt8, 10);
    const j = jaccard(topF32, topInt8);
    jaccardSum += j;
    console.log(`  sample top-10 jaccard: ${j.toFixed(3)}`);
  }
  const avg = jaccardSum / samples.length;
  console.log(`[quantize] avg jaccard top-10: ${avg.toFixed(3)} (dim=${dim})`);
  if (avg < 0.95) {
    console.error("[quantize] WARN: jaccard < 0.95, recall loss may be too high. Aborting.");
    process.exit(2);
  }

  if (!APPLY) {
    console.log(`[quantize] dry-run only. Pass --apply to write ${oldFormat.length} rows.`);
    return;
  }

  console.log(`[quantize] applying to ${oldFormat.length} rows...`);
  const upd = db.prepare(
    "UPDATE memory_vectors SET vector_blob = ?, updated_at = ? WHERE memory_item_id = ?"
  );
  const tx = db.transaction((items) => {
    const now = Date.now();
    for (const r of items) {
      const f32 = readF32(r.vector_blob);
      const newBlob = vectorToBlob(f32);
      upd.run(newBlob, now, r.memory_item_id);
    }
  });
  tx(oldFormat);
  console.log(`[quantize] done. rerun without --apply to verify.`);
}

main();
