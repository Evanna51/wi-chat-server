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
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL");
db.pragma("mmap_size = 268435456");
db.pragma("cache_size = -65536");
db.pragma("wal_autocheckpoint = 1000");
runMigrations(db, path.join(__dirname, "db", "migrations"));

// 启动时校验 config.vectorDim 与 DB 已存数据一致。
// 若 memory_vectors 为空，跳过（首次启动）；否则不一致直接退出，避免 reembed/检索全错算。
(function assertVectorDim() {
  try {
    const row = db
      .prepare("SELECT vector_dim FROM memory_vectors WHERE vector_dim IS NOT NULL LIMIT 1")
      .get();
    if (!row) return;
    if (row.vector_dim !== config.vectorDim) {
      console.error(
        `[db] FATAL: VECTOR_DIM mismatch. config=${config.vectorDim}, db=${row.vector_dim}. ` +
          `请检查 .env 的 VECTOR_DIM 是否与 embed 模型实际输出维度一致。`
      );
      process.exit(1);
    }
  } catch (err) {
    // 表还没建出来（极早期 migration 失败）走不到这；如果是其它读错误，宁可让后续逻辑暴露。
    console.warn("[db] vector_dim assertion skipped:", err.message);
  }
})();

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
      (assistant_id, active_session_id, total_turns, last_user_message_at, last_proactive_at, created_at, updated_at)
     VALUES
      (@assistant_id, @active_session_id, @total_turns, @last_user_message_at, @last_proactive_at, @created_at, @updated_at)
     ON CONFLICT(assistant_id) DO UPDATE SET
      active_session_id=excluded.active_session_id,
      total_turns=excluded.total_turns,
      last_user_message_at=excluded.last_user_message_at,
      last_proactive_at=excluded.last_proactive_at,
      updated_at=excluded.updated_at`
  ).run(next);
  return next;
}

function insertConversationTurn({
  id,
  assistantId,
  sessionId,
  role,
  content,
  createdAt = Date.now(),
  toolCallsJson = null,
  toolCallId = null,
  toolName = null,
}) {
  const turnId = id || uuidv7();
  db.prepare(
    `INSERT OR IGNORE INTO conversation_turns
       (id, assistant_id, session_id, role, content, created_at,
        tool_calls_json, tool_call_id, tool_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    turnId,
    assistantId,
    sessionId,
    role,
    content,
    createdAt,
    toolCallsJson,
    toolCallId,
    toolName
  );
  return turnId;
}

/**
 * 更新单条 conversation_turn 的 content（WS message_update 用）。
 * 同步把派生的 memory_item.content 一起改 + 标 vector_status='pending' 让 indexer 重 embed。
 * memory_facts 不改（旧 facts 是从旧 content 抽的，留给 AI 后续 memory-correct 再修）。
 *
 * 返回 { found, updated, memoryUpdated }。
 */
function updateConversationTurnContent({ id, newContent, assistantId = null }) {
  if (!id || typeof newContent !== "string" || !newContent.length) {
    return { found: false, updated: false, reason: "missing_required_field" };
  }
  const row = db
    .prepare("SELECT id, assistant_id FROM conversation_turns WHERE id = ?")
    .get(id);
  if (!row) return { found: false, updated: false, reason: "turn_not_found" };
  if (assistantId && row.assistant_id !== assistantId) {
    return { found: false, updated: false, reason: "assistant_mismatch" };
  }
  const now = Date.now();
  db.prepare("UPDATE conversation_turns SET content = ? WHERE id = ?").run(newContent, id);
  const memUpd = db.prepare(
    `UPDATE memory_items
        SET content = ?, vector_status = 'pending', updated_at = ?
      WHERE source_turn_id = ?`
  ).run(newContent, now, id);
  return { found: true, updated: true, memoryUpdated: memUpd.changes || 0 };
}

function findConversationTurnById(id) {
  if (!id) return undefined;
  return db
    .prepare(
      `SELECT id, assistant_id, session_id, role, content, created_at,
              tool_calls_json, tool_call_id, tool_name
         FROM conversation_turns WHERE id = ?`
    )
    .get(id);
}

