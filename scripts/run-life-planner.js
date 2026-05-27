#!/usr/bin/env node
/**
 * 手动给某个角色（或所有 allow_auto_life=1 角色）跑今日 life plan。
 *
 * 用法：
 *   node scripts/run-life-planner.js --assistant <id>                  仅这个角色，今日
 *   node scripts/run-life-planner.js --assistant <id> --date 2026-05-24
 *   node scripts/run-life-planner.js --assistant <id> --force           覆盖当日已有 plan（先 expire pending）
 *   node scripts/run-life-planner.js --tick                             触发整轮 cron（所有 active 角色）
 *   node scripts/run-life-planner.js --beat-tick                        手动跑一次 life-beat-tick（处理到点 beat）
 *
 * 设计文档：docs/character-life-beat-plan.md
 */

const path = require("path");

function getArg(flag, fallback = null) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] || fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

require(path.join(__dirname, "..", "src", "db"));

(async () => {
  try {
    if (hasFlag("--beat-tick")) {
      const { runLifeBeatTickOnce } = require(path.join(
        __dirname, "..", "src", "services", "character", "lifeBeatTickService"
      ));
      const r = await runLifeBeatTickOnce();
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    }

    if (hasFlag("--tick")) {
      const { runDailyLifePlanTick } = require(path.join(
        __dirname, "..", "src", "services", "character", "lifePlannerService"
      ));
      const r = await runDailyLifePlanTick();
      console.log(JSON.stringify(r, null, 2));
      process.exit(0);
    }

    const assistantId = getArg("--assistant");
    if (!assistantId) {
      console.error(
        "usage: node scripts/run-life-planner.js --assistant <id> [--date YYYY-MM-DD] [--force]\n" +
          "       node scripts/run-life-planner.js --tick           # 跑整轮 cron\n" +
          "       node scripts/run-life-planner.js --beat-tick      # 手动跑一次 beat tick"
      );
      process.exit(2);
    }
    const planDate = getArg("--date") || null;
    const force = hasFlag("--force");

    const { generateLifePlanFor } = require(path.join(
      __dirname, "..", "src", "services", "character", "lifePlannerService"
    ));
    const r = await generateLifePlanFor({ assistantId, planDate, force });
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  } catch (err) {
    console.error("[life-planner] failed:", err.message);
    console.error(err.stack);
    process.exit(1);
  }
})();
