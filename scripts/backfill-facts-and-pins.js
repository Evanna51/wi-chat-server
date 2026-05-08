#!/usr/bin/env node
/**
 * 一次性历史 backfill：
 *
 *   Phase A — 给已分类但 memory_facts 为空的 fact-bearing user_turn 抽事实（带 importance）
 *   Phase B — 给历史 importance=0.5（默认值）的存量 facts 重新跑 LLM 评分
 *   Phase C — 按 importance 自动 pin：MAX(importance) >= pin-threshold；默认不卡 quality
 *             —— 真正的关键事实（健康/重大关系）经常出现在用户的随口短句里，被 LLM 标为
 *                D/C 质量。如果还要求 quality A/B，就会把这些最该 pin 的 memory 漏掉。
 *                可加 --pin-quality A,B 强制收紧。
 *
 * 设计要点（用户明确要求）：
 *   - 本地模型：单次 prompt ≤ 500 字符（沿用 classifyWithLLM 现有截断）
 *   - 超时重试：每次 LLM 调用最多 retries 次指数退避；最终失败的 memory 跳过不阻塞
 *   - 防重复：所有 SQL 都加 NOT EXISTS / WHERE importance=0.5 / WHERE is_pinned=0 等幂等过滤
 *     脚本中断重跑只会处理"还没处理过"的行；同一 memory 永远不会被重复抽两次
 *   - 速率：每次 LLM 调用之间 RATE_DELAY_MS 间隔，避免压挂本地 Qwen
 *
 * 用法：
 *   node scripts/backfill-facts-and-pins.js                       # 全跑（A → B → C）
 *   node scripts/backfill-facts-and-pins.js --phase=facts         # 只 A
 *   node scripts/backfill-facts-and-pins.js --phase=rerate        # 只 B
 *   node scripts/backfill-facts-and-pins.js --phase=pin           # 只 C
 *   node scripts/backfill-facts-and-pins.js --limit 50            # 每个 phase 上限
 *   node scripts/backfill-facts-and-pins.js --dry-run             # 不写库，只打印
 *   node scripts/backfill-facts-and-pins.js --retries 3           # 单条 LLM 重试次数
 *   node scripts/backfill-facts-and-pins.js --pin-threshold 0.8   # Phase C 的 importance 门槛
 *   node scripts/backfill-facts-and-pins.js --pin-quality A,B     # Phase C 收紧到 A/B 质量
 */

const { db } = require("../src/db");
const {
  classifyWithLLM,
  persistFactsForMemory,
  FACT_BEARING_CATEGORIES,
} = require("../src/services/memoryClassificationService");
const { setMemoryPinned } = require("../src/services/memoryEditService");

const RATE_DELAY_MS = 200; // LLM 调用之间间隔，让本地 Qwen 喘气
const RETRY_BASE_MS = 1500;

