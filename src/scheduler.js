/**
 * scheduler.js — 当前职责（精简版）
 *
 * 历史包袱已移除（legacy life/proactive cron + FCM proactive tick），现在只负责：
 *
 *   - plan-generation cron     按 PLAN_GENERATION_CRON 生成未来 24h 的 proactive plans
 *   - plan-executor loop       每 N ms 扫到期 plan 派发（WS 在线 → broadcast；离线 → outbox 队列）
 *   - retention-sweep cron     清 outbox / 过期数据
 *   - memory-classify cron     给 user_turn 类记忆分类的 backfill
 *   - daily/weekly backup cron 备份
 *
 * 角色生活记忆改走 client-driven /api/character/catchup（见 catchupService.js）。
 * 主动消息决策改走 plan 表（generatePlans + plan executor）。
 */

const cron = require("node-cron");
const config = require("./config");
const { db, enqueueLocalOutboxMessage } = require("./db");
const { tryAcquireSchedulerLock } = require("./services/schedulerLockService");
const { runRetentionSweepOnce } = require("./workers/retentionSweeper");
const { runDaily: runIncrBackup } = require("../scripts/backup");
const { runFullBackup } = require("../scripts/full-backup");
const {
  generatePlans,
  fetchDuePendingPlans,
  markPlanSent,
} = require("./services/proactivePlanService");
const {
  broadcastToUser,
  getActiveSocketCount,
} = require("./ws/connections");

const infoLog = (...args) => {
  if (config.infoLogEnabled) console.log(...args);
};

function scheduleIfEnabled(cronExpr, label, runner) {
  if (!cronExpr || String(cronExpr).toLowerCase() === "off") {
    infoLog(`[scheduler] ${label} disabled`);
    return;
  }
  let runVersion = 0;
  cron.schedule(
    cronExpr,
    () => {
      runVersion += 1;
      const currentRun = runVersion;
      const shouldStop = () => currentRun !== runVersion;
      runner({ shouldStop }).catch((error) => {
        if (error && error.code === "SCHEDULER_RUN_PREEMPTED") {
          infoLog(`[scheduler] ${label} preempted by newer run`);
          return;
        }
        console.error(`[scheduler] ${label} error:`, error);
      });
    },
    { timezone: config.timezone }
  );
  infoLog(`[scheduler] ${label} cron = ${cronExpr} (${config.timezone})`);
}

async function runDailyBackupTick() {
  if (!tryAcquireSchedulerLock(config.backupDailyLockName)) {
    infoLog("[scheduler] skip daily backup tick (leader lock not acquired)");
    return { skippedByLock: true };
  }
  try {
    const result = await runIncrBackup();
    infoLog("[scheduler] daily backup done:", result.outPath, `${result.totalRows} rows`);
    return result;
  } catch (error) {
    console.error("[scheduler] daily backup failed:", error.message);
    return { error: error.message };
  }
}

async function runWeeklyBackupTick() {
  if (!tryAcquireSchedulerLock(config.backupWeeklyLockName)) {
    infoLog("[scheduler] skip weekly backup tick (leader lock not acquired)");
    return { skippedByLock: true };
  }
  try {
    const result = runFullBackup();
    infoLog(
      "[scheduler] weekly full backup done:",
      result.destPath,
      result.skipped ? "(skipped)" : ""
    );
    return result;
  } catch (error) {
    console.error("[scheduler] weekly full backup failed:", error.message);
    return { error: error.message };
  }
}

async function runRetentionSweepTick() {
  if (!tryAcquireSchedulerLock(config.retentionSweepLockName)) {
    infoLog("[scheduler] skip retention sweep tick (leader lock not acquired)");
    return { skippedByLock: true };
  }
  try {
    const result = await runRetentionSweepOnce();
    infoLog("[scheduler] retention sweep done:", JSON.stringify(result));
    return result;
  } catch (error) {
    console.error("[scheduler] retention sweep failed:", error.message);
    return { error: error.message };
  }
}

async function runMemoryClassifyBackfillTick() {
  if (!tryAcquireSchedulerLock(config.memoryClassifyLockName)) {
    infoLog("[scheduler] skip memory-classify tick (leader lock not acquired)");
    return { skippedByLock: true };
  }
  try {
    const {
      backfillUnclassified,
      backfillMissingFacts,
    } = require("./services/memoryClassificationService");
    // 两阶段，每次 cron 各跑一小批：
    //   阶段 1：未分类的行（含分类 + 抽事实）
    //   阶段 2：已分类但 memory_facts 空的事实型行
    // 单次 cron 总计调 LLM ≤ 50+20 = 70 次（10 分钟跑一次），避免过载
    const classifyResult = await backfillUnclassified({ limit: 50 });
    const factsResult = await backfillMissingFacts({ limit: 20 });
    const result = { classify: classifyResult, facts: factsResult };
    if (
      classifyResult.scanned > 0 ||
      factsResult.scanned > 0
    ) {
      infoLog("[scheduler] memory-classify backfill:", JSON.stringify(result));
    }
    return result;
  } catch (error) {
    console.error("[scheduler] memory-classify backfill failed:", error.message);
    return { error: error.message };
  }
}

