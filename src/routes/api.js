const express = require("express");
const { z } = require("zod");
const {
  db,
  upsertCharacterState,
  insertConversationTurn,
  insertMemoryItem,
  insertOutboxEvent,
  upsertAssistantProfile,
  countAllowAutoLifeAssistants,
  updateAssistantLastSession,
  upsertLocalSubscriber,
  pullPendingMessagesForUser,
  ackPulledMessage,
  withTransaction,
  searchConversation,
  searchMemory,
  findMemoryItemBySourceTurnId,
} = require("../db");
const { ingestInteraction } = require("../services/memoryIngestService");
const { retrieveMemory } = require("../services/memoryRetrievalService");
const { generateWithMemory } = require("../services/langchainQwenService");
const {
  shouldRetrieveMemory,
  formatMemoryLines,
  buildMemoryGuidance,
} = require("../services/memoryDecisionService");
const { runCatchup } = require("../services/catchupService");
const { onUserMessage: onUserMessageState, ensureDefaultState } = require("../services/characterStateService");
const {
  generatePlans,
  listPendingPlans,
  listPlansByStatus,
  cancelPlanById,
  cancelPendingPlansForAssistant,
  findPlanById,
} = require("../services/proactivePlanService");
const config = require("../config");

const router = express.Router();
let didWarnAutoLifeCount = false;

const authMiddleware = (req, res, next) => {
  if (!config.requireApiKey) return next();
  const required = config.appApiKey;
  const provided = req.header("x-api-key");
  if (!provided || provided !== required) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
};

router.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

