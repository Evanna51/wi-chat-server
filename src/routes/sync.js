const express = require("express");
const { z } = require("zod");
const { ingestTurnsBatch } = require("../services/syncIngestService");
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
    return res.json({
      ok: true,
      deviceId,
      accepted: result.accepted,
      skipped: result.skipped,
      rejected: result.rejected,
      details: result.details,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

module.exports = router;
