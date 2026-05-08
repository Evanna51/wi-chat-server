#!/usr/bin/env node
/**
 * dead-letter-replay.js — 把 dead_letter_events 行重放回 outbox_events 让 indexer 再跑。
 *
 * 何时跑：
 *   - LM Studio / embed endpoint 长时间挂掉 → 一批 outbox 重试 max → 进死信
 *   - 修好底层依赖后用此脚本 replay，不需要重发原始 sync push
 *
 * 用法：
 *   node scripts/dead-letter-replay.js                    # 列出全部死信，不重放（dry-run 默认）
 *   node scripts/dead-letter-replay.js --apply            # 重放全部死信
 *   node scripts/dead-letter-replay.js --apply --since 24h  # 仅重放最近 24h 内入死信的
 *   node scripts/dead-letter-replay.js --apply --id <dlid>  # 重放某一条死信
 *   node scripts/dead-letter-replay.js --purge            # 清掉对应 outbox_events.status='dead' 的行
 *
 * 工作流（每条死信）：
 *   1. 找 outbox_events.id = source_event_id 的行
 *   2. UPDATE → status='pending', retry_count=0, next_retry_at=NULL, last_error=NULL
 *   3. DELETE dead_letter_events 该行（不留)
 *   4. indexer 下一轮 fetchPendingEvents 自然拿到
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { db } = require("../src/db");

function parseArgs() {
  const out = { apply: false, sinceMs: null, id: null, purge: false };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--purge") out.purge = true;
    else if (a === "--id") out.id = args[++i];
    else if (a === "--since") out.sinceMs = parseSince(args[++i]);
  }
  return out;
}

function parseSince(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d+)([hdm])$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === "h" ? 3600_000 : unit === "d" ? 86400_000 : 60_000;
  return Date.now() - n * mult;
}

function listDeadLetters({ sinceMs, id }) {
  const params = [];
  let where = "1=1";
  if (id) {
    where += " AND id = ?";
    params.push(id);
  }
  if (sinceMs) {
    where += " AND created_at >= ?";
    params.push(sinceMs);
  }
  return db.prepare(`SELECT * FROM dead_letter_events WHERE ${where} ORDER BY created_at DESC`).all(...params);
}

function replayOne(deadRow) {
  const tx = db.transaction(() => {
    const updated = db
      .prepare(
        `UPDATE outbox_events
            SET status='pending',
                retry_count=0,
                next_retry_at=NULL,
                last_error=NULL,
                updated_at=?
          WHERE id=?`
      )
      .run(Date.now(), deadRow.source_event_id).changes;
    db.prepare("DELETE FROM dead_letter_events WHERE id=?").run(deadRow.id);
    return updated;
  });
  return tx();
}

function purgeDeadOutbox() {
  return db.prepare("DELETE FROM outbox_events WHERE status='dead'").run().changes;
}

function main() {
  const args = parseArgs();
  console.log("[dead-letter-replay] options:", JSON.stringify(args));

  if (args.purge) {
    const n = purgeDeadOutbox();
    console.log(`[dead-letter-replay] purged ${n} outbox_events.status='dead' rows`);
    return;
  }

  const rows = listDeadLetters(args);
  console.log(`[dead-letter-replay] found ${rows.length} dead letter rows`);

  if (rows.length === 0) {
    console.log("[dead-letter-replay] nothing to replay.");
    return;
  }

  if (!args.apply) {
    console.log("[dead-letter-replay] dry-run only. pass --apply to replay.");
    rows.slice(0, 10).forEach((r) => {
      console.log(
        `  - id=${r.id.slice(0, 8)} src=${r.source_event_id.slice(0, 8)} reason=${(r.reason || "").slice(0, 80)}`
      );
    });
    return;
  }

  let ok = 0;
  let missing = 0;
  for (const r of rows) {
    const updated = replayOne(r);
    if (updated > 0) ok += 1;
    else missing += 1;
  }
  console.log(`[dead-letter-replay] applied: replayed=${ok} source-missing=${missing}`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("[dead-letter-replay] fatal:", e.stack || e.message);
    process.exit(1);
  }
}

module.exports = { listDeadLetters, replayOne };
