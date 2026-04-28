const cron = require("node-cron");
const config = require("./config");
const {
  db,
  upsertCharacterState,
  insertBehaviorJournalEntry,
  listAutoLifeAssistantProfiles,
  listProactiveAssistantProfiles,
  updateAssistantProactiveCheckAt,
  getLastAssistantInteractionAt,
  listLocalSubscriberIds,
  enqueueLocalOutboxMessage,
} = require("./db");
const { sendFcmMessage } = require("./services/fcm");
const { retrieveMemory } = require("./services/memoryRetrievalService");
const { generateWithMemory } = require("./services/langchainQwenService");
const { tryAcquireSchedulerLock } = require("./services/schedulerLockService");
const { generateLifeMemory } = require("./services/lifeMemoryService");
const { runRetentionSweepOnce } = require("./workers/retentionSweeper");
const { runDaily: runIncrBackup } = require("../scripts/backup");
const { runFullBackup } = require("../scripts/full-backup");
const { shouldGenerateProactiveMessage } = require("./services/proactiveMessageDecisionService");
const {
  generatePlans,
  fetchDuePendingPlans,
  markPlanSent,
} = require("./services/proactivePlanService");
const {
  broadcastToUser,
  getActiveSocketCount,
} = require("./ws/connections");
const {
  getTimeBucket,
  shouldTriggerProactive,
  buildProactivePrompt,
  parseQuietHours,
  shouldAllowAutonomousMessage,
} = require("./services/characterEngine");

function pickMessage({ assistantName, timeBucket, familiarity }) {
  // TODO: replace by real LLM generation endpoint.
  const seed = familiarity >= 60 ? "想和你聊聊" : "想问候你一下";
  return `${timeBucket}好，我是${assistantName}，${seed}。`;
}

let didWarnAutoLifeCount = false;
const infoLog = (...args) => {
  if (config.infoLogEnabled) console.log(...args);
};
function noop() {
  return false;
}

function stopIfCancelled(shouldStop) {
  if (shouldStop()) {
    const error = new Error("scheduler_run_preempted");
    error.code = "SCHEDULER_RUN_PREEMPTED";
    throw error;
  }
}

function getAssistantState(assistantId) {
  return (
    db.prepare("SELECT * FROM character_state WHERE assistant_id = ?").get(assistantId) || {
      assistant_id: assistantId,
      familiarity: 0,
      last_user_message_at: null,
      last_proactive_at: null,
    }
  );
}

function warnIfAutoLifeTooMany(profiles = []) {
  if (profiles.length <= 10 || didWarnAutoLifeCount) return;
  didWarnAutoLifeCount = true;
  console.warn(`[scheduler] allowAutoLife assistants exceed 10: current=${profiles.length}`);
}

function resolveMessageCheckIntervalMs(lastInteractionAt, now = Date.now()) {
  if (!lastInteractionAt) return config.autonomousMessageIntervalAfter30dMs;
  const idleMs = now - lastInteractionAt;
  if (idleMs > config.autonomousInactive30dThresholdMs) {
    return config.autonomousMessageIntervalAfter30dMs;
  }
  if (idleMs > config.autonomousInactive7dThresholdMs) {
    return config.autonomousMessageIntervalAfter7dMs;
  }
  return config.autonomousMessageCheckIntervalMs;
}

