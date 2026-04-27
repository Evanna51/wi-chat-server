const express = require("express");
const { z } = require("zod");
const { db } = require("../db");
const { ingestTurnsBatch } = require("../services/syncIngestService");
const {
  cancelPendingPlansForAssistant,
} = require("../services/proactivePlanService");
const config = require("../config");

const router = express.Router();

const authMiddleware = (req, res, next) => {
  if (!config.requireApiKey) return next();
  const required = config.appApiKey;
  const provided = req.header("x-api-key");
  if (!provided || provided !== required) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
};

const pushSchema = z.object({
  deviceId: z.string().min(1),
  turns: z
    .array(
      z.object({
        id: z.string().min(1),
        assistantId: z.string().min(1),
        sessionId: z.string().min(1),
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1),
        createdAt: z.number().int().min(0),
      })
    )
    .min(1)
    .max(200),
});

router.post("/push", authMiddleware, (req, res) => {
  const parsed = pushSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const { deviceId, turns } = parsed.data;
  try {
    const result = ingestTurnsBatch({ deviceId, turns });
    // For any user-role turn pushed in, cancel pending plans for that assistant.
    const userAssistantIds = new Set();
    for (const t of turns) {
      if (t && t.role === "user" && t.assistantId) {
        userAssistantIds.add(t.assistantId);
      }
    }
    let cancelledPlans = 0;
    for (const aid of userAssistantIds) {
      try {
        cancelledPlans += cancelPendingPlansForAssistant(aid, "user_active");
      } catch (e) {
        // ignore single-assistant cancel errors
      }
    }
    return res.json({
      ok: true,
      deviceId,
      accepted: result.accepted,
      skipped: result.skipped,
      rejected: result.rejected,
      details: result.details,
      cancelledPlans,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

const stateSchema = z.object({
  assistantId: z.string().trim().min(1).optional(),
  deviceId: z.string().trim().min(1).optional(),
});

router.get("/state", authMiddleware, (req, res) => {
  const parsed = stateSchema.safeParse(req.query || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const { assistantId, deviceId } = parsed.data;
  const now = Date.now();
  try {
    const totalRow = db
      .prepare("SELECT COUNT(1) AS c FROM conversation_turns")
      .get();
    let assistantTurnCount = null;
    let lastTurnAt = null;
    if (assistantId) {
      const ar = db
        .prepare("SELECT COUNT(1) AS c FROM conversation_turns WHERE assistant_id = ?")
        .get(assistantId);
      assistantTurnCount = ar?.c || 0;
      const lastRow = db
        .prepare(
          "SELECT MAX(created_at) AS m FROM conversation_turns WHERE assistant_id = ?"
        )
        .get(assistantId);
      lastTurnAt = lastRow?.m || null;
    } else {
      const lastRow = db
        .prepare("SELECT MAX(created_at) AS m FROM conversation_turns")
        .get();
      lastTurnAt = lastRow?.m || null;
    }
    return res.json({
      ok: true,
      now,
      assistantId: assistantId || null,
      deviceId: deviceId || null,
      assistantTurnCount,
      totalTurnCount: totalRow?.c || 0,
      lastTurnAt,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

module.exports = router;