/**
 * 按逻辑 key (assistant_id, session_id, role, created_at) 查 turn。
 *
 * 给 sync ingest 做"后面覆盖前面"去重用——客户端因 turnId 漂移产生的重复，
 * 用这个查到旧行再级联删除即可。
 */
function findConversationTurnByLogicalKey({ assistantId, sessionId, role, createdAt }) {
  if (!assistantId || !sessionId || !role || createdAt == null) return undefined;
  return db
    .prepare(
      `SELECT id FROM conversation_turns
        WHERE assistant_id = ? AND session_id = ? AND role = ? AND created_at = ?`
    )
    .get(assistantId, sessionId, role, createdAt);
}

function findMemoryItemBySourceTurnId(sourceTurnId) {
  if (!sourceTurnId) return undefined;
  return db
    .prepare(
      "SELECT id, assistant_id, session_id, source_turn_id, memory_type, content, created_at FROM memory_items WHERE source_turn_id = ? LIMIT 1"
    )
    .get(sourceTurnId);
}

// 合法 memory_type 集合 — 凡是写入 memory_items 表的 type 必须在这里。
// assistant 回复 / tool_call / tool_result / system 都不进 memory_items，
// 仅写 conversation_turns（由 memoryIngestService 上游 short-circuit）；这里再做一道防线。
const ALLOWED_MEMORY_TYPES = new Set([
  "user_turn",
  "life_event",
  "work_event",
  "knowledge",
  // 角色独立时间线产物（lifeBeatTickService 写入），retrieval 默认不召回，
  // 仅 source='character' 显式问"角色独立想了什么"时才进结果池。
  "life_event_autonomous",
]);

