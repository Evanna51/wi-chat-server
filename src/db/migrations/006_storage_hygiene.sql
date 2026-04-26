DROP TABLE IF EXISTS interaction_log;

ALTER TABLE autonomous_run_log RENAME TO character_behavior_journal;

DROP INDEX IF EXISTS idx_autonomous_run_log_type_created;
DROP INDEX IF EXISTS idx_autonomous_run_log_assistant_created;

CREATE INDEX IF NOT EXISTS idx_behavior_journal_type_created
ON character_behavior_journal(run_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_behavior_journal_assistant_created
ON character_behavior_journal(assistant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_behavior_journal_created
ON character_behavior_journal(created_at);

CREATE INDEX IF NOT EXISTS idx_outbox_status_consumed
ON outbox_events(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_local_outbox_acked
ON local_outbox_messages(status, acked_at);
