const express = require("express");
const { z } = require("zod");
const path = require("path");
const fs = require("fs");
const config = require("../config");
const {
  db,
  upsertAssistantProfile,
  getAssistantProfile,
} = require("../db");
const { runLifeMemoryTick, runProactiveTick } = require("../scheduler");
const {
  getActiveUserIds,
  getActiveSocketCount,
} = require("../ws/connections");

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

router.use(authMiddleware);

const limitSchema = z.coerce.number().int().min(1).max(200).default(100);
const cursorSchema = z.coerce.number().int().min(0).optional();
const optionalString = z.string().trim().min(1).optional();

function profileToDto(row, extras = {}) {
  if (!row) return null;
  return {
    assistantId: row.assistant_id,
    characterName: row.character_name,
    characterBackground: row.character_background || "",
    allowAutoLife: row.allow_auto_life === 1,
    allowProactiveMessage: row.allow_proactive_message === 1,
    lastSessionId: row.last_session_id || null,
    lastProactiveCheckAt: row.last_proactive_check_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...extras,
  };
}

function getStateRow(assistantId) {
  return db
    .prepare(
      `SELECT assistant_id, active_session_id, familiarity, total_turns,
              last_user_message_at, last_proactive_at, created_at, updated_at
       FROM character_state WHERE assistant_id = ?`
    )
    .get(assistantId);
}

function getAssistantCounts(assistantId) {
  const conv = db
    .prepare("SELECT COUNT(1) AS n FROM conversation_turns WHERE assistant_id = ?")
    .get(assistantId).n;
  const mem = db
    .prepare("SELECT COUNT(1) AS n FROM memory_items WHERE assistant_id = ?")
    .get(assistantId).n;
  const journal = db
    .prepare("SELECT COUNT(1) AS n FROM character_behavior_journal WHERE assistant_id = ?")
    .get(assistantId).n;
  return {
    conversationTurns: conv,
    memoryItems: mem,
    journalEntries: journal,
  };
}

function buildAssistantDto(profileRow) {
  const stateRow = getStateRow(profileRow.assistant_id);
  const counts = getAssistantCounts(profileRow.assistant_id);
  return profileToDto(profileRow, {
    state: stateRow
      ? {
          familiarity: stateRow.familiarity || 0,
          totalTurns: stateRow.total_turns || 0,
          activeSessionId: stateRow.active_session_id || null,
          lastUserMessageAt: stateRow.last_user_message_at || null,
          lastProactiveAt: stateRow.last_proactive_at || null,
        }
      : {
          familiarity: 0,
          totalTurns: 0,
          activeSessionId: null,
          lastUserMessageAt: null,
          lastProactiveAt: null,
        },
    counts,
  });
}

router.get("/assistants", (_req, res) => {
  const rows = db
    .prepare("SELECT * FROM assistant_profile ORDER BY updated_at DESC")
    .all();
  const assistants = rows.map(buildAssistantDto);
  res.json({ ok: true, assistants });
});

router.get("/assistants/:id", (req, res) => {
  const profile = getAssistantProfile(req.params.id);
  if (!profile) {
    return res.status(404).json({ ok: false, error: "assistant_not_found" });
  }
  res.json({ ok: true, assistant: buildAssistantDto(profile) });
});

router.get("/sessions", (req, res) => {
  const schema = z.object({ assistantId: z.string().min(1) });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const rows = db
    .prepare(
      `SELECT session_id,
              MIN(created_at) AS first_at,
              MAX(created_at) AS last_at,
              COUNT(1) AS turn_count
       FROM conversation_turns
       WHERE assistant_id = ?
       GROUP BY session_id
       ORDER BY last_at DESC
       LIMIT 200`
    )
    .all(parsed.data.assistantId);
  res.json({
    ok: true,
    sessions: rows.map((r) => ({
      sessionId: r.session_id,
      firstAt: r.first_at,
      lastAt: r.last_at,
      turnCount: r.turn_count,
    })),
  });
});

router.get("/conversations", (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    sessionId: optionalString,
    limit: limitSchema,
    before: cursorSchema,
  });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, sessionId, limit, before } = parsed.data;
  const params = [assistantId];
  let sql = `SELECT id, assistant_id, session_id, role, content, created_at
             FROM conversation_turns
             WHERE assistant_id = ?`;
  if (sessionId) {
    sql += " AND session_id = ?";
    params.push(sessionId);
  }
  if (before !== undefined) {
    sql += " AND created_at < ?";
    params.push(before);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  const items = rows.map((r) => ({
    id: r.id,
    assistantId: r.assistant_id,
    sessionId: r.session_id,
    role: r.role,
    content: r.content,
    createdAt: r.created_at,
  }));
  const nextBefore =
    items.length === limit ? items[items.length - 1].createdAt : null;
  res.json({ ok: true, items, nextBefore });
});

