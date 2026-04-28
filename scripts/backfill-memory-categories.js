#!/usr/bin/env node
/**
 * 回填 memory_items.memory_category：
 *   遍历所有 memory_type='user_turn' AND memory_category IS NULL 的行，
 *   走启发式 + LLM 分类后写回。幂等可重复运行。
 *
 * 用法：
 *   node scripts/backfill-memory-categories.js              # 默认上限 500 条
 *   node scripts/backfill-memory-categories.js --limit 200
 */

const { backfillUnclassified } = require("../src/services/memoryClassificationService");

async function main() {
  const args = process.argv.slice(2);
  let limit = 500;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args[i + 1], 10) || 500;
    }
  }

  console.log(`[backfill] start: limit=${limit}`);
  const t0 = Date.now();
  const result = await backfillUnclassified({ limit });
  const elapsed = Date.now() - t0;
  console.log(
    `[backfill] done: scanned=${result.scanned} processed=${result.processed} ` +
    `llm_calls=${result.llmCalls} elapsed=${elapsed}ms`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[backfill] error:", err);
    process.exit(1);
  });
}

module.exports = { main };
