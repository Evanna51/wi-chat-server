const express = require("express");
const { z } = require("zod");
const { db } = require("../db");
const config = require("../config");
const { runIndexerOnce } = require("../workers/memoryIndexer");
const { runLifeMemoryTick, runProactiveTick } = require("../scheduler");
const { sendFcmMessage } = require("../services/fcm");

const router = express.Router();

function authMiddleware(req, res, next) {
  if (!config.requireApiKey) return next();
  const provided = req.header("x-api-key");
  if (!provided || provided !== config.appApiKey) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

router.use(authMiddleware);

router.get("/memory-metrics", (_req, res) => {
  const outbox = db
    .prepare("SELECT status, COUNT(1) AS count FROM outbox_events GROUP BY status")
    .all();
  const retrievalLogs = db
    .prepare("SELECT COUNT(1) AS count FROM memory_retrieval_log WHERE created_at > ?")
    .get(Date.now() - 24 * 3600 * 1000);
  const localOutbox = db
    .prepare("SELECT status, COUNT(1) AS count FROM local_outbox_messages GROUP BY status")
    .all();
  res.json({ ok: true, outbox, localOutbox, retrievalLast24h: retrievalLogs.count });
});

router.get("/autonomous-runs", (req, res) => {
  const limit = Math.min(100, Math.max(1, Number(req.query.limit || 30) || 30));
  const rows = db
    .prepare(
      `SELECT id, run_type, assistant_id, session_id, should_persist, should_initiate AS should_push_message, status, reason, message_intent, draft_message, error_message, created_at
       FROM autonomous_run_log
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit);
  res.json({ ok: true, limit, rows });
});

router.post("/debug/trigger-autonomous", async (req, res) => {
  const schema = z.object({
    job: z.enum(["life", "message", "all"]).default("all"),
    assistantId: z.string().min(1).optional(),
    ignoreLock: z.boolean().default(true),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });

  const { job, assistantId, ignoreLock } = parsed.data;
  const assistantIds = assistantId ? [assistantId] : null;
  const result = {};
  if (job === "life" || job === "all") {
    result.life = await runLifeMemoryTick({ assistantIds, ignoreLock });
  }
  if (job === "message" || job === "all") {
    result.message = await runProactiveTick({ assistantIds, ignoreLock });
  }
  res.json({ ok: true, job, assistantId: assistantId || null, result, ts: Date.now() });
});

router.post("/debug/mock-push", async (req, res) => {
  const schema = z.object({
    token: z.string().min(10).optional(),
    userId: z.string().min(1).optional(),
    sendReal: z.boolean().default(false),
    title: z.string().min(1).default("Mock push"),
    body: z.string().min(1).default("This is a debug push message."),
    data: z.record(z.string(), z.string()).default({ type: "debug_mock" }),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });

  const { token, userId, sendReal, title, body, data } = parsed.data;
  let targets = [];
  if (token) {
    targets = [token];
  } else if (userId) {
    targets = db.prepare("SELECT token FROM push_token WHERE user_id = ?").all(userId).map((r) => r.token);
  } else {
    targets = db.prepare("SELECT token FROM push_token").all().map((r) => r.token);
  }

  if (!targets.length) {
    return res.status(400).json({ ok: false, error: "no_target_token_found" });
  }
  if (!sendReal) {
    return res.json({
      ok: true,
      mockOnly: true,
      targetCount: targets.length,
      sampleTarget: targets[0],
      payload: { title, body, data },
    });
  }

  const results = [];
  for (const t of targets) {
    try {
      const raw = await sendFcmMessage(t, { title, body, data });
      results.push({ token: t, ok: true, raw });
    } catch (error) {
      results.push({ token: t, ok: false, error: error.message });
    }
  }
  const sent = results.filter((item) => item.ok).length;
  const failed = results.length - sent;
  res.json({ ok: true, mockOnly: false, targetCount: results.length, sent, failed, results });
});

router.post("/replay-dead-letter", async (req, res) => {
  const schema = z.object({ limit: z.number().int().positive().max(50).default(20) });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const rows = db
    .prepare("SELECT * FROM outbox_events WHERE status='dead' ORDER BY updated_at ASC LIMIT ?")
    .all(parsed.data.limit);
  const now = Date.now();
  const update = db.prepare(
    "UPDATE outbox_events SET status='pending', retry_count=0, last_error=NULL, next_retry_at=?, updated_at=? WHERE id=?"
  );
  const tx = db.transaction(() => {
    for (const row of rows) update.run(now, now, row.id);
  });
  tx();
  await runIndexerOnce();
  res.json({ ok: true, replayed: rows.length });
});

router.post("/run-indexer-once", async (_req, res) => {
  const processed = await runIndexerOnce();
  res.json({ ok: true, processed });
});

module.exports = router;