router.get("/memories", (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    type: optionalString,
    limit: limitSchema,
    before: cursorSchema,
  });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, type, limit, before } = parsed.data;
  const params = [assistantId];
  let sql = `SELECT id, memory_type, content, salience, confidence, vector_status,
                    session_id, created_at
             FROM memory_items
             WHERE assistant_id = ?`;
  if (type && type !== "all") {
    sql += " AND memory_type = ?";
    params.push(type);
  }
  if (before !== undefined) {
    sql += " AND created_at < ?";
    params.push(before);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  const items = rows.map((r) => ({
    id: r.id,
    memoryType: r.memory_type,
    content: r.content,
    salience: r.salience,
    confidence: r.confidence,
    vectorStatus: r.vector_status,
    sessionId: r.session_id,
    createdAt: r.created_at,
  }));
  const nextBefore =
    items.length === limit ? items[items.length - 1].createdAt : null;
  res.json({ ok: true, items, nextBefore });
});

router.get("/journal", (req, res) => {
  const schema = z.object({
    assistantId: optionalString,
    runType: optionalString,
    from: cursorSchema,
    to: cursorSchema,
    limit: limitSchema,
    before: cursorSchema,
  });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, runType, from, to, limit, before } = parsed.data;
  const params = [];
  let sql = `SELECT id, run_type, assistant_id, session_id,
                    should_persist, should_initiate, status, reason,
                    message_intent, draft_message, error_message, created_at
             FROM character_behavior_journal
             WHERE 1 = 1`;
  if (assistantId) {
    sql += " AND assistant_id = ?";
    params.push(assistantId);
  }
  if (runType && runType !== "all") {
    sql += " AND run_type = ?";
    params.push(runType);
  }
  if (from !== undefined) {
    sql += " AND created_at >= ?";
    params.push(from);
  }
  if (to !== undefined) {
    sql += " AND created_at <= ?";
    params.push(to);
  }
  if (before !== undefined) {
    sql += " AND created_at < ?";
    params.push(before);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  const items = rows.map((r) => ({
    id: r.id,
    runType: r.run_type,
    assistantId: r.assistant_id,
    sessionId: r.session_id,
    shouldPersist: r.should_persist === null ? null : r.should_persist === 1,
    shouldInitiate: r.should_initiate === null ? null : r.should_initiate === 1,
    status: r.status,
    reason: r.reason || "",
    messageIntent: r.message_intent || "",
    draftMessage: r.draft_message || "",
    errorMessage: r.error_message || "",
    createdAt: r.created_at,
  }));
  const nextBefore =
    items.length === limit ? items[items.length - 1].createdAt : null;
  res.json({ ok: true, items, nextBefore });
});

