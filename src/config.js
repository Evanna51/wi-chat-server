const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

function parseAssistantIds(raw = "") {
  return String(raw)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const config = {
  port: Number(process.env.PORT || 8787),
  host: process.env.HOST || "127.0.0.1",
  databasePath:
    process.env.DATABASE_PATH ||
    path.join(__dirname, "..", "data", "character-behavior.db"),
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
  indexerMaxIdlePollMs: Number(process.env.INDEXER_MAX_IDLE_POLL_MS || 30000),
  infoLogEnabled: (process.env.INFO_LOG_ENABLED || "0") === "1",
  schedulerLeaderId: process.env.SCHEDULER_LEADER_ID || "local-1",
  schedulerLockTtlMs: Number(process.env.SCHEDULER_LOCK_TTL_MS || 60000),
  legacyFcmProactiveLockName:
    process.env.LEGACY_FCM_PROACTIVE_LOCK_NAME || "legacy_fcm_proactive_tick",
  legacyFcmProactiveCron: process.env.LEGACY_FCM_PROACTIVE_CRON || "off",
  lifeMemoryCron: process.env.LIFE_MEMORY_CRON || "*/30 * * * *",
  proactiveMessageCron: process.env.PROACTIVE_MESSAGE_CRON || "*/10 * * * *",
  lifeMemoryLockName: process.env.LIFE_MEMORY_LOCK_NAME || "life_memory_tick",
  proactiveMessageLockName:
    process.env.PROACTIVE_MESSAGE_LOCK_NAME || "proactive_message_tick",
  autonomousAssistantIds: parseAssistantIds(process.env.AUTONOMOUS_ASSISTANT_IDS || ""),
  autonomousDryRun: (process.env.AUTONOMOUS_DRY_RUN || "1") === "1",
  autonomousPushEnabled: (process.env.AUTONOMOUS_PUSH_ENABLED || "0") === "1",
  autonomousQuietHours: process.env.AUTONOMOUS_QUIET_HOURS || "0-7",
  autonomousMinMessageIntervalMs: Number(
    process.env.AUTONOMOUS_MIN_MESSAGE_INTERVAL_MS || 2 * 60 * 60 * 1000
  ),
  autonomousRecentUserSilenceMs: Number(
    process.env.AUTONOMOUS_RECENT_USER_SILENCE_MS || 30 * 60 * 1000
  ),
  autonomousSkipAfterInteractionMs: Number(
    process.env.AUTONOMOUS_SKIP_AFTER_INTERACTION_MS || 10 * 60 * 1000
  ),
  autonomousMessageCheckIntervalMs: Number(
    process.env.AUTONOMOUS_MESSAGE_CHECK_INTERVAL_MS || 60 * 60 * 1000
  ),
  autonomousInactive7dThresholdMs: Number(
    process.env.AUTONOMOUS_INACTIVE_7D_THRESHOLD_MS || 7 * 24 * 60 * 60 * 1000
  ),
  autonomousInactive30dThresholdMs: Number(
    process.env.AUTONOMOUS_INACTIVE_30D_THRESHOLD_MS || 30 * 24 * 60 * 60 * 1000
  ),
  autonomousMessageIntervalAfter7dMs: Number(
    process.env.AUTONOMOUS_MESSAGE_INTERVAL_AFTER_7D_MS || 24 * 60 * 60 * 1000
  ),
  autonomousMessageIntervalAfter30dMs: Number(
    process.env.AUTONOMOUS_MESSAGE_INTERVAL_AFTER_30D_MS || 7 * 24 * 60 * 60 * 1000
  ),
  localPullMessageTtlMs: Number(
    process.env.LOCAL_PULL_MESSAGE_TTL_MS || 7 * 24 * 60 * 60 * 1000
  ),
  localPullRepullGapMs: Number(process.env.LOCAL_PULL_REPULL_GAP_MS || 15 * 1000),
  fcmProjectId: process.env.FCM_PROJECT_ID || "",
  fcmServiceAccountPath: process.env.FCM_SERVICE_ACCOUNT_PATH || "",
  appApiKey: process.env.APP_API_KEY || "dev-local-key",
  requireApiKey: (process.env.REQUIRE_API_KEY || "1") === "1",
  debugHttpLog: (process.env.DEBUG_HTTP_LOG || "0") === "1",
  timezone: process.env.SCHEDULER_TIMEZONE || "Asia/Shanghai",
};

module.exports = config;
