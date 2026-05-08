const fs = require("fs");
const { db, withTransaction } = require("../db");
const config = require("../config");

const DAY_MS = 24 * 60 * 60 * 1000;

function getDbFileBytes() {
  try {
    return fs.statSync(config.databasePath).size;
  } catch {
    return null;
  }
}

async function runRetentionSweepOnce() {
  const sizeBefore = getDbFileBytes();
  const now = Date.now();
  const retrievalLogCutoff = now - config.retentionRetrievalLogDays * DAY_MS;
  const outboxConsumedCutoff = now - config.retentionOutboxConsumedDays * DAY_MS;
  const localAckedCutoff = now - config.retentionLocalAckedDays * DAY_MS;
  const behaviorJournalCutoff = now - config.behaviorJournalPruneDays * DAY_MS;
  const providerCallLogCutoff = now - config.retentionProviderCallLogDays * DAY_MS;
  const auditLogCutoff = now - config.retentionAuditLogDays * DAY_MS;

  const result = withTransaction(() => {
    const retrievalLog = db
      .prepare("DELETE FROM memory_retrieval_log WHERE created_at < ?")
      .run(retrievalLogCutoff).changes;
    // memoryIndexer 写的是 status='done'，'consumed' 是历史/兼容值，一并清
    const outboxConsumed = db
      .prepare(
        "DELETE FROM outbox_events WHERE status IN ('done','consumed') AND updated_at < ?"
      )
      .run(outboxConsumedCutoff).changes;
    const localAcked = db
      .prepare(
        "DELETE FROM local_outbox_messages WHERE status = 'acked' AND acked_at IS NOT NULL AND acked_at < ?"
      )
      .run(localAckedCutoff).changes;
    const providerCallLog = db
      .prepare("DELETE FROM provider_call_log WHERE created_at < ?")
      .run(providerCallLogCutoff).changes;
    const auditLog = db
      .prepare("DELETE FROM memory_audit_log WHERE created_at < ?")
      .run(auditLogCutoff).changes;
    const behaviorJournalPruned = db
      .prepare(
        `UPDATE character_behavior_journal
         SET input_json = '{}', result_json = '{}'
         WHERE created_at < ?
           AND (length(input_json) > 2 OR length(result_json) > 2)`
      )
      .run(behaviorJournalCutoff).changes;
    return {
      retrievalLog,
      outboxConsumed,
      localAcked,
      providerCallLog,
      auditLog,
      behaviorJournalPruned,
    };
  });

  // trigram 分词的 FTS5 在频繁 update 后会大量碎片，optimize 把 segment 合并成一棵 b-tree。
  // conversation_turns_fts 已 drop（migration 020），只剩 memory_items_fts。
  try {
    db.exec(`INSERT INTO memory_items_fts(memory_items_fts) VALUES('optimize')`);
  } catch (err) {
    console.error("[retention] fts optimize failed:", err.message);
  }

  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  if (new Date().getDate() === 1) {
    try {
      db.exec("VACUUM");
    } catch (err) {
      console.error("[retention] vacuum failed:", err.message);
    }
  }

  const sizeAfter = getDbFileBytes();
  return {
    ...result,
    dbSizeBeforeBytes: sizeBefore,
    dbSizeAfterBytes: sizeAfter,
    dbSizeDeltaBytes:
      sizeBefore != null && sizeAfter != null ? sizeAfter - sizeBefore : null,
  };
}

module.exports = { runRetentionSweepOnce };