function insertMemoryItem({
  assistantId,
  sessionId,
  sourceTurnId,
  content,
  memoryType,
  salience = 0.5,
  confidence = 0.7,
  createdAt = null,  // 真实事件时间（即对应 turn 的 createdAt）；不传则用 now
}) {
  if (!ALLOWED_MEMORY_TYPES.has(memoryType)) {
    throw new Error(
      `insertMemoryItem: invalid memory_type='${memoryType}'. ` +
        `Allowed: ${[...ALLOWED_MEMORY_TYPES].join(", ")}`
    );
  }
  const ingestNow = Date.now();
  const eventTime = createdAt != null ? createdAt : ingestNow;
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
    eventTime,
    ingestNow
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

function insertBehaviorJournalEntry({
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
    `INSERT INTO character_behavior_journal
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
       FROM conversation_turns
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
       FROM conversation_turns
       WHERE assistant_id = ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(assistantId);
  return row?.created_at || null;
}

function getRecentTurnsAcrossSessions({ assistantId, limit = 8 }) {
  return db
    .prepare(
      `SELECT id, role, content, session_id, created_at
       FROM conversation_turns
       WHERE assistant_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(assistantId, limit);
}

function getConfidentFactsForAssistant({ assistantId, minConfidence = 0.5, limit = 30, characterName = null }) {
  const rows = db
    .prepare(
      `SELECT id, fact_key, fact_value, confidence, importance, memory_item_id, session_id, created_at
       FROM memory_facts
       WHERE assistant_id = ? AND confidence > ?
       ORDER BY confidence DESC, created_at DESC
       LIMIT ?`
    )
    .all(assistantId, minConfidence, limit);
  // 占位符展开：fact_value 里的 `{角色}` → 当前 character_name。
  // 调用方传 characterName（通常来自 getAssistantProfile(assistantId).character_name）。
  if (!characterName) return rows;
  const { expandPlaceholder } = require("./utils/characterPlaceholder");
  return rows.map((r) => ({ ...r, fact_value: expandPlaceholder(r.fact_value, characterName) }));
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
  assistantType,
}) {
  const now = Date.now();
  const current = db
    .prepare("SELECT * FROM assistant_profile WHERE assistant_id = ?")
    .get(assistantId);
  // assistantType 显式传 → 覆盖；不传 → 保留旧值（避免 phone 端旧版漏传时把已有 type 抹成空）
  const nextType =
    assistantType !== undefined && assistantType !== null
      ? String(assistantType)
      : current?.assistant_type || "";

  // Phase 3: setup_prompt 与 character_background 同步写（dual-write）。
  // 兼容期：客户端仍传 characterBackground 字段；server 把它当 setup_prompt 存档。
  // 真实"角色 lore"是 LLM 提炼后的 lore 字段（subscriber 异步更新）。
  const setupPromptNew = characterBackground || "";
  const setupPromptChanged =
    !current || (current.setup_prompt || current.character_background || "") !== setupPromptNew;

  // 决定 extraction_status：
  // - 新角色 + character/空 type → pending（异步触发 extract）
  // - setup_prompt 改了 + character/空 type → pending（重新提炼）
  // - 不变 → 保留旧 status
  // - writer/general 类 → skipped
  const isCharacterType = nextType === "character" || nextType === "";
  let nextExtractionStatus = current?.extraction_status || "pending";
  if (!isCharacterType) {
    nextExtractionStatus = "skipped";
  } else if (setupPromptChanged) {
    nextExtractionStatus = "pending";
  }

  const next = {
    assistant_id: assistantId,
    character_name: characterName,
    character_background: characterBackground,
    setup_prompt: setupPromptNew,
    // lore: 仅在新建时初始化为 setup_prompt（暂用），等 LLM 提炼跑完替换。
    // setup_prompt 改动 *不* 立刻覆盖 lore（保留旧 lore 给当前 chat 用，直到新提炼完成）。
    lore: current?.lore || setupPromptNew,
    extraction_status: nextExtractionStatus,
    // extraction_error 重置为空（新一轮提炼）
    extraction_error: setupPromptChanged ? "" : current?.extraction_error || "",
    extracted_at: current?.extracted_at || 0,
    allow_auto_life: allowAutoLife ? 1 : 0,
    allow_proactive_message: allowProactiveMessage ? 1 : 0,
    assistant_type: nextType,
    last_session_id: current?.last_session_id || null,
    last_proactive_check_at: current?.last_proactive_check_at || null,
    created_at: current?.created_at || now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO assistant_profile
      (assistant_id, character_name, character_background, setup_prompt, lore,
       extraction_status, extraction_error, extracted_at,
       allow_auto_life, allow_proactive_message, assistant_type,
       last_session_id, last_proactive_check_at, created_at, updated_at)
     VALUES
      (@assistant_id, @character_name, @character_background, @setup_prompt, @lore,
       @extraction_status, @extraction_error, @extracted_at,
       @allow_auto_life, @allow_proactive_message, @assistant_type,
       @last_session_id, @last_proactive_check_at, @created_at, @updated_at)
     ON CONFLICT(assistant_id) DO UPDATE SET
      character_name=excluded.character_name,
      character_background=excluded.character_background,
      setup_prompt=excluded.setup_prompt,
      extraction_status=excluded.extraction_status,
      extraction_error=excluded.extraction_error,
      allow_auto_life=excluded.allow_auto_life,
      allow_proactive_message=excluded.allow_proactive_message,
      assistant_type=excluded.assistant_type,
      updated_at=excluded.updated_at`
  ).run(next);
  const row = getAssistantProfile(assistantId);
  // 标记 changed 给 caller —— caller 决定是否触发异步 extract
  return Object.assign({}, row, { _setupPromptChanged: setupPromptChanged });
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

// upsertLocalSubscriber / listLocalSubscriberIds 已于 2026-05-06 随 HTTP 轮询通道一并移除
// （local_subscribers 表见 migration 015 drop）

// 调用方可显式传 `id` —— proactive 派发时传 `plan.id`，让 outbox row 与
// `conversation_turns.id` 共享同一个 UUID v7。这是跨端 turnId 一致性的关键：
// 客户端无论从 WS-broadcast 还是 outbox-pull 收到这条消息，frame.id 都等于
// server 端 conversation_turns.id；后续 message_delete 可定位到同一行。
// INSERT OR IGNORE 让重复 enqueue（同 id）变成幂等 noop。
function enqueueLocalOutboxMessage({
  id: providedId,
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
  const id = providedId || uuidv7();
  db.prepare(
    `INSERT OR IGNORE INTO local_outbox_messages
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

function escapeFtsQuery(q) {
  const trimmed = String(q).trim();
  if (!trimmed) return "";
  return `"${trimmed.replace(/"/g, '""')}"`;
}

// conversation_turns_fts 已于 migration 020 移除（trigram FTS 7x 膨胀且仅被调试接口用）。
// 此函数现在统一用 LIKE 全表扫 —— turns 量级 <10k 时延迟在毫秒级，且 created_at DESC 走索引即可。
function searchConversation({ assistantId, q, limit = 20 }) {
  if (!q || !assistantId) return [];
  const normalized = String(q).trim();
  if (normalized.length === 0) return [];
  const like = `%${normalized.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db
    .prepare(
      `SELECT id, role, content, session_id, created_at,
              0 AS score
       FROM conversation_turns
       WHERE assistant_id = ? AND content LIKE ? ESCAPE '\\'
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(assistantId, like, limit);
}

function searchMemory({ assistantId, q, limit = 20 }) {
  if (!q || !assistantId) return [];
  const normalized = String(q).trim();
  if (normalized.length === 0) return [];
  if (normalized.length < 3) {
    const like = `%${normalized.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return db
      .prepare(
        `SELECT id, memory_type, content, created_at,
                0 AS score
         FROM memory_items
         WHERE assistant_id = ? AND content LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(assistantId, like, limit);
  }
  return db
    .prepare(
      `SELECT m.id, m.memory_type, m.content, m.created_at,
              bm25(memory_items_fts) AS score
       FROM memory_items_fts f
       JOIN memory_items m ON m.rowid = f.rowid
       WHERE f.content MATCH ? AND f.assistant_id = ?
       ORDER BY score ASC
       LIMIT ?`
    )
    .all(escapeFtsQuery(normalized), assistantId, limit);
}

// ── character_life_beat CRUD（migration 035）─────────────────────────
//
// 时间线模型：daily-life-plan cron 生成 pending beats，life-beat-tick cron
// 扫到点 → 调 markBeatActivated/markBeatSkipped 落库 + 视情况触发 proactive。
// 设计：docs/character-life-beat-plan.md

function insertLifeBeat({
  assistantId,
  planDate,
  scheduledAt,
  activity,
  beatType,
  reachSeed = null,
  importance = 0.5,
  createdAt = null,
}) {
  if (!assistantId || !planDate || !scheduledAt || !activity || !beatType) {
    throw new Error("insertLifeBeat: missing required field");
  }
  if (beatType !== "autonomous" && beatType !== "anchored") {
    throw new Error(`insertLifeBeat: invalid beat_type='${beatType}'`);
  }
  const ts = createdAt != null ? createdAt : Date.now();
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO character_life_beat
        (assistant_id, plan_date, scheduled_at, activity, beat_type, reach_seed, importance, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(assistantId, planDate, scheduledAt, activity, beatType, reachSeed, importance, ts);
  return info.lastInsertRowid || null;
}

function listPendingLifeBeats({ now = Date.now(), limit = 50 } = {}) {
  // tick 主查询：取所有到点的 pending beat（跨 assistant，让单次 tick 一把扫完）
  return db
    .prepare(
      `SELECT id, assistant_id, plan_date, scheduled_at, activity, beat_type, reach_seed, importance, status, created_at
         FROM character_life_beat
        WHERE status = 'pending' AND scheduled_at <= ?
        ORDER BY scheduled_at ASC
        LIMIT ?`
    )
    .all(now, limit);
}

function listLifeBeatsForDate({ assistantId, planDate }) {
  return db
    .prepare(
      `SELECT id, assistant_id, plan_date, scheduled_at, activity, beat_type, reach_seed, importance, status,
              activated_at, memory_item_id, created_at
         FROM character_life_beat
        WHERE assistant_id = ? AND plan_date = ?
        ORDER BY scheduled_at ASC`
    )
    .all(assistantId, planDate);
}

function getLatestActivatedLifeBeat({ assistantId, withinMs = null, now = Date.now() }) {
  // context builder 拼"刚才/此刻在做 X"：取最近 1 条 activated beat，withinMs 控制时效
  if (withinMs && withinMs > 0) {
    return db
      .prepare(
        `SELECT id, assistant_id, plan_date, scheduled_at, activity, beat_type, reach_seed, importance,
                activated_at, memory_item_id
           FROM character_life_beat
          WHERE assistant_id = ? AND status = 'activated' AND activated_at >= ?
          ORDER BY activated_at DESC
          LIMIT 1`
      )
      .get(assistantId, now - withinMs);
  }
  return db
    .prepare(
      `SELECT id, assistant_id, plan_date, scheduled_at, activity, beat_type, reach_seed, importance,
              activated_at, memory_item_id
         FROM character_life_beat
        WHERE assistant_id = ? AND status = 'activated'
        ORDER BY activated_at DESC
        LIMIT 1`
    )
    .get(assistantId);
}

function countActivatedAnchoredBeatsSince({ assistantId, sinceMs }) {
  // 24h 软 cap 用：beat tick 决定是否触发 proactive 时，先看过去 24h 已触发过几次
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM character_life_beat
        WHERE assistant_id = ? AND beat_type = 'anchored' AND status = 'activated'
          AND activated_at >= ?`
    )
    .get(assistantId, sinceMs);
  return row?.n || 0;
}

function markBeatActivated({ beatId, memoryItemId, activatedAt = Date.now() }) {
  db.prepare(
    `UPDATE character_life_beat
        SET status = 'activated', memory_item_id = ?, activated_at = ?
      WHERE id = ? AND status = 'pending'`
  ).run(memoryItemId || null, activatedAt, beatId);
}

function markBeatSkipped({ beatId, activatedAt = Date.now() }) {
  // 落 activated_at 一起更新，便于诊断"什么时候决定 skip 的"
  db.prepare(
    `UPDATE character_life_beat
        SET status = 'skipped', activated_at = ?
      WHERE id = ? AND status = 'pending'`
  ).run(activatedAt, beatId);
}

function expireStaleLifeBeats({ beforePlanDate }) {
  // daily-life-plan tick 跑之前调一次：把昨日及更早的 pending 全转 expired
  const info = db
    .prepare(
      `UPDATE character_life_beat
          SET status = 'expired'
        WHERE status = 'pending' AND plan_date < ?`
    )
    .run(beforePlanDate);
  return info.changes || 0;
}

function deleteLifeBeatsForDate({ assistantId, planDate }) {
  // debug / 手动重跑当日 plan 用 —— 删干净再让 planner 重新生成
  const info = db
    .prepare(`DELETE FROM character_life_beat WHERE assistant_id = ? AND plan_date = ?`)
    .run(assistantId, planDate);
  return info.changes || 0;
}

function hasLifePlanForDate({ assistantId, planDate }) {
  const row = db
    .prepare(`SELECT 1 FROM character_life_beat WHERE assistant_id = ? AND plan_date = ? LIMIT 1`)
    .get(assistantId, planDate);
  return !!row;
}

module.exports = {
  db,
  ALLOWED_MEMORY_TYPES,
  upsertCharacterState,
  insertConversationTurn,
  insertMemoryItem,
  insertOutboxEvent,
  withTransaction,
  insertBehaviorJournalEntry,
  getRecentConversationTurns,
  getRecentTurnsAcrossSessions,
  getRecentAssistantInteractions,
  getLastAssistantInteractionAt,
  getRecentMemoryItems,
  getConfidentFactsForAssistant,
  upsertAssistantProfile,
  getAssistantProfile,
  updateAssistantLastSession,
  updateAssistantProactiveCheckAt,
  countAllowAutoLifeAssistants,
  listAutoLifeAssistantProfiles,
  listProactiveAssistantProfiles,
  enqueueLocalOutboxMessage,
  pullPendingMessagesForUser,
  ackPulledMessage,
  searchConversation,
  searchMemory,
  findConversationTurnById,
  findConversationTurnByLogicalKey,
  findMemoryItemBySourceTurnId,
  updateConversationTurnContent,
  // character_life_beat (migration 035)
  insertLifeBeat,
  listPendingLifeBeats,
  listLifeBeatsForDate,
  getLatestActivatedLifeBeat,
  countActivatedAnchoredBeatsSince,
  markBeatActivated,
  markBeatSkipped,
  expireStaleLifeBeats,
  deleteLifeBeatsForDate,
  hasLifePlanForDate,
};
