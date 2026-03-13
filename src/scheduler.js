const cron = require("node-cron");
const config = require("./config");
const { db, upsertCharacterState } = require("./db");
const { sendFcmMessage } = require("./services/fcm");
const { retrieveMemory } = require("./services/memoryRetrievalService");
const { generateWithMemory } = require("./services/langchainQwenService");
const { tryAcquireSchedulerLock } = require("./services/schedulerLockService");
const {
  getTimeBucket,
  shouldTriggerProactive,
  buildProactivePrompt,
} = require("./services/characterEngine");

function pickMessage({ assistantName, timeBucket, familiarity }) {
  // TODO: replace by real LLM generation endpoint.
  const seed = familiarity >= 60 ? "想和你聊聊" : "想问候你一下";
  return `${timeBucket}好，我是${assistantName}，${seed}。`;
}

async function runProactiveTick() {
  if (!tryAcquireSchedulerLock()) {
    console.log("[scheduler] skip tick (leader lock not acquired)");
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

function startScheduler() {
  cron.schedule(
    config.proactiveCron,
    () => {
      runProactiveTick().catch((e) => console.error("proactive tick error:", e));
    },
    { timezone: config.timezone }
  );
  console.log(`[scheduler] proactive cron = ${config.proactiveCron} (${config.timezone})`);
}

module.exports = { startScheduler, runProactiveTick };
