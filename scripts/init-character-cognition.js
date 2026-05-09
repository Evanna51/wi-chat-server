#!/usr/bin/env node
/**
 * init-character-cognition — 给 character 类 assistant 初始化认知层数据。
 *
 * 4 张表的初始化路径：
 *   - relationship_state         零成本：调 ensureRelationshipState() 写空白行（baselines 由 identity 派生）
 *   - narrative_episode + topics LLM 调用：buildEpisodesFor()，按 30 天窗口聚合 memory_items
 *   - relationship_reflection    LLM 调用：reflectFor() weekly synthesis
 *
 * 默认只做零成本部分（dynamics）。--with-llm 才跑 episode 和 reflection。
 *
 * 用法：
 *   node scripts/init-character-cognition.js --all                # 仅 dynamics
 *   node scripts/init-character-cognition.js --all --with-llm     # 全部
 *   node scripts/init-character-cognition.js --assistant <id> --with-llm
 *   node scripts/init-character-cognition.js --all --dry-run
 */

const { db } = require("../src/db");
const { ensureRelationshipState } = require("../src/services/character/relationshipDynamicsService");
const { buildEpisodesFor } = require("../src/services/character/episodeBuilder");
const { reflectFor } = require("../src/services/character/reflectionService");

function parseArgs(argv) {
  const args = { all: false, withLlm: false, assistant: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") args.all = true;
    else if (a === "--with-llm") args.withLlm = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--assistant") args.assistant = argv[++i];
    else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  }
  if (!args.all && !args.assistant) {
    console.error("Usage: --all | --assistant <id>  [--with-llm] [--dry-run]");
    process.exit(2);
  }
  return args;
}
function printHelp() {
  console.log(`
init-character-cognition

  --all                给所有 assistant_type='character' 跑
  --assistant <id>     仅跑一个 assistant
  --with-llm           额外跑 episodes + reflection（要 LLM，慢，会消耗 token）
  --dry-run            只打印计划，不写库

零成本路径（默认即跑）：
  ensureRelationshipState 写一条 12 维 baseline 到 relationship_state。

LLM 路径（--with-llm 才跑）：
  buildEpisodesFor   30 天窗口聚合 memory_items 成 narrative_episode + 识别 topics
  reflectFor         给当前关系状态写一段 reflection

LLM 失败不抛错，cron 模式 — 单个 assistant 失败不影响下一个。
`);
}

function listTargets({ all, assistant }) {
  if (assistant) {
    const row = db
      .prepare("SELECT assistant_id, character_name, assistant_type FROM assistant_profile WHERE assistant_id = ?")
      .get(assistant);
    return row ? [row] : [];
  }
  return db
    .prepare(
      "SELECT assistant_id, character_name, assistant_type FROM assistant_profile WHERE assistant_type = 'character'"
    )
    .all();
}

async function processOne(target, { withLlm, dryRun }) {
  const id = target.assistant_id;
  const name = target.character_name;
  const log = (msg) => console.log(`  [${name}] ${msg}`);

  // 1) dynamics
  const hasDyn = !!db.prepare("SELECT 1 FROM relationship_state WHERE assistant_id = ?").get(id);
  if (hasDyn) {
    log("dynamics: ✓ 已存在");
  } else if (dryRun) {
    log("dynamics: + 将创建 baseline");
  } else {
    ensureRelationshipState(id);
    log("dynamics: ✓ 已创建");
  }

  if (!withLlm) return;

  // 2) episodes
  if (dryRun) {
    log("episodes: + 将调 LLM 构建（30d 窗口）");
  } else {
    log("episodes: 调 LLM 中...");
    try {
      const r = await buildEpisodesFor(id, { source: "init_script" });
      if (r.skipped) {
        log(`episodes: skipped (${r.reason})`);
      } else {
        log(`episodes: ✓ inserted ${r.episodesInserted || 0}, topicsInserted ${r.newTopicsInserted || 0}`);
      }
    } catch (err) {
      log(`episodes: ✗ ${err.message}`);
    }
  }

  // 3) reflection
  if (dryRun) {
    log("reflection: + 将调 LLM 生成 manual reflection");
  } else {
    log("reflection: 调 LLM 中...");
    try {
      const r = await reflectFor(id, { reflectionType: "manual", triggerReason: "init_script" });
      if (r.skipped) {
        log(`reflection: skipped (${r.reason})`);
      } else {
        log(`reflection: ✓ id=${r.reflectionId?.slice(0, 8)} direction=${r.relationshipDirection}`);
      }
    } catch (err) {
      log(`reflection: ✗ ${err.message}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const targets = listTargets(args);
  if (!targets.length) {
    console.error("[init] no matching assistants");
    process.exit(1);
  }
  console.log(`[init] processing ${targets.length} assistant(s); withLlm=${args.withLlm}; dryRun=${args.dryRun}`);
  for (const t of targets) {
    console.log(`\n→ ${t.character_name} (${t.assistant_id.slice(0, 8)})`);
    await processOne(t, args);
  }
  console.log("\n[init] done");
  process.exit(0);
}

main().catch((e) => {
  console.error("[init] fatal:", e);
  process.exit(1);
});
