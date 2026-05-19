/**
 * audit-polluted-life-events — 扫 life_event / work_event 里"凭空假设用户偏好"的条目
 *
 * 触发动机：catchupService 自动生成 life_event 时，AI 会编造"我买了你爱吃的 X"
 * 这种把"用户偏好"当事实写进角色行为日志的内容。这些条目会被 proactive push /
 * memory recall 当真，传播虚构事实给 chat LLM。
 *
 * 此脚本：
 *   1. 扫所有 life_event / work_event content
 *   2. 用启发式正则找疑似污染（含"你爱 X / 你喜欢 X / ta 爱 X" 等）
 *   3. 默认 dry-run 列出来；--apply 标 quality_grade='D'
 *
 * 用法：
 *   node scripts/audit-polluted-life-events.js              # dry-run
 *   node scripts/audit-polluted-life-events.js --apply      # 落库
 */

require("dotenv").config();
const Database = require("better-sqlite3");

const DB_PATH = "./data/character-behavior.db";
const APPLY = process.argv.includes("--apply");

// 启发式：含 "你/ta + 爱/喜欢/习惯/最/常" 的连接
// 例：你爱吃的 / 你喜欢看的 / ta 习惯听的 / 你最爱的
// 不会误中：你做了 / 你说过（这些是角色对用户的事实陈述，可以接 fact 验证）
const POLLUTION_PATTERN = /[你][爱喜习最常]|[t][a]\s*[爱喜习最常]/;

const db = new Database(DB_PATH, { readonly: !APPLY });

const rows = db
  .prepare(
    `SELECT id, assistant_id, content, source_turn_id, cite_count, salience, quality_grade
     FROM memory_items
     WHERE memory_type IN ('life_event', 'work_event')
       AND (quality_grade IS NULL OR quality_grade != 'D')`
  )
  .all();

const polluted = rows.filter((r) => POLLUTION_PATTERN.test(r.content || ""));

console.log(`扫描 ${rows.length} 条 life_event/work_event`);
console.log(`疑似污染（凭空假设用户偏好）：${polluted.length}\n`);

if (!polluted.length) {
  console.log("✅ 没有污染，无需处理");
  process.exit(0);
}

// 列详情
const SAFE_PATTERN = /[你][说做发去想问写哭笑了在]/; // 行为/状态描述，不是偏好假设
for (const r of polluted) {
  const safe = SAFE_PATTERN.test(r.content);
  console.log(
    `  ${r.assistant_id.slice(0, 8)} | source=${(r.source_turn_id || "?").split(":")[0]} | cite=${r.cite_count} | ${safe ? "（含安全模式）" : "（强污染）"}`
  );
  console.log(`    ${r.content.slice(0, 100)}`);
}
console.log();

if (!APPLY) {
  console.log(`Dry-run。落库标 quality_grade='D'：node scripts/audit-polluted-life-events.js --apply`);
  process.exit(0);
}

// Apply：标 'D'
const update = db.prepare(
  `UPDATE memory_items SET quality_grade = 'D', updated_at = ? WHERE id = ?`
);
const now = Date.now();
let n = 0;
const tx = db.transaction((items) => {
  for (const item of items) {
    update.run(now, item.id);
    n++;
  }
});
tx(polluted);

console.log(`✅ 已标 ${n} 条为 quality_grade='D'`);
console.log(`下次 retrieveMemory 这些条目会被降权（A=最高 / D=最低）。`);
