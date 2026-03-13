const express = require("express");
const { z } = require("zod");
const {
  db,
  upsertCharacterState,
  insertConversationTurn,
  insertMemoryItem,
  insertOutboxEvent,
  withTransaction,
} = require("../db");
const { ingestInteraction } = require("../services/memoryIngestService");
const { retrieveMemory } = require("../services/memoryRetrievalService");
const { generateWithMemory } = require("../services/langchainQwenService");
const config = require("../config");

const router = express.Router();

const authMiddleware = (req, res, next) => {
  const required = process.env.APP_API_KEY || "dev-local-key";
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

router.post("/report-interaction", authMiddleware, (req, res) => {
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
    db.prepare(
      "INSERT INTO interaction_log (assistant_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(assistantId, sessionId, role, content, now);
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
    });
    upsertCharacterState(assistantId, {
      active_session_id: sessionId,
      total_turns: totalTurns,
      familiarity,
      last_user_message_at: role === "user" ? now : current.last_user_message_at || null,
    });
  });
  res.json({ ok: true, familiarity, totalTurns });
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

module.exports = router;
