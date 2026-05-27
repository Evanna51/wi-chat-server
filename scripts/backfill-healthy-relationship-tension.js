#!/usr/bin/env node
/**
 * 为已有角色批量 / 单独设置 character_identity.tensions.intimacy_vs_independence。
 *
 * 这个 tension 值控制 healthy_relationship 段的话术风格（characterContextBuilder
 * 注入到 system prompt 的 <healthy_relationship> 段）：
 *   ≤ 0.3 → 偏独立（不替 ta 决定 / 不黏人）
 *   0.3-0.6 → 平衡
 *   0.6-0.8 → 偏亲密但留空间
 *   > 0.8   → 极亲密，但越亲密越警惕让 ta 依赖
 *
 * 不管什么值，底线段都一样（不替 ta 决定、推 ta 跟真人聊、不顺从有害请求等）。
 *
 * 用法：
 *   # 预览所有角色当前值（不改 DB）
 *   node scripts/backfill-healthy-relationship-tension.js
 *
 *   # 给所有未设置该 tension 的角色填默认值 0.4（保守偏独立）
 *   node scripts/backfill-healthy-relationship-tension.js --apply
 *
 *   # 用别的默认值
 *   node scripts/backfill-healthy-relationship-tension.js --apply --default 0.5
 *
 *   # 给单个角色精确设值（覆盖现有）
 *   node scripts/backfill-healthy-relationship-tension.js --apply --aid <assistant_id> --value 0.7
 *
 * 设计文档：docs/character-life-beat-plan.md（healthy_relationship 段）
 */

require("dotenv").config();
const Database = require("better-sqlite3");

function getArg(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}
function hasFlag(flag) { return process.argv.includes(flag); }

const APPLY = hasFlag("--apply");
const DEFAULT_VALUE = Number(getArg("--default", "0.4"));
const SINGLE_AID = getArg("--aid", null);
const SINGLE_VALUE = getArg("--value", null);

if (!Number.isFinite(DEFAULT_VALUE) || DEFAULT_VALUE < 0 || DEFAULT_VALUE > 1) {
  console.error(`--default 必须是 0-1 之间的数（got ${DEFAULT_VALUE}）`);
  process.exit(2);
}
if (SINGLE_AID && SINGLE_VALUE != null) {
  const v = Number(SINGLE_VALUE);
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    console.error(`--value 必须是 0-1 之间的数（got ${SINGLE_VALUE}）`);
    process.exit(2);
  }
}

const DB_PATH = process.env.DATABASE_PATH || "./data/character-behavior.db";
const db = new Database(DB_PATH);

const rows = db.prepare(
  `SELECT i.assistant_id, i.tensions_json, p.character_name
     FROM character_identity i
     LEFT JOIN assistant_profile p ON p.assistant_id = i.assistant_id
     ORDER BY p.character_name COLLATE NOCASE`
).all();

if (!rows.length) {
  console.log("character_identity 表为空，没有角色可处理。");
  process.exit(0);
}

function parseTensions(raw) {
  try {
    const t = JSON.parse(raw || "{}");
    return (t && typeof t === "object" && !Array.isArray(t)) ? t : {};
  } catch { return {}; }
}

function describeValue(v) {
  if (v == null) return "（未设）";
  if (v <= 0.3) return `${v.toFixed(2)} 偏独立`;
  if (v <= 0.6) return `${v.toFixed(2)} 平衡`;
  if (v <= 0.8) return `${v.toFixed(2)} 偏亲密`;
  return `${v.toFixed(2)} 极亲密`;
}

// ── 单角色精确设置模式 ──────────────────────────────────────────────
if (SINGLE_AID && SINGLE_VALUE != null) {
  const row = rows.find((r) => r.assistant_id === SINGLE_AID);
  if (!row) {
    console.error(`找不到 assistant_id=${SINGLE_AID} 的 character_identity 行。`);
    process.exit(1);
  }
  const tensions = parseTensions(row.tensions_json);
  const before = tensions.intimacy_vs_independence;
  const after = Number(SINGLE_VALUE);
  tensions.intimacy_vs_independence = after;
  console.log(`\n[${row.character_name || "(unnamed)"}] ${SINGLE_AID}`);
  console.log(`  before: ${describeValue(before)}`);
  console.log(`  after:  ${describeValue(after)}`);

  if (APPLY) {
    db.prepare(
      "UPDATE character_identity SET tensions_json = ?, updated_at = ? WHERE assistant_id = ?"
    ).run(JSON.stringify(tensions), Date.now(), SINGLE_AID);
    console.log("  ✓ 已落库");
  } else {
    console.log("  (dry-run，加 --apply 才写库)");
  }
  process.exit(0);
}

// ── 批量预览 / 填默认值模式 ─────────────────────────────────────────
console.log(`\n共 ${rows.length} 个角色。默认填充值 = ${describeValue(DEFAULT_VALUE)}\n`);
console.log("当前状态：");
console.log("─".repeat(70));

const toFill = [];
for (const row of rows) {
  const tensions = parseTensions(row.tensions_json);
  const v = tensions.intimacy_vs_independence;
  const name = (row.character_name || "(unnamed)").padEnd(20);
  const aidShort = row.assistant_id.length > 12
    ? row.assistant_id.slice(0, 8) + "..." + row.assistant_id.slice(-4)
    : row.assistant_id;
  if (v == null) {
    console.log(`  ${name} ${aidShort.padEnd(16)}  ${describeValue(v)}  → 将填 ${DEFAULT_VALUE}`);
    toFill.push({ aid: row.assistant_id, tensions });
  } else {
    console.log(`  ${name} ${aidShort.padEnd(16)}  ${describeValue(v)}  (跳过)`);
  }
}
console.log("─".repeat(70));
console.log(`\n${toFill.length} 个角色需要填充，${rows.length - toFill.length} 个已有值。`);

if (!APPLY) {
  console.log("\n(dry-run，加 --apply 才写库)");
  console.log("\n如果想给某个角色精确设值：");
  console.log("  node scripts/backfill-healthy-relationship-tension.js --apply --aid <id> --value <0-1>");
  process.exit(0);
}

if (!toFill.length) {
  console.log("\n所有角色已有 tension 值，无需填充。");
  process.exit(0);
}

let updated = 0;
const upd = db.prepare(
  "UPDATE character_identity SET tensions_json = ?, updated_at = ? WHERE assistant_id = ?"
);
const tx = db.transaction((items) => {
  for (const it of items) {
    it.tensions.intimacy_vs_independence = DEFAULT_VALUE;
    upd.run(JSON.stringify(it.tensions), Date.now(), it.aid);
    updated += 1;
  }
});
tx(toFill);

console.log(`\n✓ 已为 ${updated} 个角色填充 intimacy_vs_independence = ${DEFAULT_VALUE}`);
console.log("\n之后可以单独覆盖某个角色：");
console.log("  node scripts/backfill-healthy-relationship-tension.js --apply --aid <id> --value <0-1>");
