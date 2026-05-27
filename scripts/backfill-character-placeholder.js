#!/usr/bin/env node
/**
 * Backfill memory_facts.fact_value：把历史角色名替换成 `{角色}` 占位符。
 *
 * 2026-05-24：memoryClassificationService 改为存储占位符（见 src/utils/characterPlaceholder.js），
 * 但库里旧数据还是写死的角色名。本脚本一次性扫历史数据，按 assistant_id 找出对应的
 * character_name，把 fact_value 里的真名替换成占位符。
 *
 * **默认 dry-run**。看打印没问题再加 --apply 真改。
 *
 * Usage:
 *   node scripts/backfill-character-placeholder.js              # dry-run，只预览
 *   node scripts/backfill-character-placeholder.js --apply      # 真实修改
 *   node scripts/backfill-character-placeholder.js --assistantId=<id>  # 只跑单个角色
 *   node scripts/backfill-character-placeholder.js --verbose    # 打印每条变更
 */

require("dotenv").config();
const { db } = require("../src/db");
const { normalizeToPlaceholder } = require("../src/utils/characterPlaceholder");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const VERBOSE = args.includes("--verbose");
const ONLY_ID = args.find((a) => a.startsWith("--assistantId="))?.split("=")[1];

function main() {
  const profileRows = db
    .prepare(
      `SELECT assistant_id, character_name FROM assistant_profile
        WHERE character_name IS NOT NULL AND length(character_name) >= 2`
    )
    .all();

  const targetProfiles = ONLY_ID
    ? profileRows.filter((p) => p.assistant_id === ONLY_ID)
    : profileRows;

  if (!targetProfiles.length) {
    console.log("无可处理 profile（或 --assistantId 未命中）");
    return;
  }

  console.log(`扫描 ${targetProfiles.length} 个 profile${APPLY ? "（真实修改模式）" : "（DRY-RUN）"}`);

  let totalScanned = 0;
  let totalChanged = 0;
  const perAssistant = [];

  const updateStmt = db.prepare(
    `UPDATE memory_facts SET fact_value = ? WHERE id = ?`
  );

  for (const p of targetProfiles) {
    const rows = db
      .prepare(`SELECT id, fact_key, fact_value FROM memory_facts WHERE assistant_id = ?`)
      .all(p.assistant_id);
    totalScanned += rows.length;

    const changes = [];
    for (const r of rows) {
      const normalized = normalizeToPlaceholder(r.fact_value, p.character_name);
      if (normalized !== r.fact_value) {
        changes.push({ id: r.id, key: r.fact_key, before: r.fact_value, after: normalized });
      }
    }

    if (!changes.length) continue;
    totalChanged += changes.length;
    perAssistant.push({ assistantId: p.assistant_id, characterName: p.character_name, count: changes.length });

    if (VERBOSE) {
      console.log(`\n── ${p.character_name} (${p.assistant_id}) ${changes.length} 处 ──`);
      for (const c of changes) {
        console.log(`  [${c.key}]`);
        console.log(`    旧: ${c.before}`);
        console.log(`    新: ${c.after}`);
      }
    }

    if (APPLY) {
      const tx = db.transaction(() => {
        for (const c of changes) updateStmt.run(c.after, c.id);
      });
      tx();
    }
  }

  console.log("\n────────────────────────────────────────");
  console.log(`扫了 ${totalScanned} 条 fact，命中 ${totalChanged} 条需要替换`);
  if (perAssistant.length) {
    console.log("分布：");
    for (const a of perAssistant.sort((a, b) => b.count - a.count)) {
      console.log(`  - ${a.characterName.padEnd(12)} ${a.count} 条   (${a.assistantId})`);
    }
  }
  if (APPLY) {
    console.log("\n✅ 已落库。");
  } else {
    console.log("\n⚠️ DRY-RUN，未修改库。看着对就加 --apply 跑一次。");
  }
}

try { main(); } catch (e) {
  console.error("backfill 失败:", e.message);
  process.exit(1);
}
