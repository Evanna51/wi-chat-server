CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_item_id TEXT PRIMARY KEY,
  assistant_id TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  vector_dim INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_vectors_assistant
ON memory_vectors(assistant_id);
