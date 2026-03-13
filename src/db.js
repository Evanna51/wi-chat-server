const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { v7: uuidv7 } = require("uuid");
const config = require("./config");
const { runMigrations } = require("./db/migrator");

const dbDir = path.dirname(config.databasePath);
fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
runMigrations(db, path.join(__dirname, "db", "migrations"));

function upsertCharacterState(assistantId, patch = {}) {
  const now = Date.now();
  const row = db
    .prepare("SELECT * FROM character_state WHERE assistant_id = ?")
    .get(assistantId);
  const next = {
    assistant_id: assistantId,
    active_session_id:
      patch.active_session_id !== undefined
        ? patch.active_session_id
        : row?.active_session_id || "",
    familiarity:
      patch.familiarity !== undefined ? patch.familiarity : row?.familiarity || 0,
    total_turns:
      patch.total_turns !== undefined ? patch.total_turns : row?.total_turns || 0,
    last_user_message_at:
      patch.last_user_message_at !== undefined
        ? patch.last_user_message_at
        : row?.last_user_message_at || null,
    last_proactive_at:
      patch.last_proactive_at !== undefined
        ? patch.last_proactive_at
        : row?.last_proactive_at || null,
    created_at: row?.created_at || now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO character_state
      (assistant_id, active_session_id, familiarity, total_turns, last_user_message_at, last_proactive_at, created_at, updated_at)
     VALUES
      (@assistant_id, @active_session_id, @familiarity, @total_turns, @last_user_message_at, @last_proactive_at, @created_at, @updated_at)
     ON CONFLICT(assistant_id) DO UPDATE SET
      active_session_id=excluded.active_session_id,
      familiarity=excluded.familiarity,
      total_turns=excluded.total_turns,
      last_user_message_at=excluded.last_user_message_at,
      last_proactive_at=excluded.last_proactive_at,
      updated_at=excluded.updated_at`
  ).run(next);
  return next;
}

function insertConversationTurn({ assistantId, sessionId, role, content, createdAt = Date.now() }) {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO conversation_turns (id, assistant_id, session_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, assistantId, sessionId, role, content, createdAt);
  return id;
}

function insertMemoryItem({
  assistantId,
  sessionId,
  sourceTurnId,
  content,
  memoryType = "turn",
  salience = 0.5,
  confidence = 0.7,
}) {
  const now = Date.now();
  const id = uuidv7();
  db.prepare(
    `INSERT INTO memory_items
      (id, assistant_id, session_id, source_turn_id, memory_type, content, salience, confidence, vector_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    id,
    assistantId,
    sessionId,
    sourceTurnId,
    memoryType,
    content,
    salience,
    confidence,
    now,
    now
  );
  return id;
}

function insertOutboxEvent({
  eventType,
  aggregateType,
  aggregateId,
  dedupeKey,
  payload,
  status = "pending",
}) {
  const id = uuidv7();
  const now = Date.now();
  db.prepare(
    `INSERT INTO outbox_events
      (id, event_type, aggregate_type, aggregate_id, dedupe_key, payload_json, status, next_retry_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    eventType,
    aggregateType,
    aggregateId,
    dedupeKey,
    JSON.stringify(payload),
    status,
    now,
    now,
    now
  );
  return id;
}

function withTransaction(fn) {
  return db.transaction(fn)();
}

module.exports = {
  db,
  upsertCharacterState,
  insertConversationTurn,
  insertMemoryItem,
  insertOutboxEvent,
  withTransaction,
};