async function runPlanGenerationTick() {
  if (!tryAcquireSchedulerLock(config.planGenerationLockName)) {
    infoLog("[scheduler] skip plan-generation tick (leader lock not acquired)");
    return { skippedByLock: true };
  }
  try {
    const result = await generatePlans({});
    infoLog("[scheduler] plan generation done:", JSON.stringify(result));
    return result;
  } catch (error) {
    console.error("[scheduler] plan generation failed:", error.message);
    return { error: error.message };
  }
}

function resolveSessionIdForPlan(plan) {
  try {
    const row = db
      .prepare("SELECT last_session_id FROM assistant_profile WHERE assistant_id = ?")
      .get(plan.assistant_id);
    if (row && row.last_session_id) return row.last_session_id;
  } catch {}
  return `${plan.assistant_id}:proactive`;
}

let planExecutorTimer = null;
async function runPlanExecutorOnce() {
  const now = Date.now();
  let due = [];
  try {
    due = fetchDuePendingPlans(now);
  } catch (e) {
    console.error("[scheduler] plan executor fetch failed:", e.message);
    return { dispatched: 0, viaWs: 0, viaOutbox: 0 };
  }
  if (!due.length) return { dispatched: 0, viaWs: 0, viaOutbox: 0 };
  let dispatched = 0;
  let viaWs = 0;
  let viaOutbox = 0;
  for (const plan of due) {
    try {
      const sessionId = resolveSessionIdForPlan(plan);
      const sockets = getActiveSocketCount(plan.user_id);
      if (sockets > 0) {
        const sent = broadcastToUser(plan.user_id, {
          op: "proactive",
          id: plan.id,
          assistantId: plan.assistant_id,
          sessionId,
          title: plan.draft_title || "",
          body: plan.draft_body,
          messageType: "character_proactive",
          payload: {
            planId: plan.id,
            intent: plan.intent,
            anchorTopic: plan.anchor_topic,
            triggerReason: plan.trigger_reason,
          },
          createdAt: now,
        });
        if (sent > 0) {
          markPlanSent(plan.id, now);
          dispatched += 1;
          viaWs += 1;
          continue;
        }
      }
      enqueueLocalOutboxMessage({
        userId: plan.user_id,
        assistantId: plan.assistant_id,
        sessionId,
        messageType: "character_proactive",
        title: plan.draft_title || "新消息",
        body: plan.draft_body,
        payload: {
          type: "character_proactive",
          assistantId: plan.assistant_id,
          planId: plan.id,
          triggerReason: plan.trigger_reason,
          intent: plan.intent,
          anchorTopic: plan.anchor_topic,
          message: plan.draft_body,
        },
        availableAt: now,
        expiresAt: now + config.localPullMessageTtlMs,
      });
      markPlanSent(plan.id, now);
      dispatched += 1;
      viaOutbox += 1;
    } catch (error) {
      console.error("[scheduler] plan executor dispatch failed:", error.message, plan.id);
    }
  }
  return { dispatched, viaWs, viaOutbox };
}

function startPlanExecutorLoop() {
  if (planExecutorTimer) return;
  const interval = Math.max(5000, Number(config.planExecutorIntervalMs) || 60000);
  planExecutorTimer = setInterval(() => {
    runPlanExecutorOnce().catch((error) => {
      console.error("[scheduler] plan executor loop error:", error.message);
    });
  }, interval);
  if (planExecutorTimer.unref) planExecutorTimer.unref();
  infoLog(`[scheduler] plan-executor interval = ${interval}ms`);
}

function startScheduler() {
  scheduleIfEnabled(config.retentionSweepCron, "retention-sweep", runRetentionSweepTick);
  scheduleIfEnabled(config.planGenerationCron, "plan-generation", runPlanGenerationTick);
  scheduleIfEnabled(config.backupDailyCron, "backup-daily", runDailyBackupTick);
  scheduleIfEnabled(config.backupWeeklyCron, "backup-weekly", runWeeklyBackupTick);
  scheduleIfEnabled(config.memoryClassifyCron, "memory-classify-backfill", runMemoryClassifyBackfillTick);
  startPlanExecutorLoop();
}

module.exports = {
  startScheduler,
  runRetentionSweepTick,
  runPlanGenerationTick,
  runPlanExecutorOnce,
  runDailyBackupTick,
  runWeeklyBackupTick,
  runMemoryClassifyBackfillTick,
};
