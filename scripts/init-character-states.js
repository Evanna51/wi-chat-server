/**
 * 为所有已有 assistant_profile 的角色补全 character_state 中的情绪/关系字段。
 * 幂等：已有 mood_updated_at 的行跳过。
 *
 * 用法: node scripts/init-character-states.js [--dry-run]
 */
const { db } = require("../src/db");
const { ensureDefaultState } = require("../src/services/characterStateService");

const dryRun = process.argv.includes("--dry-run");

const profiles = db.prepare("SELECT assistant_id, familiarity FROM assistant_profile ap LEFT JOIN character_state cs USING(assistant_id)").all().length
  ? db.prepare(`
      SELECT ap.assistant_id, COALESCE(cs.familiarity, 0) AS familiarity
      FROM assistant_profile ap
      LEFT JOIN character_state cs ON cs.assistant_id = ap.assistant_id
      WHERE cs.mood_updated_at IS NULL OR cs.assistant_id IS NULL
    `).all()
  : [];

if (!profiles.length) {
  console.log("[init-states] 没有需要初始化的 assistant，已全部就绪。");
  process.exit(0);
}

console.log(`[init-states] 找到 ${profiles.length} 个需要初始化的 assistant${dryRun ? "（dry-run，不写入）" : ""}`);

for (const { assistant_id, familiarity } of profiles) {
  console.log(`  ${assistant_id}  familiarity=${familiarity}`);
  if (!dryRun) {
    ensureDefaultState(assistant_id, { familiarityHint: familiarity || 0 });
  }
}

if (!dryRun) {
  console.log("[init-states] 完成。");
}
