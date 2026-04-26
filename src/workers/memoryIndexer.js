const { db } = require("../db");
const config = require("../config");
const { embedText } = require("../services/embeddingService");
const { vectorStore } = require("../services/vectorStore");
const { v7: uuidv7 } = require("uuid");

function nextRetryMs(retryCount) {
  const base = 1000;
  const cap = 60000;
  return Math.min(cap, base * 2 ** retryCount);
}

function fetchPendingEvents(limit = config.indexerBatchSize) {
  const now = Date.now();
  return db
    .prepare(
      `SELECT * FROM outbox_events
       WHERE status IN ('pending', 'retrying')
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(now, limit);
}

function markDone(eventId) {
  const now = Date.now();
  db.prepare(
    `UPDATE outbox_events SET status='done', updated_at=? WHERE id=?`
  ).run(now, eventId);
}

function markRetry(event, message) {
  const now = Date.now();
  const retryCount = (event.retry_count || 0) + 1;
  if (retryCount > config.indexerRetryMax) {
    db.prepare(
      `UPDATE outbox_events
       SET status='dead', retry_count=?, last_error=?, updated_at=?
       WHERE id=?`
    ).run(retryCount, message, now, event.id);
    db.prepare(
      `INSERT INTO dead_letter_events (id, source_event_id, reason, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(uuidv7(), event.id, message, event.payload_json, now);
    return;
  }

  db.prepare(
    `UPDATE outbox_events
     SET status='retrying',
         retry_count=?,
         last_error=?,
         next_retry_at=?,
         updated_at=?
     WHERE id=?`
  ).run(retryCount, message, now + nextRetryMs(retryCount), now, event.id);
}

async function processEvent(event) {
  const payload = JSON.parse(event.payload_json);
  if (event.event_type !== "memory_item.created") {
    markDone(event.id);
    return;
  }
  const memory = db
    .prepare(
      "SELECT id, assistant_id, session_id, content, created_at FROM memory_items WHERE id = ?"
    )
    .get(payload.memoryId);
  if (!memory) {
    markDone(event.id);
    return;
  }

  const vector = await embedText(memory.content);
  await vectorStore.upsert({
    memoryId: memory.id,
    assistantId: memory.assistant_id,
    vector,
  });

  const now = Date.now();
  db.prepare(
    `UPDATE memory_items
     SET vector_status='ready', vector_provider=?, vector_updated_at=?, updated_at=?
     WHERE id=?`
  ).run(vectorStore.name, now, now, memory.id);
  db.prepare(
    `INSERT INTO sync_checkpoints (name, last_event_id, updated_at)
     VALUES ('memory_indexer', ?, ?)
     ON CONFLICT(name) DO UPDATE SET last_event_id=excluded.last_event_id, updated_at=excluded.updated_at`
  ).run(event.id, now);
  markDone(event.id);
}

async function runIndexerOnce() {
  const events = fetchPendingEvents();
  for (const event of events) {
    try {
      await processEvent(event);
    } catch (error) {
      markRetry(event, error.message);
    }
  }
  return events.length;
}

function startMemoryIndexer() {
  let inFlight = false;
  let idleStreak = 0;

  const scheduleNext = (delayMs) => {
    setTimeout(tick, Math.max(100, delayMs));
  };

  const tick = async () => {
    if (inFlight) {
      scheduleNext(config.indexerPollMs);
      return;
    }
    inFlight = true;
    let processed = 0;
    try {
      processed = await runIndexerOnce();
      if (processed > 0) idleStreak = 0;
      else idleStreak = Math.min(idleStreak + 1, 8);
    } catch (error) {
      console.error("[indexer] tick failed:", error.message);
    } finally {
      inFlight = false;
    }

    const backoffMs = Math.min(
      config.indexerMaxIdlePollMs,
      config.indexerPollMs * 2 ** idleStreak
    );
    scheduleNext(processed > 0 ? config.indexerPollMs : backoffMs);
  };

  if (config.infoLogEnabled) {
    console.log(
      `[indexer] started: poll=${config.indexerPollMs}ms maxIdle=${config.indexerMaxIdlePollMs}ms provider=${vectorStore.name}`
    );
  }
  tick().catch((error) => console.error("[indexer] bootstrap failed:", error.message));
}

module.exports = { startMemoryIndexer, runIndexerOnce };
