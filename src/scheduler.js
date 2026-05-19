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
const {
  db,
  enqueueLocalOutboxMessage,
  insertConversationTurn,
  insertMemoryItem,
  insertOutboxEvent,
  findMemoryItemBySourceTurnId,
} = require("./db");
const { runRetentionSweepOnce } = require("./workers/retentionSweeper");
const { runDaily: runIncrBackup } = require("../scripts/backup");
const { runFullBackup } = require("../scripts/full-backup");
const { ingestInteraction } = require("./services/memoryIngestService");
const {
  generatePlans,
  fetchDuePendingPlans,
  markPlanSent,
  scheduleNextPushPlan,
  runProactiveWatchdogOnce,
  NEXT_PUSH_TRIGGER_REASON,
} = require("./services/proactivePlanService");
const {
  broadcastToUser,
  getActiveSocketCount,
} = require("./ws/connections");

const infoLog = (...args) => {
  if (config.infoLogEnabled) console.log(...args);
};

/**
 * Cron tick wrapper —— 加 leader lock 防多 instance 重复触发。
 *
 * @param {string} cronExpr
 * @param {string} label       内部日志用，也是 lock_name
 * @param {function} runner    async () => {} cron tick 实际工作
 * @param {object} [opts]
 * @param {number} [opts.lockTtlMs=600000]   锁 TTL，默认 10 分钟。需 > 预计 tick 执行
 *                                            时间（带余量），且 < cron 间隔。
 */
function scheduleIfEnabled(cronExpr, label, runner, { lockTtlMs = 10 * 60 * 1000 } = {}) {
  if (!cronExpr || String(cronExpr).toLowerCase() === "off") {
    infoLog(`[scheduler] ${label} disabled`);
    return;
  }
  const { tryAcquireLock, releaseLock } = require("./services/schedulerLock");

  let runVersion = 0;
  cron.schedule(
    cronExpr,
    async () => {
      runVersion += 1;
      const currentRun = runVersion;
      const shouldStop = () => currentRun !== runVersion;

      // Leader lock：抢不到说明其它 instance 在跑（PM2 restart 期 / dev 副本），skip。
      if (!tryAcquireLock(label, lockTtlMs, label)) {
        infoLog(`[scheduler] ${label} lock held by other instance, skip`);
        return;
      }

      try {
        await runner({ shouldStop });
      } catch (error) {
        if (error && error.code === "SCHEDULER_RUN_PREEMPTED") {
          infoLog(`[scheduler] ${label} preempted by newer run`);
        } else {
          console.error(`[scheduler] ${label} error:`, error);
        }
      } finally {
        releaseLock(label, label);
      }
    },
    { timezone: config.timezone }
  );
  infoLog(`[scheduler] ${label} cron = ${cronExpr} (${config.timezone}, lock_ttl=${lockTtlMs}ms)`);
}

async function runDailyBackupTick() {
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
  try {
    const result = await runRetentionSweepOnce();
    infoLog("[scheduler] retention sweep done:", JSON.stringify(result));
    return result;
  } catch (error) {
    console.error("[scheduler] retention sweep failed:", error.message);
    return { error: error.message };
  }
}

async function runEpisodeBuilderTick() {
  // T-CC2-07: 每天扫所有 character 类 assistant，把近 24h+ 未消化的 memory_items
  // 聚合成 narrative_episode。LLM 调用串行，避免 rate limit。
  try {
    const { runEpisodeBuilderTick: build } = require("./services/character/episodeBuilder");
    const result = await build();
    infoLog(`[scheduler] episode builder done: ${result.tickedAssistants} assistants`);
    return result;
  } catch (error) {
    console.error("[scheduler] episode builder failed:", error.message);
    return { error: error.message };
  }
}

async function runTopicDormantSweepTick() {
  // T-CC2-07: 每天扫一次，把 21+ 天未提的 topic 转 dormant
  try {
    const { applyDormantSweep } = require("./services/character/persistentTopicService");
    const result = applyDormantSweep();
    infoLog(`[scheduler] topic dormant sweep: ${result.transitioned}/${result.total} transitioned`);
    return result;
  } catch (error) {
    console.error("[scheduler] topic dormant sweep failed:", error.message);
    return { error: error.message };
  }
}