function parseArgs() {
  const out = {
    phase: "all",
    limit: 500,
    retries: 2,
    pinThreshold: 0.85,
    pinQualities: null, // null = 不卡 quality（默认）；--pin-quality A,B 收紧
    dryRun: false,
  };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--phase" || a === "--phase=") out.phase = args[++i];
    else if (a.startsWith("--phase=")) out.phase = a.slice(8);
    else if (a === "--limit") out.limit = parseInt(args[++i], 10) || out.limit;
    else if (a === "--retries") out.retries = parseInt(args[++i], 10) || out.retries;
    else if (a === "--pin-threshold") out.pinThreshold = parseFloat(args[++i]) || out.pinThreshold;
    else if (a === "--pin-quality") {
      out.pinQualities = String(args[++i] || "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => ["A", "B", "C", "D", "E"].includes(s));
      if (out.pinQualities.length === 0) out.pinQualities = null;
    } else if (a === "--dry-run") out.dryRun = true;
  }
  if (!["all", "facts", "rerate", "pin"].includes(out.phase)) {
    throw new Error(`unknown phase: ${out.phase}`);
  }
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 包一层指数退避重试。每次失败 sleep base*2^attempt 毫秒。
 * 最终失败抛出最后一次错误，由调用方决定跳过还是中止。
 */
async function withRetry(fn, retries, label) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        const wait = RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(
          `  [retry ${attempt + 1}/${retries}] ${label}: ${e.message || e} → wait ${wait}ms`
        );
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

// ── Phase A：抽事实 ──────────────────────────────────────────────────────────

function listFactBearingMissingFacts(limit) {
  const types = Array.from(FACT_BEARING_CATEGORIES);
  const ph = types.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT m.id, m.content, m.assistant_id, p.character_name
         FROM memory_items m
         LEFT JOIN assistant_profile p ON p.assistant_id = m.assistant_id
        WHERE m.memory_type = 'user_turn'
          AND m.memory_category IN (${ph})
          AND m.category_method = 'llm'
          AND NOT EXISTS (SELECT 1 FROM memory_facts f WHERE f.memory_item_id = m.id)
        ORDER BY m.created_at DESC
        LIMIT ?`
    )
    .all(...types, limit);
}

async function phaseFacts({ limit, retries, dryRun }) {
  const rows = listFactBearingMissingFacts(limit);
  console.log(`\n[Phase A] missing-facts memories: ${rows.length}`);
  if (rows.length === 0 || dryRun) {
    if (dryRun && rows.length > 0) {
      console.log("  (dry-run) sample contents:");
      rows.slice(0, 3).forEach((r) => console.log("   -", r.content.slice(0, 60)));
    }
    return { scanned: rows.length, processed: 0, factsWritten: 0, failed: 0 };
  }

  let processed = 0;
  let factsWritten = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let result;
    try {
      result = await withRetry(
        () => classifyWithLLM(r.content, { characterName: r.character_name || null }),
        retries,
        `classify ${r.id.slice(0, 8)}`
      );
    } catch (e) {
      console.error(`  [skip] ${r.id.slice(0, 8)} llm-failed: ${e.message || e}`);
      failed += 1;
      continue;
    }

    if (
      result &&
      Array.isArray(result.facts) &&
      result.facts.length > 0 &&
      FACT_BEARING_CATEGORIES.has(result.category)
    ) {
      const written = persistFactsForMemory(r.id, result.facts);
      factsWritten += written;
      if (written > 0) processed += 1;
    }

    if ((i + 1) % 10 === 0) {
      console.log(
        `  [progress] ${i + 1}/${rows.length} processed=${processed} ` +
        `facts=${factsWritten} failed=${failed}`
      );
    }
    await sleep(RATE_DELAY_MS);
  }

  console.log(
    `[Phase A] done: scanned=${rows.length} processed=${processed} ` +
    `facts_written=${factsWritten} failed=${failed}`
  );
  return { scanned: rows.length, processed, factsWritten, failed };
}

// ── Phase B：给存量 importance=0.5 的 facts 重新评分 ────────────────────────

function listMemoriesWithDefaultImportanceFacts(limit) {
  return db
    .prepare(
      `SELECT DISTINCT m.id, m.content, m.assistant_id, p.character_name
         FROM memory_items m
         JOIN memory_facts f ON f.memory_item_id = m.id
         LEFT JOIN assistant_profile p ON p.assistant_id = m.assistant_id
        WHERE f.importance = 0.5
        ORDER BY m.created_at DESC
        LIMIT ?`
    )
    .all(limit);
}

const updateImportanceStmt = db.prepare(
  `UPDATE memory_facts
      SET importance = ?
    WHERE memory_item_id = ? AND fact_key = ? AND importance = 0.5`
);

async function phaseRerate({ limit, retries, dryRun }) {
  const rows = listMemoriesWithDefaultImportanceFacts(limit);
  console.log(`\n[Phase B] memories with default-importance facts: ${rows.length}`);
  if (rows.length === 0 || dryRun) {
    if (dryRun && rows.length > 0) {
      console.log("  (dry-run) sample contents:");
      rows.slice(0, 3).forEach((r) => console.log("   -", r.content.slice(0, 60)));
    }
    return { scanned: rows.length, processed: 0, updated: 0, failed: 0 };
  }

  let processed = 0;
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let result;
    try {
      result = await withRetry(
        () => classifyWithLLM(r.content, { characterName: r.character_name || null }),
        retries,
        `rerate ${r.id.slice(0, 8)}`
      );
    } catch (e) {
      console.error(`  [skip] ${r.id.slice(0, 8)} llm-failed: ${e.message || e}`);
      failed += 1;
      continue;
    }

    if (!result || !Array.isArray(result.facts)) {
      processed += 1;
      await sleep(RATE_DELAY_MS);
      continue;
    }

    let touched = 0;
    for (const f of result.facts) {
      if (typeof f.importance !== "number") continue;
      const res = updateImportanceStmt.run(f.importance, r.id, f.key);
      touched += res.changes;
    }
    if (touched > 0) updated += touched;
    processed += 1;

    if ((i + 1) % 10 === 0) {
      console.log(
        `  [progress] ${i + 1}/${rows.length} processed=${processed} ` +
        `updated_facts=${updated} failed=${failed}`
      );
    }
    await sleep(RATE_DELAY_MS);
  }

  console.log(
    `[Phase B] done: scanned=${rows.length} processed=${processed} ` +
    `updated_facts=${updated} failed=${failed}`
  );
  return { scanned: rows.length, processed, updated, failed };
}

// ── Phase C：按 importance 自动 pin ─────────────────────────────────────────

function listAutoPinCandidates({ threshold, qualities, limit }) {
  const params = [];
  let qualityClause = "";
  if (qualities && qualities.length > 0) {
    const ph = qualities.map(() => "?").join(",");
    qualityClause = `AND m.quality_grade IN (${ph})`;
    params.push(...qualities);
  }
  params.push(threshold, limit);
  return db
    .prepare(
      `SELECT m.id, m.assistant_id, m.memory_category, m.quality_grade,
              MAX(f.importance) AS max_importance,
              MAX(f.importance * 0.6 + f.confidence * 0.4) AS max_score,
              COUNT(f.id) AS fact_count
         FROM memory_items m
         JOIN memory_facts f ON f.memory_item_id = m.id
        WHERE m.is_pinned = 0
          ${qualityClause}
        GROUP BY m.id
       HAVING max_importance >= ?
        ORDER BY max_score DESC
        LIMIT ?`
    )
    .all(...params);
}

function phasePin({ limit, threshold, qualities, dryRun }) {
  const candidates = listAutoPinCandidates({ threshold, qualities, limit });
  const qualityLabel = qualities && qualities.length > 0 ? qualities.join("/") : "any";
  console.log(
    `\n[Phase C] auto-pin candidates (importance>=${threshold}, quality=${qualityLabel}): ${candidates.length}`
  );
  if (candidates.length === 0) {
    return { scanned: 0, pinned: 0 };
  }
  console.log("  top samples:");
  candidates.slice(0, 5).forEach((c) =>
    console.log(
      `   - ${c.id.slice(0, 8)} cat=${c.memory_category} q=${c.quality_grade} ` +
      `max_imp=${c.max_importance.toFixed(2)} score=${c.max_score.toFixed(2)} facts=${c.fact_count}`
    )
  );

  if (dryRun) {
    return { scanned: candidates.length, pinned: 0 };
  }

  let pinned = 0;
  for (const c of candidates) {
    const result = setMemoryPinned(c.id, true, {
      assistantId: c.assistant_id,
      actor: "system",
      reason: `auto-pin via backfill: max_importance=${c.max_importance.toFixed(2)} >= ${threshold}`,
    });
    if (result.changed) pinned += 1;
  }

  console.log(`[Phase C] done: pinned=${pinned}/${candidates.length}`);
  return { scanned: candidates.length, pinned };
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();
  console.log("[backfill-facts-and-pins] options:", opts);
  const t0 = Date.now();

  const summary = {};
  if (opts.phase === "all" || opts.phase === "facts") {
    summary.phaseA = await phaseFacts(opts);
  }
  if (opts.phase === "all" || opts.phase === "rerate") {
    summary.phaseB = await phaseRerate(opts);
  }
  if (opts.phase === "all" || opts.phase === "pin") {
    summary.phaseC = phasePin({
      limit: opts.limit,
      threshold: opts.pinThreshold,
      qualities: opts.pinQualities,
      dryRun: opts.dryRun,
    });
  }

  console.log(
    `\n[backfill-facts-and-pins] all done in ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[backfill-facts-and-pins] fatal:", err);
    process.exit(1);
  });
}

module.exports = { main };
