const express = require("express");
const { z } = require("zod");
const { db } = require("../db");
const config = require("../config");
const { runIndexerOnce } = require("../workers/memoryIndexer");
const { sendFcmMessage } = require("../services/fcm");
const callRegistry = require("../utils/callRegistry");

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

// ── 在飞调用注册表（callRegistry）—— LLM + 任意 outbound HTTP ───────
//
// 三个端点：
//   GET    /admin/calls                  - 列出当前在飞调用
//   DELETE /admin/calls/:callId          - 取消单条
//   DELETE /admin/calls?kind=&scopeKey=  - 按 scope 批量取消
//
// 取消通过 AbortController.abort() 立即触发；正在 await 的 fetch 抛 AbortError。

router.get("/calls", (_req, res) => {
  res.json({ ok: true, calls: callRegistry.list() });
});

router.delete("/calls/:callId", (req, res) => {
  const reason = String(req.query.reason || "admin");
  const ok = callRegistry.cancel(req.params.callId, reason);
  res.json({ ok, callId: req.params.callId, found: ok });
});

router.delete("/calls", (req, res) => {
  const schema = z.object({
    kind: z.string().min(1),
    scopeKey: z.string().min(1),
    reason: z.string().optional(),
  });
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const { kind, scopeKey, reason = "admin_scope" } = parsed.data;
  const cancelled = callRegistry.cancelByScope(kind, scopeKey, reason);
  res.json({ ok: true, cancelled });
});

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
       FROM character_behavior_journal
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(limit);
  res.json({ ok: true, limit, rows });
});

// 注：原 POST /admin/debug/trigger-autonomous 于 2026-05-07 移除。
// 新方向：lazy catchup（POST /api/character/catchup）+ proactive plans（POST /api/proactive/regenerate-plans）。

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

/**
 * 手动触发 facts backfill（用于一次性补存量数据）
 * Body: { limit?: number, mode?: "facts" | "all" }
 *   mode="facts"（默认）只跑 backfillMissingFacts
 *   mode="all"          先跑 backfillUnclassified 再跑 backfillMissingFacts
 */
router.post("/run-facts-backfill", async (req, res) => {
  const schema = z.object({
    limit: z.number().int().min(1).max(500).default(50),
    mode: z.enum(["facts", "all"]).default("facts"),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { limit, mode } = parsed.data;
  try {
    const {
      backfillUnclassified,
      backfillMissingFacts,
    } = require("../services/memoryClassificationService");
    const out = {};
    if (mode === "all") {
      out.classify = await backfillUnclassified({ limit });
    }
    out.facts = await backfillMissingFacts({ limit });
    return res.json({ ok: true, mode, limit, result: out });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

module.exports = router;