router.post("/register-push-token", authMiddleware, (req, res) => {
  const schema = z.object({
    userId: z.string().min(1),
    token: z.string().min(10),
    platform: z.string().default("android"),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { userId, token, platform } = parsed.data;
  db.prepare(
    "INSERT OR IGNORE INTO push_token (user_id, token, platform, created_at) VALUES (?, ?, ?, ?)"
  ).run(userId, token, platform, Date.now());
  res.json({ ok: true });
});

router.post("/assistant-profile/upsert", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    characterName: z.string().min(1),
    characterBackground: z.string().default(""),
    allowAutoLife: z.boolean(),
    allowProactiveMessage: z.boolean(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const {
    assistantId,
    characterName,
    characterBackground,
    allowAutoLife,
    allowProactiveMessage,
  } = parsed.data;

  const row = upsertAssistantProfile({
    assistantId,
    characterName,
    characterBackground,
    allowAutoLife,
    allowProactiveMessage,
  });

  const autoLifeCount = countAllowAutoLifeAssistants();
  if (autoLifeCount > 10 && !didWarnAutoLifeCount) {
    didWarnAutoLifeCount = true;
    console.warn(
      `[assistant-profile] allowAutoLife assistants exceed 10: current=${autoLifeCount}`
    );
  }

  res.json({
    ok: true,
    profile: {
      assistantId: row.assistant_id,
      characterName: row.character_name,
      characterBackground: row.character_background,
      allowAutoLife: row.allow_auto_life === 1,
      allowProactiveMessage: row.allow_proactive_message === 1,
      lastSessionId: row.last_session_id || null,
      lastProactiveCheckAt: row.last_proactive_check_at || null,
      updatedAt: row.updated_at,
    },
    autoLifeCount,
  });
});

router.post("/register-local-inbox", authMiddleware, (req, res) => {
  const schema = z.object({
    userId: z.string().min(1),
    deviceId: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const row = upsertLocalSubscriber({
    userId: parsed.data.userId,
    deviceId: parsed.data.deviceId || "",
  });
  res.json({
    ok: true,
    subscriber: {
      userId: row.user_id,
      deviceId: row.device_id || "",
      updatedAt: row.updated_at,
    },
  });
});

router.get("/pull-messages", authMiddleware, (req, res) => {
  const schema = z.object({
    userId: z.string().trim().min(1).optional(),
    since: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().positive().max(100).default(20),
  });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { since, limit } = parsed.data;
  let userId = parsed.data.userId || String(req.header("x-user-id") || "").trim();
  if (!userId) {
    const subscribers = db
      .prepare("SELECT user_id FROM local_subscribers ORDER BY updated_at DESC LIMIT 2")
      .all();
    if (subscribers.length === 1) {
      userId = subscribers[0].user_id;
    } else {
      return res.status(400).json({
        ok: false,
        error: "missing_user_id: provide query userId or header x-user-id",
      });
    }
  }
  const now = Date.now();
  const rows = pullPendingMessagesForUser({
    userId,
    since,
    limit,
    now,
    repullGapMs: config.localPullRepullGapMs,
  });
  res.json({
    ok: true,
    userId,
    since,
    count: rows.length,
    messages: rows.map((item) => ({
      id: item.id,
      assistantId: item.assistant_id,
      sessionId: item.session_id,
      messageType: item.message_type,
      title: item.title,
      body: item.body,
      payload: JSON.parse(item.payload_json || "{}"),
      createdAt: item.created_at,
      availableAt: item.available_at,
      expiresAt: item.expires_at,
      pullCount: item.pull_count + 1,
    })),
    now,
  });
});

router.post("/ack-message", authMiddleware, (req, res) => {
  const schema = z.object({
    userId: z.string().min(1),
    messageId: z.string().min(1),
    ackStatus: z.string().default("received"),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const ok = ackPulledMessage(parsed.data);
  if (!ok) {
    return res.status(404).json({ ok: false, error: "message_not_found_or_user_mismatch" });
  }
  return res.json({ ok: true, messageId: parsed.data.messageId, ackStatus: parsed.data.ackStatus });
});

router.post("/report-interaction", authMiddleware, (req, res) => {
  res.setHeader("Deprecation", "true");
  res.setHeader("Sunset", "Thu, 01 Apr 2027 00:00:00 GMT");
  const schema = z.object({
    assistantId: z.string().min(1),
    sessionId: z.string().min(1),
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, sessionId, role, content } = parsed.data;
  const now = Date.now();
  const current = db.prepare("SELECT * FROM character_state WHERE assistant_id = ?").get(assistantId) || {};
  const totalTurns = (current.total_turns || 0) + (role === "user" ? 1 : 0);
  const familiarity = Math.min(100, Math.floor(totalTurns / 3));

  withTransaction(() => {
    ingestInteraction({
      db,
      assistantId,
      sessionId,
      role,
      content,
      now,
      insertConversationTurn,
      insertMemoryItem,
      insertOutboxEvent,
      findMemoryItemBySourceTurnId,
    });
    upsertCharacterState(assistantId, {
      active_session_id: sessionId,
      total_turns: totalTurns,
      familiarity,
      last_user_message_at: role === "user" ? now : current.last_user_message_at || null,
    });
    updateAssistantLastSession(assistantId, sessionId);
  });
  if (role === "user") {
    try {
      onUserMessageState(assistantId, { content, now });
    } catch (e) {
      // non-critical: don't fail the request if state update errors
    }
  }

  let cancelledPlans = 0;
  if (role === "user") {
    try {
      cancelledPlans = cancelPendingPlansForAssistant(assistantId, "user_active");
    } catch (e) {
      cancelledPlans = 0;
    }
  }
  res.json({ ok: true, familiarity, totalTurns, cancelledPlans });
});

router.post("/chat-with-memory", authMiddleware, async (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    sessionId: z.string().min(1),
    userInput: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, sessionId, userInput } = parsed.data;

  if (!config.memoryRetrievalEnabled) {
    return res.json({ ok: true, answer: "记忆检索已关闭。", memories: [] });
  }

  try {
    const memories = await retrieveMemory({
      assistantId,
      sessionId,
      query: userInput,
      topK: config.retrievalTopK,
    });
    const answer = await generateWithMemory({
      assistantName: assistantId,
      userPrompt: userInput,
      memories,
      fallbackText: "我记下了，我们继续聊聊。",
    });
    return res.json({
      ok: true,
      answer,
      memories: memories.map((item) => ({ id: item.id, score: item.score })),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post("/tool/memory-context", authMiddleware, async (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    sessionId: z.string().min(1),
    userInput: z.string().min(1),
    topK: z.number().int().positive().max(20).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });

  const { assistantId, sessionId, userInput, topK } = parsed.data;
  const decision = await shouldRetrieveMemory({ userInput });
  if (!config.memoryRetrievalEnabled) {
    return res.json({
      ok: true,
      shouldRetrieve: false,
      intent: "small_talk",
      reason: "memory_retrieval_disabled",
      decisionSource: "system",
      memoryLines: [],
    });
  }

  if (!decision.shouldRetrieve) {
    return res.json({
      ok: true,
      shouldRetrieve: false,
      intent: decision.intent || "small_talk",
      reason: decision.reason,
      decisionSource: decision.source,
      memoryLines: [],
    });
  }

  try {
    const memories = await retrieveMemory({
      assistantId,
      sessionId,
      query: decision.query || userInput,
      topK: topK || config.retrievalTopK,
    });
    const memoryLines = formatMemoryLines(memories);
    const memoryGuidance = buildMemoryGuidance(memoryLines);
    return res.json({
      ok: true,
      shouldRetrieve: true,
      intent: decision.intent || "fact_query",
      reason: decision.reason,
      decisionSource: decision.source,
      retrievalQuery: decision.query || userInput,
      memoryLines,
      memoryGuidance,
      memories: memories.map((item) => ({
        id: item.id,
        content: item.content,
        score: item.score,
      })),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post("/search", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    q: z.string().min(1),
    scope: z.enum(["conversation", "memory", "both"]).default("both"),
    limit: z.coerce.number().int().positive().max(50).default(20),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, q, scope, limit } = parsed.data;

  try {
    const hits = [];
    if (scope === "conversation" || scope === "both") {
      const rows = searchConversation({ assistantId, q, limit });
      for (const row of rows) {
        hits.push({
          kind: "conversation",
          id: row.id,
          content: row.content,
          score: row.score,
          role: row.role,
          sessionId: row.session_id,
          createdAt: row.created_at,
        });
      }
    }
    if (scope === "memory" || scope === "both") {
      const rows = searchMemory({ assistantId, q, limit });
      for (const row of rows) {
        hits.push({
          kind: "memory",
          id: row.id,
          content: row.content,
          score: row.score,
          memoryType: row.memory_type,
          createdAt: row.created_at,
        });
      }
    }
    hits.sort((a, b) => a.score - b.score);
    if (scope === "both" && hits.length > limit) hits.length = limit;
    return res.json({ ok: true, hits });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post("/character/catchup", authMiddleware, async (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    lastInteractionAt: z.number().int().min(0),
    now: z.number().int().min(0).optional(),
    maxEvents: z.number().int().min(1).max(8).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  try {
    const result = await runCatchup({
      assistantId: parsed.data.assistantId,
      lastInteractionAt: parsed.data.lastInteractionAt,
      now: parsed.data.now,
      maxEvents: parsed.data.maxEvents,
    });
    return res.json({ ok: result.ok !== false, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post("/proactive/regenerate-plans", authMiddleware, async (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  try {
    const result = await generatePlans({ assistantId: parsed.data.assistantId || null });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.get("/proactive/plans", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().trim().min(1).optional(),
    status: z.enum(["pending", "sent", "cancelled", "failed", "all"]).default("pending"),
    limit: z.coerce.number().int().positive().max(500).optional(),
  });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const { assistantId, status, limit } = parsed.data;
  let rows;
  if (status === "all") {
    const params = [];
    let sql = "SELECT * FROM proactive_plans WHERE 1=1";
    if (assistantId) {
      sql += " AND assistant_id = ?";
      params.push(assistantId);
    }
    sql += " ORDER BY scheduled_at DESC";
    if (limit) {
      sql += " LIMIT ?";
      params.push(limit);
    } else {
      sql += " LIMIT 200";
    }
    rows = db.prepare(sql).all(...params);
  } else if (status === "pending") {
    rows = listPendingPlans({ assistantId });
    if (limit) rows = rows.slice(0, limit);
  } else {
    rows = listPlansByStatus({ assistantId, status });
    if (limit) rows = rows.slice(0, limit);
  }
  return res.json({
    ok: true,
    count: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      assistantId: r.assistant_id,
      userId: r.user_id,
      triggerReason: r.trigger_reason,
      intent: r.intent,
      draftTitle: r.draft_title,
      draftBody: r.draft_body,
      anchorTopic: r.anchor_topic,
      rationale: r.rationale,
      scheduledAt: r.scheduled_at,
      status: r.status,
      cancelledReason: r.cancelled_reason,
      sentAt: r.sent_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

router.delete("/proactive/plans/:id", authMiddleware, (req, res) => {
  const schema = z.object({ reason: z.string().max(120).optional() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const plan = findPlanById(req.params.id);
  if (!plan) return res.status(404).json({ ok: false, error: "plan_not_found" });
  const cancelled = cancelPlanById(req.params.id, parsed.data.reason || "manual");
  return res.json({ ok: true, cancelled, planId: req.params.id });
});

module.exports = router;