router.get("/facts", (req, res) => {
  const schema = z.object({ assistantId: z.string().min(1), limit: limitSchema });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, limit } = parsed.data;
  const rows = db
    .prepare(
      `SELECT id, fact_key, fact_value, confidence, memory_item_id, session_id, created_at
       FROM memory_facts
       WHERE assistant_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(assistantId, limit);
  const items = rows.map((r) => ({
    id: r.id,
    factKey: r.fact_key,
    factValue: r.fact_value,
    confidence: r.confidence,
    memoryItemId: r.memory_item_id,
    sessionId: r.session_id,
    createdAt: r.created_at,
  }));
  res.json({ ok: true, items });
});

const STAT_TABLES = [
  "assistant_profile",
  "character_state",
  "conversation_turns",
  "memory_items",
  "memory_facts",
  "memory_edges",
  "memory_vectors",
  "character_behavior_journal",
  "outbox_events",
  "local_outbox_messages",
  "memory_retrieval_log",
  "dead_letter_events",
];

router.get("/stats", (_req, res) => {
  const pageCount = db.pragma("page_count", { simple: true });
  const pageSize = db.pragma("page_size", { simple: true });
  const tables = {};
  for (const name of STAT_TABLES) {
    try {
      const row = db.prepare(`SELECT COUNT(1) AS n FROM ${name}`).get();
      tables[name] = row.n;
    } catch (error) {
      tables[name] = null;
    }
  }
  let dbSizeBytes = pageCount * pageSize;
  try {
    const stat = fs.statSync(config.databasePath);
    if (stat && stat.size) dbSizeBytes = stat.size;
  } catch {}
  const recent = {
    lastIndexerAt: null,
    lastRetentionAt: null,
  };
  try {
    const lock = db
      .prepare("SELECT lock_name, updated_at FROM scheduler_locks")
      .all();
    for (const row of lock) {
      if (row.lock_name === config.retentionSweepLockName) {
        recent.lastRetentionAt = row.updated_at;
      }
    }
  } catch {}
  const wsActiveSockets = {};
  try {
    for (const uid of getActiveUserIds()) {
      wsActiveSockets[uid] = getActiveSocketCount(uid);
    }
  } catch {}
  res.json({
    ok: true,
    db: {
      sizeBytes: dbSizeBytes,
      pageCount,
      pageSize,
      path: path.basename(config.databasePath),
    },
    tables,
    recent,
    schedule: {
      lifeCron: config.lifeMemoryCron,
      proactiveCron: config.proactiveMessageCron,
      retentionCron: config.retentionSweepCron,
      dryRun: config.autonomousDryRun,
      pushEnabled: config.autonomousPushEnabled,
      quietHours: config.autonomousQuietHours,
    },
    wsActiveSockets,
  });
});

router.get("/config", (_req, res) => {
  res.json({
    ok: true,
    config: {
      autonomousDryRun: config.autonomousDryRun,
      autonomousPushEnabled: config.autonomousPushEnabled,
      autonomousQuietHours: config.autonomousQuietHours,
      autonomousMinMessageIntervalMs: config.autonomousMinMessageIntervalMs,
      lifeMemoryCron: config.lifeMemoryCron,
      proactiveMessageCron: config.proactiveMessageCron,
      retentionSweepCron: config.retentionSweepCron,
      timezone: config.timezone,
    },
  });
});

router.patch("/assistants/:id/flags", (req, res) => {
  const schema = z.object({
    allowAutoLife: z.boolean().optional(),
    allowProactiveMessage: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const current = getAssistantProfile(req.params.id);
  if (!current) {
    return res.status(404).json({ ok: false, error: "assistant_not_found" });
  }
  const next = upsertAssistantProfile({
    assistantId: current.assistant_id,
    characterName: current.character_name,
    characterBackground: current.character_background || "",
    allowAutoLife:
      parsed.data.allowAutoLife !== undefined
        ? parsed.data.allowAutoLife
        : current.allow_auto_life === 1,
    allowProactiveMessage:
      parsed.data.allowProactiveMessage !== undefined
        ? parsed.data.allowProactiveMessage
        : current.allow_proactive_message === 1,
  });
  res.json({ ok: true, profile: profileToDto(next) });
});

router.patch("/assistants/:id/profile", (req, res) => {
  const schema = z.object({
    characterName: z.string().min(1).optional(),
    characterBackground: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const current = getAssistantProfile(req.params.id);
  if (!current) {
    return res.status(404).json({ ok: false, error: "assistant_not_found" });
  }
  const next = upsertAssistantProfile({
    assistantId: current.assistant_id,
    characterName:
      parsed.data.characterName !== undefined
        ? parsed.data.characterName
        : current.character_name,
    characterBackground:
      parsed.data.characterBackground !== undefined
        ? parsed.data.characterBackground
        : current.character_background || "",
    allowAutoLife: current.allow_auto_life === 1,
    allowProactiveMessage: current.allow_proactive_message === 1,
  });
  res.json({ ok: true, profile: profileToDto(next) });
});

router.post("/assistants/:id/run", async (req, res) => {
  const schema = z.object({
    job: z.enum(["life", "message"]),
    dryRun: z.boolean().default(true),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const profile = getAssistantProfile(req.params.id);
  if (!profile) {
    return res.status(404).json({ ok: false, error: "assistant_not_found" });
  }
  const { job, dryRun } = parsed.data;
  const assistantIds = [req.params.id];
  try {
    let result;
    if (job === "life") {
      result = await runLifeMemoryTick({ ignoreLock: true, assistantIds, dryRun });
    } else {
      result = await runProactiveTick({ ignoreLock: true, assistantIds, dryRun });
    }
    res.json({
      ok: true,
      job,
      dryRun,
      assistantId: req.params.id,
      result,
      ts: Date.now(),
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;
