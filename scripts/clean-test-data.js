/**
 * 清理测试残留的 assistant 数据。
 *
 * 测试用 ID pattern（非 UUID）：t_cc_*, __t*, pron_*, c_split*, no_profile, ctx_*, ...
 * 生产角色 ID 一律是 UUID 形态（8-4-4-4-12 hex）。本脚本删非 UUID 形态的所有
 * assistant 数据 + 跨表 cascade。
 *
 * 默认 dry-run；加 --apply 才真删。
 *
 * 起因：tests/{characterCognition,reflection,narrativeAndTopics}.test.js 的
 * cleanupAll() 用 LIKE `${TS}_%` —— 仅清本进程 TS 的数据。一旦测试中途崩、
 * cleanupAll 没跑、或迁移期间漏覆盖了某些表，就留下脏数据。本脚本是 sweep。
 */

require("dotenv").config();
const Database = require("better-sqlite3");

const apply = process.argv.includes("--apply");

// 测试 ID 白名单 pattern（保守 — 只匹配明确知道的测试前缀；其它一律保留）。
// 来源对照：
//   t_cc_*       → tests/characterCognition.test.js / reflection.test.js makeAid
//   __t*         → tests/reflection.test.js 旧 ref 测试
//   pron_*       → tests/characterCognition.test.js Suite 11 pronouns 测试
//   c_split*     → tests/characterCognition.test.js Suite 10 system segment 测试
//   no_profile*  → tests/characterCognition.test.js review fix 用例
const TEST_ID_PATTERNS = [
  /^t_cc_/,
  /^__t/,
  /^pron_/,
  /^c_split/,
  /^no_profile/,
];

function isTestId(aid) {
  if (!aid) return false;
  return TEST_ID_PATTERNS.some((re) => re.test(aid));
}

const db = new Database("./data/character-behavior.db");

// 1. 找所有匹配测试 pattern 的 assistant_id（覆盖 assistant_profile + 各表）
const seen = new Set();
const tables = [
  "assistant_profile",
  "character_identity",
  "character_state",
  "relationship_state",
  "relationship_event",
  "relationship_reflection",
  "narrative_episode",
  "persistent_topic",
  "memory_items",
  "memory_facts",
  "memory_vectors",
  "memory_edges",
  "memory_audit_log",
  "memory_retrieval_log",
  "character_behavior_journal",
  "proactive_plans",
  "conversation_turns",
  "outbox_events",
  "episode_memory_link",
  "local_outbox_messages",
];

// 不是所有表都有 assistant_id 列；用 pragma 过滤
function hasAssistantIdCol(table) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some((c) => c.name === "assistant_id");
  } catch {
    return false;
  }
}

const tablesWithAid = tables.filter((t) => {
  try {
    db.prepare(`SELECT 1 FROM ${t} LIMIT 1`).get();
    return hasAssistantIdCol(t);
  } catch {
    return false;
  }
});

// 收集所有匹配测试 pattern 的 assistant_id
for (const t of tablesWithAid) {
  const rows = db.prepare(`SELECT DISTINCT assistant_id FROM ${t} WHERE assistant_id IS NOT NULL`).all();
  for (const r of rows) {
    if (isTestId(r.assistant_id)) seen.add(r.assistant_id);
  }
}

const testIds = Array.from(seen).sort();

if (testIds.length === 0) {
  console.log("✓ 没有测试残留数据。");
  process.exit(0);
}

console.log(`找到 ${testIds.length} 个测试残留 assistant_id：\n`);
const byPattern = {};
for (const aid of testIds) {
  let pattern = "其它";
  if (aid.startsWith("t_cc_")) pattern = "t_cc_*（characterCognition / reflection 测试）";
  else if (aid.startsWith("__t")) pattern = "__t*（旧 ref 测试）";
  else if (aid.startsWith("pron_")) pattern = "pron_*（pronouns 测试）";
  else if (aid.startsWith("c_split")) pattern = "c_split*（system segment 测试）";
  else if (aid.startsWith("no_profile")) pattern = "no_profile（无 profile 测试）";
  byPattern[pattern] = byPattern[pattern] || [];
  byPattern[pattern].push(aid);
}
for (const [p, ids] of Object.entries(byPattern)) {
  console.log(`  [${p}] ${ids.length} 条`);
  ids.slice(0, 3).forEach((id) => console.log(`    - ${id}`));
  if (ids.length > 3) console.log(`    - ... (+${ids.length - 3} 更多)`);
}

// 2. 每个表统计衍生 row 数
console.log("\n衍生 row 统计：");
const placeholders = testIds.map(() => "?").join(",");
let totalRows = 0;
for (const t of tablesWithAid) {
  try {
    const r = db.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE assistant_id IN (${placeholders})`).get(...testIds);
    if (r.c > 0) {
      console.log(`  ${t}: ${r.c} rows`);
      totalRows += r.c;
    }
  } catch (e) {
    console.warn(`  ${t}: ERR ${e.message}`);
  }
}
console.log(`\n合计 ${totalRows} rows.`);

// 3. episode_memory_link 单独处理（按 episode_id 关联，不直接有 assistant_id）
let episodeLinkRows = 0;
try {
  const r = db.prepare(
    `SELECT COUNT(*) AS c FROM episode_memory_link WHERE episode_id IN (
       SELECT id FROM narrative_episode WHERE assistant_id IN (${placeholders})
     )`
  ).get(...testIds);
  episodeLinkRows = r.c;
  if (episodeLinkRows > 0) console.log(`+ episode_memory_link (cascade): ${episodeLinkRows} rows`);
} catch {}

if (!apply) {
  console.log("\n--- DRY RUN. 加 --apply 真删 ---");
  process.exit(0);
}

// 4. 真删
console.log("\n开始清理...");
const tx = db.transaction(() => {
  // 先删 episode_memory_link（cascade）
  if (episodeLinkRows > 0) {
    db.prepare(
      `DELETE FROM episode_memory_link WHERE episode_id IN (
         SELECT id FROM narrative_episode WHERE assistant_id IN (${placeholders})
       )`
    ).run(...testIds);
  }
  // 各表按 assistant_id 删
  for (const t of tablesWithAid) {
    try {
      const r = db.prepare(`DELETE FROM ${t} WHERE assistant_id IN (${placeholders})`).run(...testIds);
      if (r.changes > 0) console.log(`  ${t}: -${r.changes}`);
    } catch (e) {
      console.warn(`  ${t}: ERR ${e.message}`);
    }
  }
});
tx();

console.log(`\n✅ 清理完成。${testIds.length} 个测试 assistant + ${totalRows + episodeLinkRows} 衍生 rows 删除。`);
