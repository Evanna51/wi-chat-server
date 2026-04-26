CREATE TABLE memory_vectors_new (
  memory_item_id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  vector_json TEXT,
  vector_blob BLOB,
  vector_dim INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO memory_vectors_new (memory_item_id, assistant_id, vector_json, vector_blob, vector_dim, updated_at)
SELECT memory_item_id, assistant_id, vector_json, NULL, vector_dim, updated_at
FROM memory_vectors;

DROP TABLE memory_vectors;

ALTER TABLE memory_vectors_new RENAME TO memory_vectors;

CREATE INDEX IF NOT EXISTS idx_memory_vectors_assistant
ON memory_vectors(assistant_id);
