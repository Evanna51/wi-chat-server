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
db.pragma("busy_timeout = 5000");
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

function insertAutonomousRunLog({
  runType,
  assistantId,
  sessionId = null,
  shouldPersist = null,
  shouldPushMessage = null,
  status = "ok",
  reason = "",
  messageIntent = "",
  draftMessage = "",
  input = {},
  result = {},
  errorMessage = "",
  createdAt = Date.now(),
}) {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO autonomous_run_log
      (id, run_type, assistant_id, session_id, should_persist, should_initiate, status, reason, message_intent, draft_message, input_json, result_json, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    runType,
    assistantId,
    sessionId,
    shouldPersist === null ? null : shouldPersist ? 1 : 0,
    shouldPushMessage === null ? null : shouldPushMessage ? 1 : 0,
    status,
    reason,
    messageIntent,
    draftMessage,
    JSON.stringify(input || {}),
    JSON.stringify(result || {}),
    errorMessage,
    createdAt
  );
  return id;
}

function getRecentConversationTurns({ assistantId, sessionId, limit = 8 }) {
  if (!sessionId) return [];
  return db
    .prepare(
      `SELECT role, content, created_at
       FROM conversation_turns
       WHERE assistant_id = ? AND session_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(assistantId, sessionId, limit);
}

function getRecentAssistantInteractions({ assistantId, limit = 10 }) {
  return db
    .prepare(
      `SELECT role, content, session_id, created_at
       FROM interaction_log
       WHERE assistant_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(assistantId, limit);
}

function getLastAssistantInteractionAt(assistantId) {
  const row = db
    .prepare(
      `SELECT created_at
       FROM interaction_log
       WHERE assistant_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(assistantId);
  return row?.created_at || null;
}

function getRecentMemoryItems({ assistantId, memoryTypes = [], limit = 6 }) {
  let sql = `
    SELECT id, memory_type, content, salience, confidence, created_at
    FROM memory_items
    WHERE assistant_id = ?`;
  const params = [assistantId];
  if (memoryTypes.length) {
    const marks = memoryTypes.map(() => "?").join(",");
    sql += ` AND memory_type IN (${marks})`;
    params.push(...memoryTypes);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);
  return db.prepare(sql).all(...params);
}

function upsertAssistantProfile({
  assistantId,
  characterName,
  characterBackground = "",
  allowAutoLife = false,
  allowProactiveMessage = false,
}) {
  const now = Date.now();
  const current = db
    .prepare("SELECT * FROM assistant_profile WHERE assistant_id = ?")
    .get(assistantId);
  const next = {
    assistant_id: assistantId,
    character_name: characterName,
    character_background: characterBackground,
    allow_auto_life: allowAutoLife ? 1 : 0,
    allow_proactive_message: allowProactiveMessage ? 1 : 0,
    last_session_id: current?.last_session_id || null,
    last_proactive_check_at: current?.last_proactive_check_at || null,
    created_at: current?.created_at || now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO assistant_profile
      (assistant_id, character_name, character_background, allow_auto_life, allow_proactive_message, last_session_id, last_proactive_check_at, created_at, updated_at)
     VALUES
      (@assistant_id, @character_name, @character_background, @allow_auto_life, @allow_proactive_message, @last_session_id, @last_proactive_check_at, @created_at, @updated_at)
     ON CONFLICT(assistant_id) DO UPDATE SET
      character_name=excluded.character_name,
      character_background=excluded.character_background,
      allow_auto_life=excluded.allow_auto_life,
      allow_proactive_message=excluded.allow_proactive_message,
      updated_at=excluded.updated_at`
  ).run(next);
  return getAssistantProfile(assistantId);
}

function getAssistantProfile(assistantId) {
  return db
    .prepare("SELECT * FROM assistant_profile WHERE assistant_id = ?")
    .get(assistantId);
}

function updateAssistantLastSession(assistantId, sessionId) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO assistant_profile
      (assistant_id, character_name, character_background, allow_auto_life, allow_proactive_message, last_session_id, last_proactive_check_at, created_at, updated_at)
     VALUES (?, ?, '', 0, 0, ?, NULL, ?, ?)
     ON CONFLICT(assistant_id) DO UPDATE SET
      last_session_id=excluded.last_session_id,
      updated_at=excluded.updated_at`
  ).run(assistantId, assistantId, sessionId, now, now);
}

function updateAssistantProactiveCheckAt(assistantId, ts = Date.now()) {
  db.prepare(
    `UPDATE assistant_profile
     SET last_proactive_check_at = ?, updated_at = ?
     WHERE assistant_id = ?`
  ).run(ts, ts, assistantId);
}

function countAllowAutoLifeAssistants() {
  return db
    .prepare("SELECT COUNT(1) AS count FROM assistant_profile WHERE allow_auto_life = 1")
    .get().count;
}

function listAutoLifeAssistantProfiles() {
  return db
    .prepare("SELECT * FROM assistant_profile WHERE allow_auto_life = 1 ORDER BY updated_at DESC")
    .all();
}

function listProactiveAssistantProfiles() {
  return db
    .prepare(
      "SELECT * FROM assistant_profile WHERE allow_proactive_message = 1 ORDER BY updated_at DESC"
    )
    .all();
}

function upsertLocalSubscriber({ userId, deviceId = "" }) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO local_subscribers (user_id, device_id, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       device_id=excluded.device_id,
       updated_at=excluded.updated_at`
  ).run(userId, deviceId, now, now);
  return db.prepare("SELECT * FROM local_subscribers WHERE user_id = ?").get(userId);
}

