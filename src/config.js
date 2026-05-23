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
  // 默认 1024 = bge-m3 / qwen-embedding 当前生产 embedding 维度。
  // 启动时会从 memory_vectors.vector_dim 反查确认；不一致直接 fatal exit。
  vectorDim: Number(process.env.VECTOR_DIM || 1024),
  vectorProvider: process.env.VECTOR_PROVIDER || "hnswlib",
  vectorK: Number(process.env.VECTOR_K || 20),
  embedBaseUrl: process.env.EMBED_BASE_URL || "",
  embedModel: process.env.EMBED_MODEL || "local-embedding",
  qwenBaseUrl: process.env.QWEN_BASE_URL || "http://127.0.0.1:1234/v1",
  qwenApiKey: process.env.QWEN_API_KEY || "not-required",
  qwenModel: process.env.QWEN_MODEL || "qwen2.5:7b-instruct",
  qwenTemperature: Number(process.env.QWEN_TEMPERATURE || 0.7),
  qwenMaxTokens: Number(process.env.QWEN_MAX_TOKENS || 200),
  // DeepSeek（云端备选；server-side LLM 调用切换）
  deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || "",
  deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",
  // server-side LLM 调用走哪家 (qwen=本地 LM Studio / deepseek=云端).
  // 影响：attentionWindow / registerRouter / langchainQwenService。
  serverLlmProvider: (process.env.SERVER_LLM_PROVIDER || "qwen").toLowerCase(),
  // introspection-side LLM：memory_classify / persona_extract / episode_build / reflect。
  // 默认继承 SERVER_LLM_PROVIDER（通常是本地小模型），可单独覆盖。
  introspectionLlmProvider: (process.env.INTROSPECTION_LLM_PROVIDER || process.env.SERVER_LLM_PROVIDER || "qwen").toLowerCase(),
  // Web search（proactive skip-fallback 找热点）。tavily 是当前唯一 provider。
  // 不配 TAVILY_API_KEY 时 webSearchService 会优雅降级（返回 api_key_missing），
  // 整个 proactive 链路接受原 skip，不影响主流程。
  webSearchProvider: (process.env.WEB_SEARCH_PROVIDER || "tavily").toLowerCase(),
  webSearchDailyCap: Number(process.env.WEB_SEARCH_DAILY_CAP || 3),
  tavilyApiKey: process.env.TAVILY_API_KEY || "",
  memoryRetrievalEnabled: (process.env.MEMORY_RETRIEVAL_ENABLED || "1") === "1",
  retrievalTopK: Number(process.env.RETRIEVAL_TOP_K || 8),
  retrievalWindowDays: Number(process.env.RETRIEVAL_WINDOW_DAYS || 30),
  indexerBatchSize: Number(process.env.INDEXER_BATCH_SIZE || 20),
  indexerRetryMax: Number(process.env.INDEXER_RETRY_MAX || 5),
  indexerPollMs: Number(process.env.INDEXER_POLL_MS || 2000),
  indexerMaxIdlePollMs: Number(process.env.INDEXER_MAX_IDLE_POLL_MS || 30000),
  infoLogEnabled: (process.env.INFO_LOG_ENABLED || "0") === "1",
  planGenerationCron: process.env.PLAN_GENERATION_CRON || "0 6 * * *",
  planExecutorIntervalMs: Number(process.env.PLAN_EXECUTOR_INTERVAL_MS || 60000),
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
  retentionSweepCron: process.env.RETENTION_SWEEP_CRON || "30 3 * * *",
  retentionRetrievalLogDays: Number(process.env.RETENTION_RETRIEVAL_LOG_DAYS || 30),
  retentionOutboxConsumedDays: Number(process.env.RETENTION_OUTBOX_CONSUMED_DAYS || 7),
  retentionLocalAckedDays: Number(process.env.RETENTION_LOCAL_ACKED_DAYS || 30),
  retentionProviderCallLogDays: Number(process.env.RETENTION_PROVIDER_CALL_LOG_DAYS || 14),
  retentionAuditLogDays: Number(process.env.RETENTION_AUDIT_LOG_DAYS || 90),
  behaviorJournalPruneDays: Number(process.env.BEHAVIOR_JOURNAL_PRUNE_DAYS || 90),
  fcmProjectId: process.env.FCM_PROJECT_ID || "",
  fcmServiceAccountPath: process.env.FCM_SERVICE_ACCOUNT_PATH || "",
  appApiKey: process.env.APP_API_KEY || "dev-local-key",
  requireApiKey: (process.env.REQUIRE_API_KEY || "0") === "1",
  debugHttpLog: (process.env.DEBUG_HTTP_LOG || "0") === "1",
  timezone: process.env.SCHEDULER_TIMEZONE || "Asia/Shanghai",
  llmProvider: process.env.LLM_PROVIDER || "qwen",
  llmEmbedProvider: process.env.LLM_EMBED_PROVIDER || "",
  backupDailyCron: process.env.BACKUP_DAILY_CRON || "0 3 * * *",
  backupWeeklyCron: process.env.BACKUP_WEEKLY_CRON || "30 2 * * 0",
  backupIncrKeepDays: Number(process.env.BACKUP_INCR_KEEP_DAYS || 8),
  backupFullKeepWeeks: Number(process.env.BACKUP_FULL_KEEP_WEEKS || 4),
  memoryClassifyCron: process.env.MEMORY_CLASSIFY_CRON || "*/10 * * * *",
  deadLetterMonitorCron: process.env.DEAD_LETTER_MONITOR_CRON || "0 9 * * *",   // 每天 09:00 扫一次
  // Phase 2 narrative + topic 后台维护
  episodeBuilderCron: process.env.EPISODE_BUILDER_CRON || "30 3 * * *",         // 每天 03:30，避开 backup 03:00
  topicDormantSweepCron: process.env.TOPIC_DORMANT_SWEEP_CRON || "0 4 * * *",   // 每天 04:00
  // Phase 3 weekly relationship reflection
  reflectionWeeklyCron: process.env.REFLECTION_WEEKLY_CRON || "30 4 * * 0",     // 每周日 04:30
  // 角色日记 / 周记（journalService）
  dailyJournalCron: process.env.DAILY_JOURNAL_CRON || "30 10 * * *",            // 每天 10:30 写昨天
  weeklyJournalCron: process.env.WEEKLY_JOURNAL_CRON || "30 0 * * 1",           // 周一 00:30 写上周
};

/**
 * 返回 server-side LLM (attention / router / etc) 当前应该用的 endpoint 配置。
 * 由 SERVER_LLM_PROVIDER env 切换：qwen (默认, 本地 LM Studio) / deepseek (云端).
 */
function _buildLlmConfig(providerName) {
  if (providerName === "deepseek") {
    return {
      provider: "deepseek",
      model: config.deepseekModel,
      baseUrl: config.deepseekBaseUrl,
      apiKey: config.deepseekApiKey,
    };
  }
  return {
    provider: "qwen",
    model: config.qwenModel,
    baseUrl: config.qwenBaseUrl,
    apiKey: config.qwenApiKey,
  };
}

function getServerLlmConfig() {
  return _buildLlmConfig(config.serverLlmProvider);
}

function getIntrospectionLlmConfig() {
  return _buildLlmConfig(config.introspectionLlmProvider);
}

module.exports = Object.assign(config, { getServerLlmConfig, getIntrospectionLlmConfig });