async function runReflectionTickWeekly() {
  // T-CC3-03: 每周给所有 character 类 assistant 跑 weekly reflection
  try {
    const { runReflectionTickWeekly: tick } = require("./services/character/reflectionService");
    const result = await tick();
    infoLog(`[scheduler] weekly reflection done: ${result.ticked} assistants`);
    return result;
  } catch (error) {
    console.error("[scheduler] weekly reflection failed:", error.message);
    return { error: error.message };
  }
}

async function runMemoryClassifyBackfillTick() {
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

/**
 * T-14：dead-letter 巡检。
 *
 * 每天扫一次过去 24h 入死信的事件数；> 0 就写一条 character_behavior_journal
 * 警告条目（`run_type='dead_letter_alert'`），便于后续 admin / monitoring 看到。
 *
 * 不自动重放——重放需要确认底层依赖修好，由人决定（用 scripts/dead-letter-replay.js）。
 */
async function runDeadLetterMonitorTick() {
  try {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recent = db
      .prepare("SELECT COUNT(*) AS n FROM dead_letter_events WHERE created_at >= ?")
      .get(since);
    const total = db.prepare("SELECT COUNT(*) AS n FROM dead_letter_events").get();
    const result = { recent24h: recent?.n || 0, total: total?.n || 0 };

    if (result.recent24h > 0) {
      console.warn(
        `[scheduler] dead-letter monitor: ${result.recent24h} new in last 24h, ${result.total} total. ` +
          `运行 'node scripts/dead-letter-replay.js' 查看 / 重放。`
      );
      try {
        const { insertBehaviorJournalEntry } = require("./db");
        insertBehaviorJournalEntry({
          runType: "dead_letter_alert",
          assistantId: "_system",
          sessionId: null,
          shouldPushMessage: false,
          status: "alert",
          reason: `${result.recent24h} dead-letter events in last 24h`,
          input: {},
          result,
          createdAt: Date.now(),
        });
      } catch {
        /* journal 写失败不阻塞监控 */
      }
    }
    return result;
  } catch (error) {
    console.error("[scheduler] dead-letter monitor failed:", error.message);
    return { error: error.message };
  }
}

/**
 * Proactive watchdog tick — 周期性给所有 active assistant 重新机会决定要不要主动发。
 * 之前只有 turn.user.batch + plan 派发后会 schedule —— AI 一次 ai_chose_skip 就死链。
 * 详见 src/services/proactivePlanService.js#runProactiveWatchdogOnce
 */
async function runProactiveWatchdogTick() {
  try {
    const result = await runProactiveWatchdogOnce();
    console.log(
      `[proactive-watchdog] scanned=${result.scanned} triggered=${result.triggered} ` +
      `skipped=${JSON.stringify(result.skipped)}`
    );
    return result;
  } catch (err) {
    console.error("[proactive-watchdog] failed:", err.message);
    throw err;
  }
}

async function runPlanGenerationTick() {
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

/**
 * 派发成功后，把 AI 这条主动消息也写进 conversation_turns + memory_items，
 * 让 server 端对话流"看得见"自己说过的话。turnId 直接复用 plan.id（UUID v7，
 * 全局唯一）保证幂等：客户端如果之后再 message_create 同 id 会被 INSERT OR IGNORE 跳过。
 *
 * 不管 WS 派发成功还是只入 outbox，都写——这条 AI 消息已经"决定要说"，next_push
 * 后续 prompt 里"你最近发过的话"必须看得到，避免 LLM 重复同一角度。
 *
 * 不抛错：单条 ingest 失败不应该影响 plan 派发主流程。
 */
function recordProactiveAsTurn(plan, sessionId, now) {
  if (!plan?.draft_body) return null;
  try {
    const result = ingestInteraction({
      db,
      assistantId: plan.assistant_id,
      sessionId,
      role: "assistant",
      content: plan.draft_body,
      now,
      turnId: plan.id, // 用 plan.id 当 turn id 保幂等
      insertConversationTurn,
      insertMemoryItem,
      insertOutboxEvent,
      findMemoryItemBySourceTurnId,
    });
    return result;
  } catch (e) {
    console.error("[scheduler] recordProactiveAsTurn failed:", plan.id, e.message);
    return null;
  }
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
  // 派发完成后哪些 assistant 是 next_push 型，需要立刻 reschedule（option A）
  const nextPushAssistants = new Set();
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
          recordProactiveAsTurn(plan, sessionId, now);
          dispatched += 1;
          viaWs += 1;
          if (plan.trigger_reason === NEXT_PUSH_TRIGGER_REASON) {
            nextPushAssistants.add(plan.assistant_id);
          }
          continue;
        }
      }
      // outbox row id 复用 plan.id —— 与 WS-broadcast 路径保持同一个 frame.id,
      // 与 recordProactiveAsTurn 写入的 conversation_turns.id 也保持一致,
      // 让客户端 turnId == server turnId, message_delete 才能定位到对应 turn.
      enqueueLocalOutboxMessage({
        id: plan.id,
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
      recordProactiveAsTurn(plan, sessionId, now);
      dispatched += 1;
      viaOutbox += 1;
      if (plan.trigger_reason === NEXT_PUSH_TRIGGER_REASON) {
        nextPushAssistants.add(plan.assistant_id);
      }
    } catch (error) {
      console.error("[scheduler] plan executor dispatch failed:", error.message, plan.id);
    }
  }
  // Option A：next_push 派发完后，立刻给同一 assistant 排下一条。
  // AI 自己决定 delayMs，可能 30 min、几小时，也可能直接 skip（"用户在忙"）。
  for (const aid of nextPushAssistants) {
    setImmediate(() => {
      scheduleNextPushPlan({ assistantId: aid }).catch((e) => {
        console.error("[scheduler] post-send scheduleNextPush failed:", aid, e.message);
      });
    });
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
  // ttl 必须 > 预计 tick 执行时间（带余量），且 < cron 间隔。
  // LLM 任务（episode/reflection/plan）需要更长 ttl（4 角色串行 × LLM 30s+）。
  const SHORT_TTL = 5 * 60 * 1000;      // 5 min — 轻量任务（sweep / classify / monitor）
  const MEDIUM_TTL = 30 * 60 * 1000;    // 30 min — backup（VACUUM 大 db）
  const LLM_TTL = 60 * 60 * 1000;       // 1h — LLM 重任务（episode / reflection / plan）

  scheduleIfEnabled(config.retentionSweepCron, "retention-sweep", runRetentionSweepTick, { lockTtlMs: SHORT_TTL });
  scheduleIfEnabled(config.planGenerationCron, "plan-generation", runPlanGenerationTick, { lockTtlMs: LLM_TTL });
  // 2026-05-10: proactive watchdog — 周期性给 AI 重新决定主动消息的机会
  scheduleIfEnabled(
    config.proactiveWatchdogCron || "*/30 * * * *", // 默认每 30 min
    "proactive-watchdog",
    runProactiveWatchdogTick,
    { lockTtlMs: LLM_TTL }
  );
  scheduleIfEnabled(config.backupDailyCron, "backup-daily", runDailyBackupTick, { lockTtlMs: MEDIUM_TTL });
  scheduleIfEnabled(config.backupWeeklyCron, "backup-weekly", runWeeklyBackupTick, { lockTtlMs: MEDIUM_TTL });
  scheduleIfEnabled(config.memoryClassifyCron, "memory-classify-backfill", runMemoryClassifyBackfillTick, { lockTtlMs: SHORT_TTL });
  scheduleIfEnabled(config.deadLetterMonitorCron, "dead-letter-monitor", runDeadLetterMonitorTick, { lockTtlMs: SHORT_TTL });
  // T-CC2-07: Phase 2 narrative + topic 后台维护
  scheduleIfEnabled(config.episodeBuilderCron, "episode-builder", runEpisodeBuilderTick, { lockTtlMs: LLM_TTL });
  scheduleIfEnabled(config.topicDormantSweepCron, "topic-dormant-sweep", runTopicDormantSweepTick, { lockTtlMs: SHORT_TTL });
  // T-CC3-03: Phase 3 weekly reflection
  scheduleIfEnabled(config.reflectionWeeklyCron, "reflection-weekly", runReflectionTickWeekly, { lockTtlMs: LLM_TTL });
  startPlanExecutorLoop();
}

module.exports = {
  startScheduler,
  runRetentionSweepTick,
  runPlanGenerationTick,
  runPlanExecutorOnce,
  runProactiveWatchdogTick,
  runDailyBackupTick,
  runWeeklyBackupTick,
  runMemoryClassifyBackfillTick,
  runDeadLetterMonitorTick,
  runEpisodeBuilderTick,
  runTopicDormantSweepTick,
  runReflectionTickWeekly,
};