function listLocalSubscriberIds() {
  return db.prepare("SELECT user_id FROM local_subscribers ORDER BY updated_at DESC").all();
}

function enqueueLocalOutboxMessage({
  userId,
  assistantId,
  sessionId,
  messageType = "character_proactive",
  title,
  body,
  payload = {},
  availableAt = Date.now(),
  expiresAt = null,
}) {
  const now = Date.now();
  const id = uuidv7();
  db.prepare(
    `INSERT INTO local_outbox_messages
      (id, user_id, assistant_id, session_id, message_type, title, body, payload_json, status, available_at, expires_at, pull_count, pulled_at, acked_at, ack_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 0, NULL, NULL, NULL, ?)`
  ).run(
    id,
    userId,
    assistantId,
    sessionId,
    messageType,
    title,
    body,
    JSON.stringify(payload || {}),
    availableAt,
    expiresAt,
    now
  );
  return id;
}

function pullPendingMessagesForUser({
  userId,
  since = 0,
  limit = 20,
  now = Date.now(),
  repullGapMs = 15000,
}) {
  const rows = db
    .prepare(
      `SELECT *
       FROM local_outbox_messages
       WHERE user_id = ?
         AND status = 'pending'
         AND available_at <= ?
         AND (expires_at IS NULL OR expires_at > ?)
         AND created_at > ?
         AND (pulled_at IS NULL OR pulled_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(userId, now, now, since, now - repullGapMs, limit);
  if (!rows.length) return rows;
  const markStmt = db.prepare(
    `UPDATE local_outbox_messages
     SET pulled_at = ?, pull_count = pull_count + 1
     WHERE id = ?`
  );
  const tx = db.transaction(() => {
    for (const row of rows) {
      markStmt.run(now, row.id);
    }
  });
  tx();
  return rows;
}

function ackPulledMessage({ userId, messageId, ackStatus = "received" }) {
  const now = Date.now();
  const result = db.prepare(
    `UPDATE local_outbox_messages
     SET status = 'acked', acked_at = ?, ack_status = ?
     WHERE id = ? AND user_id = ?`
  ).run(now, ackStatus, messageId, userId);
  return result.changes > 0;
}

module.exports = {
  db,
  upsertCharacterState,
  insertConversationTurn,
  insertMemoryItem,
  insertOutboxEvent,
  withTransaction,
  insertAutonomousRunLog,
  getRecentConversationTurns,
  getRecentAssistantInteractions,
  getLastAssistantInteractionAt,
  getRecentMemoryItems,
  upsertAssistantProfile,
  getAssistantProfile,
  updateAssistantLastSession,
  updateAssistantProactiveCheckAt,
  countAllowAutoLifeAssistants,
  listAutoLifeAssistantProfiles,
  listProactiveAssistantProfiles,
  upsertLocalSubscriber,
  listLocalSubscriberIds,
  enqueueLocalOutboxMessage,
  pullPendingMessagesForUser,
  ackPulledMessage,
};
