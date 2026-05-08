#!/usr/bin/env node
/**
 * reinit-derived-data.js
 *
 * 给定一个**只保留 conversation_turns + assistant_profile** 的 SQLite 库，
 * 一次性重建所有派生数据：memory_items / memory_facts / memory_edges /
 * memory_vectors / outbox_events / character_state / proactive_plans / 等。
 *
 * 何时跑：
 *   - 改了 ingest 逻辑 / 评分公式 / 向量维度 / classify schema 之后想清洗存量
 *   - 调试想从干净状态出发
 *   - 新机器拷过来一份对话原文，要把整个派生层"长"出来
 *
 * 用法：
 *   node scripts/reinit-derived-data.js                     # 全量重建（带交互确认）
 *   node scripts/reinit-derived-data.js --yes               # 跳过交互确认
 *   node scripts/reinit-derived-data.js --dry-run           # 只打印将要做什么，不写库
 *   node scripts/reinit-derived-data.js --skip-embed        # 跳过 embed 阶段（让 indexer 兜底）
 *   node scripts/reinit-derived-data.js --skip-classify     # 跳过 classify+facts
 *   node scripts/reinit-derived-data.js --skip-pin          # 跳过 auto-pin
 *   node scripts/reinit-derived-data.js --reset-character-state  # 同时重置 mood/intimacy
 *   node scripts/reinit-derived-data.js --assistant <id>    # 只重建某 assistant
 *   node scripts/reinit-derived-data.js --limit 500         # 仅 ingest 前 N 条 turn（debug 用）
 *
 * 流程：
 *   阶段 0：盘点 + 确认（dry-run / 用户 yes 才进阶段 1）
 *   阶段 1：wipe 派生表（事务）
 *   阶段 2：按 (assistant_id, session_id, created_at ASC) 重放 ingestInteraction
 *   阶段 3：（默认）同步 embed 所有 pending user_turn
 *   阶段 4：（默认）classify + 抽 facts
 *   阶段 5：（默认）auto-pin top facts
 *   阶段 6：（可选 --reset-character-state）重置 character_state + 重放 onUserMessage
 *
 * 不动的表：
 *   conversation_turns / assistant_profile / schema_migrations / push_token /
 *   sync_checkpoints / dead_letter_events / provider_call_log
 *
 * 安全：
 *   - 默认所有写都走 SQL 事务，失败回滚
 *   - 阶段 1 wipe 前打印每张表行数，需要 yes
 *   - dry-run 不会触碰任何 DML
 */

const path = require("path");
const readline = require("readline");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { db } = require("../src/db");
const config = require("../src/config");
const { embedText } = require("../src/services/embeddingService");
const { vectorStore } = require("../src/services/vectorStore");
const { ingestInteraction, SEMANTIC_ROLES } = require("../src/services/memoryIngestService");
const {
  insertConversationTurn,
  insertMemoryItem,
  insertOutboxEvent,
  findMemoryItemBySourceTurnId,
} = require("../src/db");

function parseArgs() {
  const out = {
    dryRun: false,
    yes: false,
    skipEmbed: false,
    skipClassify: false,
    skipPin: false,
    resetCharacterState: false,
    assistant: null,
    limit: 0,
  };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--skip-embed") out.skipEmbed = true;
    else if (a === "--skip-classify") out.skipClassify = true;
    else if (a === "--skip-pin") out.skipPin = true;
    else if (a === "--reset-character-state") out.resetCharacterState = true;
    else if (a === "--assistant") out.assistant = args[++i];
    else if (a === "--limit") out.limit = parseInt(args[++i], 10) || 0;
  }
  return out;
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const DERIVED_TABLES = [
  "memory_facts",
  "memory_edges",
  "memory_vectors",
  "memory_audit_log",
  "memory_retrieval_log",
  "memory_items",
  "outbox_events",
  "local_outbox_messages",
  "proactive_plans",
  "character_behavior_journal",
];

