const express = require("express");
const { z } = require("zod");
const { db } = require("../db");
const config = require("../config");
const { runIndexerOnce } = require("../workers/memoryIndexer");

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
  res.json({ ok: true, outbox, retrievalLast24h: retrievalLogs.count });
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