// Legacy FCM push path (temporarily unused, kept for rollback/debug only).
async function runLegacyFCMProactiveTick() {
  if (!tryAcquireSchedulerLock(config.legacyFcmProactiveLockName)) {
    infoLog("[scheduler] skip tick (leader lock not acquired)");
    return;
  }
  const now = Date.now();
  const timeBucket = getTimeBucket(new Date());
  const characters = db
    .prepare("SELECT * FROM character_state WHERE active_session_id IS NOT NULL AND active_session_id != ''")
    .all();

  for (const state of characters) {
    if (!shouldTriggerProactive(state, now)) continue;
    const tokens = db.prepare("SELECT token FROM push_token").all();
    if (!tokens.length) continue;

    const assistantName = state.assistant_id;
    let message = pickMessage({
      assistantName,
      timeBucket,
      familiarity: state.familiarity || 0,
    });
    const llmPrompt = buildProactivePrompt({
      assistantName,
      familiarity: state.familiarity || 0,
      timeBucket,
    });

    if (config.memoryRetrievalEnabled) {
      try {
        const memories = await retrieveMemory({
          assistantId: state.assistant_id,
          sessionId: state.active_session_id,
          query: `${timeBucket} 主动关心用户`,
          topK: config.retrievalTopK,
        });
        message = await generateWithMemory({
          assistantName,
          userPrompt: llmPrompt,
          memories,
          fallbackText: message,
        });
      } catch (error) {
        console.error("[scheduler] memory retrieval/generation failed:", error.message);
      }
    }

    const insertResult = db.prepare(
      `INSERT INTO proactive_message_log
       (assistant_id, session_id, time_bucket, message, pushed, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`
    ).run(state.assistant_id, state.active_session_id, timeBucket, `${message}\n\n[prompt] ${llmPrompt}`, now);

    for (const item of tokens) {
      try {
        await sendFcmMessage(item.token, {
          title: `${assistantName} 发来新消息`,
          body: message,
          data: {
            type: "character_proactive",
            assistantId: state.assistant_id,
            sessionId: state.active_session_id,
            message,
          },
        });
      } catch (e) {
        console.error("FCM send failed:", e.message);
      }
    }

    db.prepare("UPDATE proactive_message_log SET pushed = 1 WHERE id = ?").run(insertResult.lastInsertRowid);
    upsertCharacterState(state.assistant_id, { last_proactive_at: now });
  }
}

function filterByConfiguredAssistantIds(profiles = [], overrideAssistantIds = null) {
  const ids =
    Array.isArray(overrideAssistantIds) && overrideAssistantIds.length
      ? overrideAssistantIds
      : config.autonomousAssistantIds;
  if (!ids.length) return profiles;
  const wanted = new Set(ids);
  return profiles.filter((item) => wanted.has(item.assistant_id));
}

async function runLifeMemoryTick(options = {}) {
  if (!options.ignoreLock && !tryAcquireSchedulerLock(config.lifeMemoryLockName)) {
    infoLog("[scheduler] skip life tick (leader lock not acquired)");
    return { skippedByLock: true, checked: 0, persisted: 0, skipped: 0, error: 0, dryRun: 0 };
  }

  const shouldStop = typeof options.shouldStop === "function" ? options.shouldStop : noop;
  const dryRun = options.dryRun === true || config.autonomousDryRun === true;
  const now = Date.now();
  const profiles = filterByConfiguredAssistantIds(
    listAutoLifeAssistantProfiles(),
    options.assistantIds
  );
  const stats = { skippedByLock: false, checked: 0, persisted: 0, skipped: 0, error: 0, dryRun: 0 };
  warnIfAutoLifeTooMany(profiles);
  for (const profile of profiles) {
    if (shouldStop()) break;
    stats.checked += 1;
    const state = getAssistantState(profile.assistant_id);
    const sessionId = profile.last_session_id || state.active_session_id || `persona:${profile.assistant_id}`;
    try {
      stopIfCancelled(shouldStop);
      const result = await generateLifeMemory({
        assistantId: profile.assistant_id,
        sessionId,
        state,
        assistantProfile: {
          characterName: profile.character_name,
          characterBackground: profile.character_background,
        },
        now,
        dryRun,
      });
      stopIfCancelled(shouldStop);
      const status = !result.ok
        ? "error"
        : result.dryRun
        ? "dry_run"
        : result.persisted
        ? "persisted"
        : "skipped";
      insertBehaviorJournalEntry({
        runType: "life_tick",
        assistantId: profile.assistant_id,
        sessionId,
        shouldPersist: result.decision.shouldPersist,
        status,
        reason: result.decision.why || result.error || "",
        input: { now, assistantId: profile.assistant_id },
        result: {
          ok: result.ok,
          persisted: result.persisted,
          memoryId: result.memoryId || null,
          decision: result.decision,
        },
        errorMessage: result.error || "",
        createdAt: now,
      });
      if (!result.ok) stats.error += 1;
      else if (result.dryRun) stats.dryRun += 1;
      else if (result.persisted) stats.persisted += 1;
      else stats.skipped += 1;
    } catch (error) {
      if (error && error.code === "SCHEDULER_RUN_PREEMPTED") {
        throw error;
      }
      insertBehaviorJournalEntry({
        runType: "life_tick",
        assistantId: profile.assistant_id,
        sessionId,
        shouldPersist: false,
        status: "error",
        reason: "life_tick_exception",
        input: { now, assistantId: profile.assistant_id },
        result: {},
        errorMessage: error.message,
        createdAt: now,
      });
      console.error("[scheduler] life tick failed:", error.message);
      stats.error += 1;
    }
  }
  return stats;
}