function tableExists(name) {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function countRows(table, whereClause = "", params = []) {
  if (!tableExists(table)) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${whereClause}`).get(...params);
  return row?.n || 0;
}

// ── Stage 0: inventory ──────────────────────────────────────────────────────

function printInventory(args) {
  const wherePerAssistant = args.assistant ? "WHERE assistant_id = ?" : "";
  const params = args.assistant ? [args.assistant] : [];
  console.log("\n[reinit] inventory:");
  console.log(`  conversation_turns       : ${countRows("conversation_turns", wherePerAssistant, params)}`);
  console.log(`  assistant_profile        : ${countRows("assistant_profile")}`);
  console.log(`  character_state          : ${countRows("character_state")}`);
  console.log("");
  console.log("[reinit] tables to be WIPED:");
  for (const t of DERIVED_TABLES) {
    if (tableExists(t)) {
      const n = args.assistant && t.startsWith("memory_")
        ? countRows(t, "WHERE assistant_id = ?", [args.assistant])
        : countRows(t);
      console.log(`  - ${t.padEnd(32)} ${n} rows`);
    } else {
      console.log(`  - ${t.padEnd(32)} (table missing, skip)`);
    }
  }
  if (args.resetCharacterState) {
    const n = args.assistant
      ? countRows("character_state", "WHERE assistant_id = ?", [args.assistant])
      : countRows("character_state");
    console.log(`  - character_state          ${n} rows  (--reset-character-state)`);
  }
  console.log("");
}

// ── Stage 1: wipe ───────────────────────────────────────────────────────────

function wipeStage(args) {
  const tx = db.transaction(() => {
    if (args.assistant) {
      // 单 assistant 模式：只清该 assistant 的派生数据
      const a = args.assistant;
      const memIds = db
        .prepare("SELECT id FROM memory_items WHERE assistant_id = ?")
        .all(a)
        .map((r) => r.id);
      if (memIds.length) {
        const ph = memIds.map(() => "?").join(",");
        db.prepare(`DELETE FROM memory_facts WHERE memory_item_id IN (${ph})`).run(...memIds);
        db.prepare(`DELETE FROM memory_vectors WHERE memory_item_id IN (${ph})`).run(...memIds);
        db.prepare(
          `DELETE FROM memory_edges WHERE source_memory_id IN (${ph}) OR target_memory_id IN (${ph})`
        ).run(...memIds, ...memIds);
        if (tableExists("memory_audit_log")) {
          db.prepare(`DELETE FROM memory_audit_log WHERE memory_item_id IN (${ph})`).run(...memIds);
        }
        db.prepare(`DELETE FROM outbox_events WHERE aggregate_id IN (${ph})`).run(...memIds);
      }
      db.prepare("DELETE FROM memory_items WHERE assistant_id = ?").run(a);
      db.prepare("DELETE FROM memory_retrieval_log WHERE assistant_id = ?").run(a);
      if (tableExists("proactive_plans")) {
        db.prepare("DELETE FROM proactive_plans WHERE assistant_id = ?").run(a);
      }
      if (tableExists("character_behavior_journal")) {
        db.prepare("DELETE FROM character_behavior_journal WHERE assistant_id = ?").run(a);
      }
      // local_outbox_messages 用 user_id，不限于 assistant；保守不清
      if (args.resetCharacterState) {
        db.prepare("DELETE FROM character_state WHERE assistant_id = ?").run(a);
      }
    } else {
      // 全量模式
      for (const t of DERIVED_TABLES) {
        if (tableExists(t)) {
          db.prepare(`DELETE FROM ${t}`).run();
        }
      }
      if (args.resetCharacterState) {
        db.prepare("DELETE FROM character_state").run();
      }
    }
  });
  tx();
}

// ── Stage 2: replay ingest ──────────────────────────────────────────────────

function replayStage(args) {
  let sql = `SELECT id, assistant_id, session_id, role, content, created_at,
                    tool_calls_json, tool_call_id, tool_name
               FROM conversation_turns`;
  const params = [];
  if (args.assistant) {
    sql += " WHERE assistant_id = ?";
    params.push(args.assistant);
  }
  sql += " ORDER BY assistant_id ASC, session_id ASC, created_at ASC";
  if (args.limit > 0) {
    sql += " LIMIT ?";
    params.push(args.limit);
  }

  const turns = db.prepare(sql).all(...params);
  console.log(`[reinit] stage 2: replay ${turns.length} turns`);

  let userTurns = 0;
  let assistantTurns = 0;
  let logTurns = 0;
  let progressEvery = Math.max(50, Math.floor(turns.length / 20));

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    try {
      const r = ingestInteraction({
        db,
        assistantId: t.assistant_id,
        sessionId: t.session_id,
        role: t.role,
        content: t.content,
        now: t.created_at,
        turnId: t.id,                  // 用原 id，保 idempotent
        toolCallsJson: t.tool_calls_json,
        toolCallId: t.tool_call_id,
        toolName: t.tool_name,
        insertConversationTurn,        // INSERT OR IGNORE，已存在不重写
        insertMemoryItem,
        insertOutboxEvent,
        findMemoryItemBySourceTurnId,
      });
      if (r.logOnly) logTurns += 1;
      else if (t.role === "user") userTurns += 1;
      else if (t.role === "assistant") assistantTurns += 1;
    } catch (e) {
      console.error(`  ingest failed at turn ${t.id.slice(0, 8)} role=${t.role}: ${e.message}`);
    }

    if ((i + 1) % progressEvery === 0) {
      console.log(`  progress: ${i + 1}/${turns.length}`);
    }
  }

  console.log(
    `[reinit] stage 2 done: user=${userTurns} assistant=${assistantTurns} log_only=${logTurns}`
  );
  return { userTurns, assistantTurns, logTurns, total: turns.length };
}

// ── Stage 3: synchronous embed ──────────────────────────────────────────────

async function embedStage(args) {
  let sql = `SELECT id, assistant_id, content FROM memory_items
              WHERE vector_status='pending'`;
  const params = [];
  if (args.assistant) {
    sql += " AND assistant_id = ?";
    params.push(args.assistant);
  }
  sql += " ORDER BY created_at ASC";

  const pending = db.prepare(sql).all(...params);
  console.log(`[reinit] stage 3: embed ${pending.length} pending memory_items`);

  if (!config.embedBaseUrl) {
    console.warn(
      "  WARN: EMBED_BASE_URL is empty; embeddings will use deterministic SHA256 fallback (semantically meaningless)."
    );
  }

  let ok = 0;
  let failed = 0;
  let progressEvery = Math.max(50, Math.floor(pending.length / 20));
  for (let i = 0; i < pending.length; i++) {
    const m = pending[i];
    try {
      const v = await embedText(m.content || "");
      await vectorStore.upsert({ memoryId: m.id, assistantId: m.assistant_id, vector: v });
      db.prepare(
        `UPDATE memory_items
            SET vector_status='ready', vector_provider=?, vector_updated_at=?, updated_at=?
          WHERE id=?`
      ).run(config.vectorProvider, Date.now(), Date.now(), m.id);
      ok += 1;
    } catch (e) {
      failed += 1;
      db.prepare(
        "UPDATE memory_items SET vector_status='embed_failed', updated_at=? WHERE id=?"
      ).run(Date.now(), m.id);
      console.error(`  fail ${m.id.slice(0, 8)}: ${e.message}`);
    }
    if ((i + 1) % progressEvery === 0) {
      console.log(`  progress: ${i + 1}/${pending.length}`);
    }
  }
  console.log(`[reinit] stage 3 done: ok=${ok} failed=${failed}`);
  return { ok, failed };
}

// ── Stage 4: classify + facts ───────────────────────────────────────────────

async function classifyStage(args) {
  const {
    backfillUnclassified,
    backfillMissingFacts,
  } = require("../src/services/memoryClassificationService");

  console.log(`[reinit] stage 4: classify + facts`);

  // 滚动跑直到清空
  let totalClassified = 0;
  let totalFacts = 0;
  while (true) {
    const r = await backfillUnclassified({ limit: 100 });
    totalClassified += r.processed || 0;
    if (!r.scanned || r.scanned === 0) break;
    console.log(`  classify batch: scanned=${r.scanned} processed=${r.processed} llm=${r.llmCalls}`);
    if (r.scanned < 100) break;
  }
  while (true) {
    const r = await backfillMissingFacts({ limit: 50 });
    totalFacts += r.processed || 0;
    if (!r.scanned || r.scanned === 0) break;
    console.log(`  facts batch: scanned=${r.scanned} processed=${r.processed}`);
    if (r.scanned < 50) break;
  }
  console.log(`[reinit] stage 4 done: classified=${totalClassified} fact_rows=${totalFacts}`);
}

// ── Stage 5: auto-pin ───────────────────────────────────────────────────────

function pinStage(args) {
  const { setMemoryPinned } = require("../src/services/memoryEditService");
  const PIN_THRESHOLD = 0.85;
  const PIN_LIMIT = 200;

  const params = [];
  let assistantClause = "";
  if (args.assistant) {
    assistantClause = "AND m.assistant_id = ?";
    params.push(args.assistant);
  }
  params.push(PIN_THRESHOLD, PIN_LIMIT);

  const candidates = db
    .prepare(
      `SELECT m.id, m.assistant_id,
              MAX(f.importance) AS max_importance,
              MAX(f.importance * 0.6 + f.confidence * 0.4) AS max_score
         FROM memory_items m
         JOIN memory_facts f ON f.memory_item_id = m.id
        WHERE m.is_pinned = 0
          ${assistantClause}
        GROUP BY m.id
       HAVING max_importance >= ?
        ORDER BY max_score DESC
        LIMIT ?`
    )
    .all(...params);

  console.log(`[reinit] stage 5: auto-pin candidates: ${candidates.length}`);
  let pinned = 0;
  for (const c of candidates) {
    const r = setMemoryPinned(c.id, true, {
      assistantId: c.assistant_id,
      actor: "system",
      reason: `reinit auto-pin: max_importance=${c.max_importance.toFixed(2)} >= ${PIN_THRESHOLD}`,
    });
    if (r.changed) pinned += 1;
  }
  console.log(`[reinit] stage 5 done: pinned=${pinned}`);
}

// ── Stage 6: character_state replay (opt-in) ────────────────────────────────

function replayCharacterStateStage(args) {
  const { ensureDefaultState, onUserMessage } = require("../src/services/characterStateService");

  const profileSql = args.assistant
    ? "SELECT assistant_id FROM assistant_profile WHERE assistant_id = ?"
    : "SELECT assistant_id FROM assistant_profile";
  const profiles = db.prepare(profileSql).all(...(args.assistant ? [args.assistant] : []));
  console.log(`[reinit] stage 6: reset character_state for ${profiles.length} assistants`);

  for (const p of profiles) {
    ensureDefaultState(p.assistant_id);
    const userTurns = db
      .prepare(
        `SELECT content, created_at FROM conversation_turns
          WHERE assistant_id = ? AND role = 'user'
          ORDER BY created_at ASC`
      )
      .all(p.assistant_id);
    for (const t of userTurns) {
      try {
        onUserMessage(p.assistant_id, { content: t.content, now: t.created_at });
      } catch (e) {
        // 单条失败不阻塞
        console.error(`  ${p.assistant_id.slice(0, 8)} onUserMessage error: ${e.message}`);
      }
    }
    console.log(`  ${p.assistant_id} replayed ${userTurns.length} user turns`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  console.log("[reinit] options:", JSON.stringify(args));

  printInventory(args);

  if (args.dryRun) {
    console.log("[reinit] --dry-run: stopping before any writes.");
    process.exit(0);
  }

  if (!args.yes) {
    const ans = await ask(
      "[reinit] this will WIPE the listed tables and rebuild from conversation_turns. continue? [y/N] "
    );
    if (ans.trim().toLowerCase() !== "y") {
      console.log("[reinit] aborted.");
      process.exit(0);
    }
  }

  const t0 = Date.now();

  console.log("[reinit] stage 1: wipe");
  wipeStage(args);
  console.log("[reinit] stage 1 done");

  replayStage(args);

  if (!args.skipEmbed) {
    await embedStage(args);
  } else {
    console.log("[reinit] stage 3 skipped (--skip-embed)");
  }

  if (!args.skipClassify) {
    await classifyStage(args);
  } else {
    console.log("[reinit] stage 4 skipped (--skip-classify)");
  }

  if (!args.skipPin) {
    pinStage(args);
  } else {
    console.log("[reinit] stage 5 skipped (--skip-pin)");
  }

  if (args.resetCharacterState) {
    replayCharacterStateStage(args);
  }

  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[reinit] all done in ${elapsedSec}s`);

  console.log("\n[reinit] post-build counts:");
  for (const t of ["memory_items", "memory_vectors", "memory_facts", "memory_edges", "outbox_events"]) {
    if (tableExists(t)) {
      console.log(`  ${t.padEnd(20)} ${countRows(t)}`);
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[reinit] fatal:", e.stack || e.message);
    process.exit(1);
  });
}

module.exports = { main };
