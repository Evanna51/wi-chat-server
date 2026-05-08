#!/usr/bin/env node
/**
 * seed-character-identities — 给现有 assistant 配 character_identity 行（T-CC-07）
 *
 * 这是 Phase 1 的迁移脚本。两种用法：
 *
 *   1. 最小默认（推荐先跑，零风险幂等）：
 *        node scripts/seed-character-identities.js --all
 *      给所有 assistant_type='character' / '' 的 assistant 调 ensureDefaultIdentity，
 *      只插入 secure_attachment 默认值，不贴具体人格标签。
 *
 *   2. 从 JSON 配置文件加载手工配置：
 *        node scripts/seed-character-identities.js --from data/seeds/identities.json
 *      JSON schema:
 *        [
 *          { "assistantId": "uuid", "fields": { "speakingStyle": "...", "personalityTraits": [...], ... } }
 *        ]
 *
 *   3. --dry-run 加任一模式后只打印不写入。
 *
 * 设计意图：脚本不擅自给用户的真实角色贴标签——character_background 是用户写的 prompt，
 * personality_traits 应该由用户/admin 决定。脚本只保证 schema 完整性。
 */

const fs = require("fs");
const path = require("path");
const { db } = require("../src/db");
const {
  ensureDefaultIdentity,
  upsertIdentity,
  getCharacterIdentity,
} = require("../src/services/character/identityService");

function parseArgs(argv) {
  const args = { all: false, dryRun: false, from: null, includeUntyped: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") args.all = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--from") args.from = argv[++i];
    else if (a === "--include-untyped") args.includeUntyped = true;
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/seed-character-identities.js --all [--include-untyped] [--dry-run]
    幂等给 assistant_type='character' 的 assistant 配最小默认 identity。
    --include-untyped 时也带上 type='' / NULL（旧数据）；默认不带，避免污染 writer/general。

  node scripts/seed-character-identities.js --from <file.json> [--dry-run]
    从 JSON 文件加载手工配置（每条调 upsertIdentity）

JSON schema for --from:
  [{ "assistantId": "uuid", "fields": { "speakingStyle": "...", ... } }, ...]
`);
}

function listSeedTargets({ includeUntyped = false } = {}) {
  // 默认只圈 assistant_type='character'。
  // Phase 1 review fix (P0): 早期没填 assistant_type 的旧数据用 --include-untyped 显式带上，
  // 避免误把 writer/general 类 assistant 配 identity。
  const whereClause = includeUntyped
    ? "WHERE assistant_type IN ('character', '') OR assistant_type IS NULL"
    : "WHERE assistant_type = 'character'";
  return db
    .prepare(
      `SELECT assistant_id, character_name, assistant_type, identity_id
       FROM assistant_profile
       ${whereClause}
       ORDER BY updated_at DESC`
    )
    .all();
}

function runAll({ dryRun, includeUntyped }) {
  const targets = listSeedTargets({ includeUntyped });
  const scope = includeUntyped ? "character + untyped" : "character";
  console.log(`[seed] scope=${scope}, found ${targets.length} assistant(s)`);
  let created = 0;
  let skipped = 0;
  for (const t of targets) {
    const existing = getCharacterIdentity(t.assistant_id);
    if (existing) {
      skipped++;
      console.log(`  ↷ ${t.character_name} (${shortId(t.assistant_id)}) — already has identity_id=${shortId(existing.identityId)}`);
      continue;
    }
    if (dryRun) {
      created++;
      console.log(`  + ${t.character_name} (${shortId(t.assistant_id)}) — would create default identity`);
      continue;
    }
    ensureDefaultIdentity(t.assistant_id);
    created++;
    console.log(`  ✓ ${t.character_name} (${shortId(t.assistant_id)}) — created`);
  }
  console.log(`\n[seed] created: ${created}, skipped: ${skipped}, dryRun=${dryRun}`);
}

function runFromFile(filePath, { dryRun }) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    console.error(`[seed] file not found: ${abs}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(abs, "utf8");
  let configs;
  try {
    configs = JSON.parse(raw);
  } catch (e) {
    console.error(`[seed] invalid JSON: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(configs)) {
    console.error(`[seed] expected JSON array of {assistantId, fields}`);
    process.exit(1);
  }
  console.log(`[seed] processing ${configs.length} entries from ${abs}`);
  let updated = 0;
  let failed = 0;
  for (const cfg of configs) {
    const { assistantId, fields = {} } = cfg || {};
    if (!assistantId) {
      console.warn(`  ! skipped entry without assistantId`);
      failed++;
      continue;
    }
    const profile = db
      .prepare("SELECT character_name FROM assistant_profile WHERE assistant_id = ?")
      .get(assistantId);
    if (!profile) {
      console.warn(`  ! skipped ${shortId(assistantId)} — no assistant_profile`);
      failed++;
      continue;
    }
    if (dryRun) {
      console.log(`  + ${profile.character_name} (${shortId(assistantId)}) — would upsert ${Object.keys(fields).length} fields`);
      updated++;
      continue;
    }
    try {
      const result = upsertIdentity(assistantId, fields);
      console.log(`  ✓ ${profile.character_name} (${shortId(assistantId)}) — version=${result.identityVersion}`);
      updated++;
    } catch (e) {
      console.error(`  ✗ ${profile.character_name} (${shortId(assistantId)}) — ${e.message}`);
      failed++;
    }
  }
  console.log(`\n[seed] updated: ${updated}, failed: ${failed}, dryRun=${dryRun}`);
  if (failed) process.exit(1);
}

function shortId(id) { return id ? id.slice(0, 8) : "(null)"; }

function main() {
  const args = parseArgs(process.argv);
  if (!args.all && !args.from) {
    printHelp();
    process.exit(1);
  }
  if (args.from) runFromFile(args.from, { dryRun: args.dryRun });
  else if (args.all) runAll({ dryRun: args.dryRun, includeUntyped: args.includeUntyped });
}

if (require.main === module) main();
