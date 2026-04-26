const { db, withTransaction } = require("../db");
const config = require("../config");

const DAY_MS = 24 * 60 * 60 * 1000;

async function runRetentionSweepOnce() {
  const now = Date.now();
  const retrievalLogCutoff = now - config.retentionRetrievalLogDays * DAY_MS;
  const outboxConsumedCutoff = now - config.retentionOutboxConsumedDays * DAY_MS;
  const localAckedCutoff = now - config.retentionLocalAckedDays * DAY_MS;
  const behaviorJournalCutoff = now - config.behaviorJournalPruneDays * DAY_MS;

  const result = withTransaction(() => {
    const retrievalLog = db
      .prepare("DELETE FROM memory_retrieval_log WHERE created_at < ?")
      .run(retrievalLogCutoff).changes;
    const outboxConsumed = db
      .prepare(
        "DELETE FROM outbox_events WHERE status = 'consumed' AND updated_at < ?"
      )
      .run(outboxConsumedCutoff).changes;
    const localAcked = db
      .prepare(
        "DELETE FROM local_outbox_messages WHERE status = 'acked' AND acked_at IS NOT NULL AND acked_at < ?"
      )
      .run(localAckedCutoff).changes;
    const behaviorJournalPruned = db
      .prepare(
        `UPDATE character_behavior_journal
         SET input_json = '{}', result_json = '{}'
         WHERE created_at < ?
           AND (length(input_json) > 2 OR length(result_json) > 2)`
      )
      .run(behaviorJournalCutoff).changes;
    return { retrievalLog, outboxConsumed, localAcked, behaviorJournalPruned };
  });

  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  if (new Date().getDate() === 1) {
    db.exec("VACUUM");
  }

  return result;
}

module.exports = { runRetentionSweepOnce };