async function runProactiveTick(options = {}) {
  if (!options.ignoreLock && !tryAcquireSchedulerLock(config.proactiveMessageLockName)) {
    infoLog("[scheduler] skip proactive message tick (leader lock not acquired)");
    return {
      skippedByLock: true,
      checked: 0,
      sent: 0,
      dryRun: 0,
      skipped: 0,
      error: 0,
      noSession: 0,
    };
  }

  const shouldStop = typeof options.shouldStop === "function" ? options.shouldStop : noop;
  const dryRun = options.dryRun === true || config.autonomousDryRun === true;
  const now = Date.now();
  const timeBucket = getTimeBucket(new Date(now));
  const quietHours = parseQuietHours(config.autonomousQuietHours);
  const profiles = filterByConfiguredAssistantIds(
    listProactiveAssistantProfiles(),
    options.assistantIds
  );
  const localUserIds = Array.from(
    new Set(listLocalSubscriberIds().map((item) => item.user_id).filter(Boolean))
  );
  const stats = {
    skippedByLock: false,
    checked: 0,
    sent: 0,
    dryRun: 0,
    skipped: 0,
    error: 0,
    noSession: 0,
  };
  const tokens = db.prepare("SELECT token FROM push_token").all();

  for (const profile of profiles) {
    if (shouldStop()) break;
    stats.checked += 1;
    const state = getAssistantState(profile.assistant_id);
    const sessionId = profile.last_session_id || state.active_session_id;
    if (!sessionId) {
      insertBehaviorJournalEntry({
        runType: "proactive_message_tick",
        assistantId: profile.assistant_id,
        sessionId: null,
        shouldPushMessage: false,
        status: "skipped",
        reason: "missing_last_session",
        input: { now, assistantId: profile.assistant_id },
        result: {},
        createdAt: now,
      });
      stats.noSession += 1;
      continue;
    }
    const lastInteractionAt = getLastAssistantInteractionAt(profile.assistant_id) || 0;
    const requiredCheckIntervalMs = resolveMessageCheckIntervalMs(lastInteractionAt, now);
    const lastCheckAt = profile.last_proactive_check_at || 0;
    if (now - lastCheckAt < requiredCheckIntervalMs) {
      stats.skipped += 1;
      continue;
    }
    if (lastInteractionAt > 0 && now - lastInteractionAt < config.autonomousSkipAfterInteractionMs) {
      insertBehaviorJournalEntry({
        runType: "proactive_message_tick",
        assistantId: profile.assistant_id,
        sessionId,
        shouldPushMessage: false,
        status: "skipped",
        reason: "recent_interaction_within_skip_window",
        input: {
          now,
          assistantId: profile.assistant_id,
          lastInteractionAt,
          requiredCheckIntervalMs,
          skipWindowMs: config.autonomousSkipAfterInteractionMs,
        },
        result: {},
        createdAt: now,
      });
      stats.skipped += 1;
      continue;
    }
    if (
      !shouldAllowAutonomousMessage({
        state,
        now,
        minMessageIntervalMs: config.autonomousMinMessageIntervalMs,
        recentUserSilenceMs: config.autonomousRecentUserSilenceMs,
        quietHours,
      })
    ) {
      insertBehaviorJournalEntry({
        runType: "proactive_message_tick",
        assistantId: profile.assistant_id,
        sessionId,
        shouldPushMessage: false,
        status: "skipped",
        reason: "gated_by_engine_rule",
        input: { now, assistantId: profile.assistant_id },
        result: {},
        createdAt: now,
      });
      updateAssistantProactiveCheckAt(profile.assistant_id, now);
      stats.skipped += 1;
      continue;
    }

    stopIfCancelled(shouldStop);
    const decisionResult = await shouldGenerateProactiveMessage({
      assistantId: profile.assistant_id,
      sessionId,
      state,
      assistantProfile: {
        characterName: profile.character_name,
        characterBackground: profile.character_background,
      },
      now,
    });
    stopIfCancelled(shouldStop);
    updateAssistantProactiveCheckAt(profile.assistant_id, now);
    const decision = decisionResult.decision;
    if (!decision.shouldPushMessage) {
      insertBehaviorJournalEntry({
        runType: "proactive_message_tick",
        assistantId: profile.assistant_id,
        sessionId,
        shouldPushMessage: false,
        status: decisionResult.ok ? "skipped" : "error",
        reason: decision.reason,
        messageIntent: decision.messageIntent,
        draftMessage: decision.draft,
        input: { now, assistantId: profile.assistant_id },
        result: { decision, ok: decisionResult.ok },
        errorMessage: decisionResult.error || "",
        createdAt: now,
      });
      if (decisionResult.ok) stats.skipped += 1;
      else stats.error += 1;
      continue;
    }
    if (!config.autonomousPushEnabled) {
      insertBehaviorJournalEntry({
        runType: "proactive_message_tick",
        assistantId: profile.assistant_id,
        sessionId,
        shouldPushMessage: false,
        status: "skipped",
        reason: "push_disabled",
        messageIntent: decision.messageIntent,
        draftMessage: decision.draft,
        input: { now, assistantId: profile.assistant_id },
        result: { decision },
        createdAt: now,
      });
      stats.skipped += 1;
      continue;
    }
    if (!tokens.length) {
      insertBehaviorJournalEntry({
        runType: "proactive_message_tick",
        assistantId: profile.assistant_id,
        sessionId,
        shouldPushMessage: true,
        status: "skipped",
        reason: "no_push_token",
        messageIntent: decision.messageIntent,
        draftMessage: decision.draft,
        input: { now, assistantId: profile.assistant_id },
        result: { decision },
        createdAt: now,
      });
      stats.skipped += 1;
      continue;
    }

    const assistantName = profile.character_name || profile.assistant_id;
    let message =
      (decision.draft || "").trim() ||
      pickMessage({
        assistantName,
        timeBucket,
        familiarity: state.familiarity || 0,
      });
    const llmPrompt = buildProactivePrompt({
      assistantName,
      familiarity: state.familiarity || 0,
      timeBucket,
    });

    if (config.memoryRetrievalEnabled) {
      try {
        const memories = await retrieveMemory({
          assistantId: profile.assistant_id,
          sessionId,
          query: `${timeBucket} ${decision.messageIntent} 主动发起`,
          topK: config.retrievalTopK,
        });
        message = await generateWithMemory({
          assistantName,
          userPrompt: `${llmPrompt}\n意图: ${decision.messageIntent}\n草稿: ${decision.draft || "无"}`,
          memories,
          fallbackText: message,
        });
      } catch (error) {
        if (error && error.code === "SCHEDULER_RUN_PREEMPTED") {
          throw error;
        }
        console.error("[scheduler] proactive message retrieval/generation failed:", error.message);
      }
    }

    if (dryRun) {
      insertBehaviorJournalEntry({
        runType: "proactive_message_tick",
        assistantId: profile.assistant_id,
        sessionId,
        shouldPushMessage: true,
        status: "dry_run",
        reason: decision.reason,
        messageIntent: decision.messageIntent,
        draftMessage: message,
        input: { now, assistantId: profile.assistant_id, dryRun: true },
        result: { decision, finalMessage: message },
        createdAt: now,
      });
      stats.dryRun += 1;
      continue;
    }

    for (const userId of localUserIds) {
      if (shouldStop()) break;
      enqueueLocalOutboxMessage({
        userId,
        assistantId: profile.assistant_id,
        sessionId,
        messageType: "character_proactive",
        title: `${assistantName} 发来新消息`,
        body: message,
        payload: {
          type: "character_proactive",
          assistantId: profile.assistant_id,
          sessionId,
          message,
        },
        availableAt: now,
        expiresAt: now + config.localPullMessageTtlMs,
      });
    }
    stopIfCancelled(shouldStop);

    const insertResult = db
      .prepare(
        `INSERT INTO proactive_message_log
         (assistant_id, session_id, time_bucket, message, pushed, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`
      )
      .run(profile.assistant_id, sessionId, timeBucket, `${message}\n\n[prompt] ${llmPrompt}`, now);
    for (const item of tokens) {
      if (shouldStop()) break;
      try {
        await sendFcmMessage(item.token, {
          title: `${assistantName} 发来新消息`,
          body: message,
          data: {
            type: "character_proactive",
            assistantId: profile.assistant_id,
            sessionId,
            message,
          },
        });
      } catch (error) {
        console.error("FCM send failed:", error.message);
      }
    }
    stopIfCancelled(shouldStop);

    db.prepare("UPDATE proactive_message_log SET pushed = 1 WHERE id = ?").run(insertResult.lastInsertRowid);
    upsertCharacterState(profile.assistant_id, { last_proactive_at: now });
    insertBehaviorJournalEntry({
      runType: "proactive_message_tick",
      assistantId: profile.assistant_id,
      sessionId,
      shouldPushMessage: true,
      status: "sent",
      reason: decision.reason,
      messageIntent: decision.messageIntent,
      draftMessage: message,
      input: { now, assistantId: profile.assistant_id },
      result: { decision, proactiveLogId: insertResult.lastInsertRowid },
      createdAt: now,
    });
    stats.sent += 1;
  }
  return stats;
}

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
    infoLog("[scheduler] weekly full backup done:", result.destPath, result.skipped ? "(skipped)" : "");
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
    const { backfillUnclassified } = require("./services/memoryClassificationService");
    const result = await backfillUnclassified({ limit: 100 });
    if (result.scanned > 0) {
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
  scheduleIfEnabled(config.legacyFcmProactiveCron, "legacy-fcm-proactive", runLegacyFCMProactiveTick);
  // life cron is deprecated by Phase A lazy catchup; honored only if env explicitly set != 'off'.
  scheduleIfEnabled(config.lifeMemoryCron, "life-memory", runLifeMemoryTick);
  // proactive-message cron is deprecated by Phase B plan table; honored only if env explicitly set != 'off'.
  scheduleIfEnabled(config.proactiveMessageCron, "proactive-message", runProactiveTick);
  scheduleIfEnabled(config.retentionSweepCron, "retention-sweep", runRetentionSweepTick);
  scheduleIfEnabled(config.planGenerationCron, "plan-generation", runPlanGenerationTick);
  scheduleIfEnabled(config.backupDailyCron, "backup-daily", runDailyBackupTick);
  scheduleIfEnabled(config.backupWeeklyCron, "backup-weekly", runWeeklyBackupTick);
  scheduleIfEnabled(config.memoryClassifyCron, "memory-classify-backfill", runMemoryClassifyBackfillTick);
  startPlanExecutorLoop();
}

module.exports = {
  startScheduler,
  runLegacyFCMProactiveTick,
  runLifeMemoryTick,
  runProactiveTick,
  runRetentionSweepTick,
  runPlanGenerationTick,
  runPlanExecutorOnce,
  runDailyBackupTick,
  runWeeklyBackupTick,
  runMemoryClassifyBackfillTick,
};
