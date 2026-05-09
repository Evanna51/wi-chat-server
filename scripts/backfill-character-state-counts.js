#!/usr/bin/env node
/**
 * backfill-character-state-counts — 修正历史 character_state.total_turns / familiarity
 *
 * 问题：T-09 之前 sync 路径不走事件总线，character_state.total_turns 没有累加，
 *       familiarity（= floor(total_turns/3) capped 100）也跟着低估。
 *       本脚本以 conversation_turns 里 role='user' 的实际数量为权威值，重置二者。
 *
 * 用法：
 *   node scripts/backfill-character-state-counts.js --dry-run
 *   node scripts/backfill-character-state-counts.js --apply
 */

const { db } = require("../src/db");
const { ensureDefaultState } = require("../src/services/characterStateService");

function parseArgs(argv) {
  const args = { dryRun: false, apply: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--apply") args.apply = true;
  }
  if (!args.dryRun && !args.apply) {
    console.error("Usage: node scripts/backfill-character-state-counts.js [--dry-run|--apply]");
    process.exit(2);
  }
  return args;
}

function main() {
  const { dryRun, apply } = parseArgs(process.argv);

  // 拉所有 (assistant_id) 在 conversation_turns 里有 user role 的统计
  const rows = db
    .prepare(
      `SELECT assistant_id, COUNT(*) AS user_turn_count, MAX(created_at) AS last_user_at
       FROM conversation_turns
       WHERE role = 'user'
       GROUP BY assistant_id`
    )
    .all();

  console.log(`[backfill] found ${rows.length} assistant(s) with user-role turns`);

  let willUpdate = 0;
  for (const r of rows) {
    const profile = db
      .prepare("SELECT character_name, assistant_type FROM assistant_profile WHERE assistant_id = ?")
      .get(r.assistant_id);
    if (!profile) {
      console.log(`  ↷ ${r.assistant_id.slice(0, 8)} — no assistant_profile, skip`);
      continue;
    }

    ensureDefaultState(r.assistant_id);
    const cur = db
      .prepare("SELECT total_turns, familiarity, last_user_message_at FROM character_state WHERE assistant_id = ?")
      .get(r.assistant_id);

    const newTotal = r.user_turn_count;
    const newFam = Math.min(100, Math.floor(newTotal / 3));
    // 只有当 conversation_turns 的 max(user_at) 比 character_state 里的新（或后者为空）才推进
    const newLastUserAt = !cur?.last_user_message_at || r.last_user_at > cur.last_user_message_at
      ? r.last_user_at
      : cur.last_user_message_at;

    const needUpdate =
      cur.total_turns !== newTotal || cur.familiarity !== newFam || cur.last_user_message_at !== newLastUserAt;

    if (!needUpdate) {
      console.log(`  ✓ ${profile.character_name} (${r.assistant_id.slice(0, 8)}) — already correct: total=${newTotal} fam=${newFam}`);
      continue;
    }

    console.log(
      `  ${dryRun ? "·" : "✎"} ${profile.character_name} (${r.assistant_id.slice(0, 8)}) — ` +
      `total ${cur.total_turns} → ${newTotal}; familiarity ${cur.familiarity} → ${newFam}`
    );
    willUpdate++;

    if (apply) {
      db.prepare(
        `UPDATE character_state
         SET total_turns = ?, familiarity = ?, last_user_message_at = ?, updated_at = ?
         WHERE assistant_id = ?`
      ).run(newTotal, newFam, newLastUserAt, Date.now(), r.assistant_id);
    }
  }

  console.log(`\n[backfill] ${apply ? "updated" : "would update"} ${willUpdate} row(s); dryRun=${dryRun}`);
}

main();
