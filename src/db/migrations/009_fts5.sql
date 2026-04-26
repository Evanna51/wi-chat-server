CREATE VIRTUAL TABLE IF NOT EXISTS _fts5_probe USING fts5(x);
DROP TABLE _fts5_probe;

CREATE VIRTUAL TABLE IF NOT EXISTS conversation_turns_fts USING fts5(
  content,
  assistant_id UNINDEXED,
  session_id UNINDEXED,
  role UNINDEXED,
  content='conversation_turns',
  content_rowid='rowid',
  tokenize='trigram case_sensitive 0'
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
  content,
  assistant_id UNINDEXED,
  memory_type UNINDEXED,
  content='memory_items',
  content_rowid='rowid',
  tokenize='trigram case_sensitive 0'
);

INSERT INTO conversation_turns_fts(rowid, content, assistant_id, session_id, role)
SELECT rowid, content, assistant_id, session_id, role FROM conversation_turns;

INSERT INTO memory_items_fts(rowid, content, assistant_id, memory_type)
SELECT rowid, content, assistant_id, memory_type FROM memory_items;

CREATE TRIGGER IF NOT EXISTS conversation_turns_ai AFTER INSERT ON conversation_turns BEGIN
  INSERT INTO conversation_turns_fts(rowid, content, assistant_id, session_id, role)
  VALUES (new.rowid, new.content, new.assistant_id, new.session_id, new.role);
END;

CREATE TRIGGER IF NOT EXISTS conversation_turns_ad AFTER DELETE ON conversation_turns BEGIN
  INSERT INTO conversation_turns_fts(conversation_turns_fts, rowid, content, assistant_id, session_id, role)
  VALUES ('delete', old.rowid, old.content, old.assistant_id, old.session_id, old.role);
END;

CREATE TRIGGER IF NOT EXISTS conversation_turns_au AFTER UPDATE ON conversation_turns BEGIN
  INSERT INTO conversation_turns_fts(conversation_turns_fts, rowid, content, assistant_id, session_id, role)
  VALUES ('delete', old.rowid, old.content, old.assistant_id, old.session_id, old.role);
  INSERT INTO conversation_turns_fts(rowid, content, assistant_id, session_id, role)
  VALUES (new.rowid, new.content, new.assistant_id, new.session_id, new.role);
END;

CREATE TRIGGER IF NOT EXISTS memory_items_ai AFTER INSERT ON memory_items BEGIN
  INSERT INTO memory_items_fts(rowid, content, assistant_id, memory_type)
  VALUES (new.rowid, new.content, new.assistant_id, new.memory_type);
END;

CREATE TRIGGER IF NOT EXISTS memory_items_ad AFTER DELETE ON memory_items BEGIN
  INSERT INTO memory_items_fts(memory_items_fts, rowid, content, assistant_id, memory_type)
  VALUES ('delete', old.rowid, old.content, old.assistant_id, old.memory_type);
END;

CREATE TRIGGER IF NOT EXISTS memory_items_au AFTER UPDATE ON memory_items BEGIN
  INSERT INTO memory_items_fts(memory_items_fts, rowid, content, assistant_id, memory_type)
  VALUES ('delete', old.rowid, old.content, old.assistant_id, old.memory_type);
  INSERT INTO memory_items_fts(rowid, content, assistant_id, memory_type)
  VALUES (new.rowid, new.content, new.assistant_id, new.memory_type);
END;
