const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const config = {
  port: Number(process.env.PORT || 8787),
  databasePath:
    process.env.DATABASE_PATH ||
    path.join(__dirname, "..", "data", "character-push.db"),
  vectorIndexPath:
    process.env.VECTOR_INDEX_PATH ||
    path.join(__dirname, "..", "data", "vector-index.bin"),
  vectorMetaPath:
    process.env.VECTOR_META_PATH ||
    path.join(__dirname, "..", "data", "vector-meta.json"),
  vectorDim: Number(process.env.VECTOR_DIM || 256),
  vectorProvider: process.env.VECTOR_PROVIDER || "hnswlib",
  vectorK: Number(process.env.VECTOR_K || 20),
  embedBaseUrl: process.env.EMBED_BASE_URL || "",
  embedModel: process.env.EMBED_MODEL || "local-embedding",
  qwenBaseUrl: process.env.QWEN_BASE_URL || "http://127.0.0.1:1234/v1",
  qwenApiKey: process.env.QWEN_API_KEY || "not-required",
  qwenModel: process.env.QWEN_MODEL || "qwen2.5:7b-instruct",
  qwenTemperature: Number(process.env.QWEN_TEMPERATURE || 0.7),
  qwenMaxTokens: Number(process.env.QWEN_MAX_TOKENS || 200),
  memoryRetrievalEnabled: (process.env.MEMORY_RETRIEVAL_ENABLED || "1") === "1",
  retrievalStrategy: process.env.RETRIEVAL_STRATEGY || "v1",
  retrievalTopK: Number(process.env.RETRIEVAL_TOP_K || 8),
  retrievalWindowDays: Number(process.env.RETRIEVAL_WINDOW_DAYS || 30),
  indexerBatchSize: Number(process.env.INDEXER_BATCH_SIZE || 20),
  indexerRetryMax: Number(process.env.INDEXER_RETRY_MAX || 5),
  indexerPollMs: Number(process.env.INDEXER_POLL_MS || 2000),
  schedulerLeaderId: process.env.SCHEDULER_LEADER_ID || "local-1",
  schedulerLockTtlMs: Number(process.env.SCHEDULER_LOCK_TTL_MS || 60000),
  schedulerLockName: process.env.SCHEDULER_LOCK_NAME || "proactive_tick",
  proactiveCron: process.env.PROACTIVE_CRON || "*/15 * * * *",
  fcmProjectId: process.env.FCM_PROJECT_ID || "",
  fcmServiceAccountPath: process.env.FCM_SERVICE_ACCOUNT_PATH || "",
  appApiKey: process.env.APP_API_KEY || "dev-local-key",
  timezone: process.env.SCHEDULER_TIMEZONE || "Asia/Shanghai",
};

module.exports = config;
