#!/usr/bin/env node
/**
 * eval-retrieval.js — 检索回归 fixture 跑分器
 *
 * 用法：
 *   node scripts/eval-retrieval.js                              # 全跑
 *   node scripts/eval-retrieval.js --only 01-preference-coffee  # 只跑某 fixture（按 name）
 *   node scripts/eval-retrieval.js --write-baseline             # 把当前结果写为 baseline
 *   node scripts/eval-retrieval.js --compare-baseline           # 对比 baseline，退化超阈值非 0 退出
 *   node scripts/eval-retrieval.js --regression-threshold 0.05  # 退化容忍（默认 0.05）
 *   node scripts/eval-retrieval.js --keep                       # 跑完不清理 fixture 数据（调试用）
 *
 * 工作流：
 *   1. 加载 tests/retrieval/fixtures/*.json
 *   2. 逐个跑：wipe(assistantId) → 插 seed → 同步 embed → postSeedActions → retrieveMemory → score
 *   3. 输出 per-fixture pass/fail + Recall@5 + MRR
 *   4. 汇总 + （可选）对比/写 baseline
 *
 * 重要约束：
 *   - 必须配 EMBED_BASE_URL；deterministic fallback 没有语义，会让 1-6 号 fixture 全 fail
 *   - 仅操作 assistant_id 以 `eval-fix-` 开头的行；绝不动生产数据
 *   - retrieveMemory 写的 memory_retrieval_log 在 wipe 阶段一并清理
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { db } = require("../src/db");
const config = require("../src/config");
const { embedText } = require("../src/services/embeddingService");
const { vectorStore } = require("../src/services/vectorStore");
const { retrieveMemory } = require("../src/services/memoryRetrievalService");
const { ingestInteraction } = require("../src/services/memoryIngestService");
const {
  insertConversationTurn,
  insertMemoryItem,
  insertOutboxEvent,
  findMemoryItemBySourceTurnId,
} = require("../src/db");
const { upsertKnowledgeItem } = require("../src/services/knowledgeService");
const { setMemoryPinned } = require("../src/services/memoryEditService");
const { v7: uuidv7 } = require("uuid");

const FIXTURES_DIR = path.join(__dirname, "..", "tests", "retrieval", "fixtures");
const BASELINE_FILE = path.join(__dirname, "..", "tests", "retrieval", "baseline.json");
const ASSISTANT_ID_PREFIX = "eval-fix-";

function parseArgs() {
  const out = {
    only: null,
    writeBaseline: false,
    compareBaseline: false,
    regressionThreshold: 0.05,
    keep: false,
  };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--only") out.only = args[++i];
    else if (a === "--write-baseline") out.writeBaseline = true;
    else if (a === "--compare-baseline") out.compareBaseline = true;
    else if (a === "--regression-threshold") out.regressionThreshold = parseFloat(args[++i]) || 0.05;
    else if (a === "--keep") out.keep = true;
  }
  return out;
}

function loadFixtures() {
  const files = fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json")).sort();
  return files.map((f) => {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), "utf8"));
    if (!fixture.assistantId.startsWith(ASSISTANT_ID_PREFIX)) {
      throw new Error(`fixture ${f}: assistantId must start with ${ASSISTANT_ID_PREFIX}`);
    }
    return fixture;
  });
}

function wipeFixtureNamespace(assistantId) {
  if (!assistantId.startsWith(ASSISTANT_ID_PREFIX)) {
    throw new Error(`refusing to wipe non-fixture assistant: ${assistantId}`);
  }
  const tx = db.transaction(() => {
    const memIds = db
      .prepare("SELECT id FROM memory_items WHERE assistant_id = ?")
      .all(assistantId)
      .map((r) => r.id);
    if (memIds.length) {
      const ph = memIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM memory_facts WHERE memory_item_id IN (${ph})`).run(...memIds);
      db.prepare(`DELETE FROM memory_vectors WHERE memory_item_id IN (${ph})`).run(...memIds);
      db.prepare(
        `DELETE FROM memory_edges WHERE source_memory_id IN (${ph}) OR target_memory_id IN (${ph})`
      ).run(...memIds, ...memIds);
      db.prepare(`DELETE FROM memory_audit_log WHERE memory_item_id IN (${ph})`).run(...memIds);
      db.prepare(`DELETE FROM outbox_events WHERE aggregate_id IN (${ph})`).run(...memIds);
    }
    db.prepare("DELETE FROM memory_items WHERE assistant_id = ?").run(assistantId);
    db.prepare("DELETE FROM conversation_turns WHERE assistant_id = ?").run(assistantId);
    db.prepare("DELETE FROM memory_retrieval_log WHERE assistant_id = ?").run(assistantId);
  });
  tx();
}

async function embedAndUpsert(memoryId, assistantId, content) {
  const vector = await embedText(content || "");
  await vectorStore.upsert({ memoryId, assistantId, vector });
  db.prepare(
    `UPDATE memory_items
        SET vector_status='ready', vector_provider=?, vector_updated_at=?, updated_at=?
      WHERE id = ?`
  ).run(config.vectorProvider, Date.now(), Date.now(), memoryId);
}

async function seedFixture(fixture, now) {
  const memoryIdsByHint = []; // [{ memoryId, content }] for postSeedActions matching

  // 1. 普通对话 seed
  for (const turn of fixture.seed || []) {
    const eventTime = now + (turn.createdAtOffsetMs || 0);
    const result = ingestInteraction({
      db,
      assistantId: fixture.assistantId,
      sessionId: fixture.sessionId,
      role: turn.role,
      content: turn.content,
      now: eventTime,
      insertConversationTurn,
      insertMemoryItem,
      insertOutboxEvent,
      findMemoryItemBySourceTurnId,
    });
    if (result.memoryId) {
      memoryIdsByHint.push({ memoryId: result.memoryId, content: turn.content });
      await embedAndUpsert(result.memoryId, fixture.assistantId, turn.content);
    }
  }

  // 2. 知识库 seed
  for (const kb of fixture.knowledgeSeed || []) {
    const r = upsertKnowledgeItem({
      assistantId: fixture.assistantId,
      kbName: kb.kbName,
      content: kb.content,
      tags: kb.kbTagsJson ? JSON.parse(kb.kbTagsJson) : null,
    });
    memoryIdsByHint.push({ memoryId: r.id, content: kb.content });
    await embedAndUpsert(r.id, fixture.assistantId, kb.content);
  }

  // 3. life_event seed（直接插 memory_items，无对应 turn）
  for (const ev of fixture.lifeEventSeed || []) {
    const eventTime = now + (ev.createdAtOffsetMs || 0);
    const sourceTurnId = `lifeevent:${uuidv7()}`;
    const memoryId = insertMemoryItem({
      assistantId: fixture.assistantId,
      sessionId: fixture.sessionId,
      sourceTurnId,
      content: ev.content,
      memoryType: "life_event",
      salience: 0.7,
      confidence: 0.8,
      createdAt: eventTime,
    });
    memoryIdsByHint.push({ memoryId, content: ev.content });
    await embedAndUpsert(memoryId, fixture.assistantId, ev.content);
  }

  return memoryIdsByHint;
}

function findMemoryByHints(memoryIdsByHint, matchHints) {
  const hits = memoryIdsByHint.filter(({ content }) =>
    matchHints.every((h) => content.includes(h))
  );
  return hits;
}

function runPostSeedActions(fixture, memoryIdsByHint) {
  for (const action of fixture.postSeedActions || []) {
    const targets = findMemoryByHints(memoryIdsByHint, action.matchHints || []);
    if (targets.length === 0) {
      throw new Error(
        `postSeedAction matched no memory: hints=${JSON.stringify(action.matchHints)}`
      );
    }
    for (const t of targets) {
      switch (action.type) {
        case "pin":
          setMemoryPinned(t.memoryId, true, {
            assistantId: fixture.assistantId,
            actor: "eval-harness",
            reason: "fixture postSeedAction",
          });
          break;
        case "setCategory":
          db.prepare(
            `UPDATE memory_items
                SET memory_category=?, quality_grade=?, category_method='eval', updated_at=?
              WHERE id=?`
          ).run(
            action.category || null,
            action.qualityGrade || null,
            Date.now(),
            t.memoryId
          );
          break;
        case "setCiteCount":
          db.prepare(
            "UPDATE memory_items SET cite_count=?, last_cited_at=?, updated_at=? WHERE id=?"
          ).run(action.citeCount || 0, Date.now(), Date.now(), t.memoryId);
          break;
        default:
          throw new Error(`unknown postSeedAction type: ${action.type}`);
      }
    }
  }
}

function matchResult(result, matchHints) {
  return matchHints.every((h) => (result.content || "").includes(h));
}

function scoreFixture(fixture, results) {
  const issues = [];
  let firstHitRank = null;
  let hits = 0;
  let totalExpected = 0;

  // topKContains
  for (const spec of fixture.expected?.topKContains || []) {
    totalExpected += 1;
    const minRank = spec.minRank || 1;
    const maxRank = spec.maxRank || (fixture.topK || 5);
    const matchedIdx = results.findIndex((r) => matchResult(r, spec.matchHints));
    if (matchedIdx === -1) {
      issues.push(
        `topKContains miss: hints=${JSON.stringify(spec.matchHints)} (no result matched)`
      );
      continue;
    }
    const rank = matchedIdx + 1;
    if (rank < minRank || rank > maxRank) {
      issues.push(
        `topKContains rank out of range: hints=${JSON.stringify(spec.matchHints)} got rank=${rank}, want [${minRank},${maxRank}]`
      );
      continue;
    }
    hits += 1;
    if (firstHitRank == null) firstHitRank = rank;
  }

  // topKExcludes
  for (const spec of fixture.expected?.topKExcludes || []) {
    const matchedIdx = results.findIndex((r) => matchResult(r, spec.matchHints));
    if (matchedIdx !== -1) {
      issues.push(
        `topKExcludes hit at rank ${matchedIdx + 1}: hints=${JSON.stringify(spec.matchHints)}`
      );
    }
  }

  // maxResults
  if (typeof fixture.expected?.maxResults === "number") {
    if (results.length > fixture.expected.maxResults) {
      issues.push(`maxResults exceeded: got ${results.length}, want ≤ ${fixture.expected.maxResults}`);
    }
  }

  const recallAt5 = totalExpected > 0 ? hits / totalExpected : 1;
  const mrr = firstHitRank ? 1 / firstHitRank : 0;

  return {
    pass: issues.length === 0,
    issues,
    recallAt5,
    mrr,
    hits,
    totalExpected,
  };
}

async function runFixture(fixture) {
  const now = Date.now();
  wipeFixtureNamespace(fixture.assistantId);
  const memoryIdsByHint = await seedFixture(fixture, now);
  runPostSeedActions(fixture, memoryIdsByHint);

  const t0 = Date.now();
  const results = await retrieveMemory({
    assistantId: fixture.assistantId,
    sessionId: fixture.sessionId,
    query: fixture.query,
    topK: fixture.topK || 5,
    ...(fixture.retrievalOptions || {}),
  });
  const latencyMs = Date.now() - t0;

  const score = scoreFixture(fixture, results);
  return { ...score, latencyMs, resultCount: results.length };
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function compareBaseline(current, baseline, threshold) {
  const regressions = [];
  for (const name of Object.keys(current)) {
    const c = current[name];
    const b = baseline[name];
    if (!b) {
      regressions.push({ name, kind: "new-fixture", note: "no baseline entry" });
      continue;
    }
    if (b.pass && !c.pass) {
      regressions.push({ name, kind: "pass→fail", baseline: b, current: c });
      continue;
    }
    if (b.recallAt5 - c.recallAt5 > threshold) {
      regressions.push({
        name,
        kind: "recall regression",
        delta: (c.recallAt5 - b.recallAt5).toFixed(3),
      });
    }
    if (b.mrr - c.mrr > threshold) {
      regressions.push({
        name,
        kind: "mrr regression",
        delta: (c.mrr - b.mrr).toFixed(3),
      });
    }
  }
  return regressions;
}

async function main() {
  const args = parseArgs();
  console.log("[eval-retrieval] config:");
  console.log(`  EMBED_BASE_URL = ${config.embedBaseUrl || "(empty - DETERMINISTIC FALLBACK)"}`);
  console.log(`  VECTOR_PROVIDER = ${config.vectorProvider}`);
  console.log(`  VECTOR_DIM = ${config.vectorDim}`);
  console.log("");

  if (!config.embedBaseUrl) {
    console.error(
      "[eval-retrieval] WARNING: EMBED_BASE_URL is empty; semantic-recall fixtures will fail."
    );
    console.error(
      "  Set EMBED_BASE_URL in .env or run with `EMBED_BASE_URL=... node scripts/eval-retrieval.js`"
    );
    console.log("");
  }

  const fixtures = loadFixtures();
  const filtered = args.only ? fixtures.filter((f) => f.name === args.only) : fixtures;
  if (args.only && filtered.length === 0) {
    console.error(`[eval-retrieval] fixture not found: ${args.only}`);
    process.exit(2);
  }

  const results = {};
  let passCount = 0;
  let totalRecall = 0;
  let totalMrr = 0;
  let totalLatency = 0;

  for (const fixture of filtered) {
    process.stdout.write(`  ${fixture.name} ... `);
    let outcome;
    try {
      outcome = await runFixture(fixture);
    } catch (e) {
      outcome = {
        pass: false,
        issues: [`exception: ${e.message}`],
        recallAt5: 0,
        mrr: 0,
        latencyMs: 0,
        resultCount: 0,
      };
    }
    results[fixture.name] = outcome;
    if (outcome.pass) passCount += 1;
    totalRecall += outcome.recallAt5;
    totalMrr += outcome.mrr;
    totalLatency += outcome.latencyMs;
    if (outcome.pass) {
      console.log(
        `PASS  recall@5=${outcome.recallAt5.toFixed(2)} mrr=${outcome.mrr.toFixed(2)} ${outcome.latencyMs}ms`
      );
    } else {
      console.log(`FAIL  ${outcome.latencyMs}ms`);
      for (const issue of outcome.issues) console.log(`        - ${issue}`);
    }

    if (!args.keep) {
      try {
        wipeFixtureNamespace(fixture.assistantId);
      } catch (e) {
        console.warn(`  wipe failed for ${fixture.assistantId}: ${e.message}`);
      }
    }
  }

  const total = filtered.length;
  console.log("");
  console.log(
    `[eval-retrieval] summary: ${passCount}/${total} pass | ` +
      `avg recall@5=${(totalRecall / total).toFixed(3)} | ` +
      `avg mrr=${(totalMrr / total).toFixed(3)} | ` +
      `avg latency=${Math.round(totalLatency / total)}ms`
  );

  if (args.writeBaseline) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(results, null, 2));
    console.log(`[eval-retrieval] baseline written to ${BASELINE_FILE}`);
  }

  if (args.compareBaseline) {
    const baseline = loadBaseline();
    if (!baseline) {
      console.error("[eval-retrieval] no baseline file; run with --write-baseline first.");
      process.exit(2);
    }
    const regressions = compareBaseline(results, baseline, args.regressionThreshold);
    if (regressions.length > 0) {
      console.error("");
      console.error(`[eval-retrieval] regressions (threshold=${args.regressionThreshold}):`);
      for (const r of regressions) console.error("  -", JSON.stringify(r));
      process.exit(1);
    }
    console.log("[eval-retrieval] no regressions vs baseline.");
  }

  process.exit(passCount === total ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[eval-retrieval] fatal:", e.stack || e.message);
    process.exit(1);
  });
}

module.exports = { main, loadFixtures, runFixture };
