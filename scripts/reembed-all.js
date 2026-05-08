#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * reembed-all.js
 *
 * 一次性把所有 memory_items 的向量用真 embedding endpoint 重新生成。
 *
 * 用法：
 *   node scripts/reembed-all.js                  # 跑全部
 *   node scripts/reembed-all.js --batch 50       # 每批 50 条
 *   node scripts/reembed-all.js --limit 200      # 总共最多 200 条
 *   node scripts/reembed-all.js --reset-only     # 只清旧向量，不立即重建（让 indexer 兜底）
 *
 * 工作流：
 *   1. DELETE 全表 memory_vectors（旧维度的伪向量没用）
 *   2. UPDATE memory_items SET vector_status='pending'（所有合法 memory_type 都重 embed）
 *   3. 分批读 pending 的 memory_items，调 embedText() 写入 memory_vectors
 *      每批之间 sleep 一小段，避免 LLM endpoint 过载
 *
 * 失败兜底：单条 embed 失败不阻塞，记 vector_status='embed_failed'。
 */

const path = require("path");

// 加载 .env
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  return defaultVal;
}

const BATCH_SIZE = Number(getArg("--batch", "30"));
const LIMIT = Number(getArg("--limit", "0")); // 0 = 不限
const RESET_ONLY = args.includes("--reset-only");
const SLEEP_MS_BETWEEN_BATCHES = Number(getArg("--sleep", "500"));

const { db } = require("../src/db");
const { embedText } = require("../src/services/embeddingService");
const { vectorStore } = require("../src/services/vectorStore");
const config = require("../src/config");

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("=== reembed-all ===");
  console.log(`config:`);
  console.log(`  EMBED_BASE_URL = ${config.embedBaseUrl || "(empty - will use fallback!)"}`);
  console.log(`  EMBED_MODEL    = ${config.embedModel}`);
  console.log(`  VECTOR_DIM     = ${config.vectorDim}`);
  console.log(`  VECTOR_PROVIDER= ${config.vectorProvider}`);
  console.log(`  BATCH_SIZE     = ${BATCH_SIZE}`);
  console.log(`  LIMIT          = ${LIMIT || "unlimited"}`);
  console.log(`  RESET_ONLY     = ${RESET_ONLY}`);
  console.log("");

  if (!config.embedBaseUrl) {
    console.error("ERROR: EMBED_BASE_URL is empty. Refusing to run with deterministic fallback.");
    console.error("       请先在 .env 配 EMBED_BASE_URL + EMBED_MODEL + VECTOR_DIM。");
    process.exit(2);
  }

  // 验证 embed 真的工作（一次试探）
  try {
    const v = await embedText("hello world");
    if (!Array.isArray(v) || v.length !== config.vectorDim) {
      console.error(`ERROR: embed test returned dim=${v?.length}, expected ${config.vectorDim}`);
      process.exit(2);
    }
    console.log(`embed test OK, dim=${v.length}`);
  } catch (e) {
    console.error(`ERROR: embed test failed: ${e.message}`);
    process.exit(2);
  }
  console.log("");

  // Step 1: 清旧 vectors + 重置 status
  const oldCount = db.prepare("SELECT COUNT(*) AS n FROM memory_vectors").get().n;
  console.log(`Step 1: 清掉旧 memory_vectors (${oldCount} 行)`);
  db.prepare("DELETE FROM memory_vectors").run();

  console.log(`Step 2: 把所有 memory_items.vector_status 重置为 pending`);
  const resetRes = db
    .prepare(
      `UPDATE memory_items SET vector_status = 'pending', vector_updated_at = NULL`
    )
    .run();
  console.log(`  reset ${resetRes.changes} memory_items`);
  console.log("");

  if (RESET_ONLY) {
    console.log("--reset-only 模式：跳过实际 embed。");
    console.log("可以让 outbox indexer 慢慢补，或后续不带 --reset-only 再跑。");
    process.exit(0);
  }

  // Step 3: 分批 embed
  console.log(`Step 3: 分批 embed（每批 ${BATCH_SIZE} 条，间隔 ${SLEEP_MS_BETWEEN_BATCHES}ms）`);
  const totalPending = db
    .prepare("SELECT COUNT(*) AS n FROM memory_items WHERE vector_status='pending'")
    .get().n;
  const totalToProcess = LIMIT > 0 ? Math.min(LIMIT, totalPending) : totalPending;
  console.log(`  total pending: ${totalPending}`);
  console.log(`  will process: ${totalToProcess}`);
  console.log("");

  let processed = 0;
  let failed = 0;
  const startTs = Date.now();

  while (processed < totalToProcess) {
    const remaining = totalToProcess - processed;
    const batch = db
      .prepare(
        `SELECT id, content FROM memory_items
         WHERE vector_status='pending'
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(Math.min(BATCH_SIZE, remaining));
    if (batch.length === 0) break;

    // 提前预取这批的 assistant_id，避免循环里 N+1
    const ids = batch.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const idToAssistant = new Map(
      db
        .prepare(`SELECT id, assistant_id FROM memory_items WHERE id IN (${placeholders})`)
        .all(...ids)
        .map((r) => [r.id, r.assistant_id])
    );

    for (const row of batch) {
      try {
        const vector = await embedText(row.content || "");
        await vectorStore.upsert({
          memoryId: row.id,
          assistantId: idToAssistant.get(row.id),
          vector,
        });
        db.prepare(
          `UPDATE memory_items
             SET vector_status='ready', vector_provider=?, vector_updated_at=?, updated_at=?
           WHERE id = ?`
        ).run(config.vectorProvider, Date.now(), Date.now(), row.id);
        processed += 1;
      } catch (e) {
        failed += 1;
        db.prepare(
          `UPDATE memory_items SET vector_status='embed_failed', updated_at=? WHERE id = ?`
        ).run(Date.now(), row.id);
        console.error(`  fail ${row.id.slice(0, 8)}: ${e.message}`);
      }
    }

    const pct = Math.round((processed / totalToProcess) * 100);
    const elapsed = Math.round((Date.now() - startTs) / 1000);
    const rate = elapsed > 0 ? Math.round(processed / elapsed) : 0;
    const eta =
      rate > 0
        ? Math.round((totalToProcess - processed) / rate)
        : null;
    console.log(
      `  batch done: processed=${processed}/${totalToProcess} (${pct}%), failed=${failed}, elapsed=${elapsed}s, rate=${rate}/s${eta != null ? `, eta=${eta}s` : ""}`
    );

    if (processed < totalToProcess && SLEEP_MS_BETWEEN_BATCHES > 0) {
      await sleep(SLEEP_MS_BETWEEN_BATCHES);
    }
  }

  console.log("");
  console.log(`=== done ===`);
  console.log(`  processed: ${processed}`);
  console.log(`  failed:    ${failed}`);
  console.log(`  vectors in DB: ${db.prepare("SELECT COUNT(*) AS n FROM memory_vectors").get().n}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("fatal:", e.stack || e.message);
  process.exit(1);
});
