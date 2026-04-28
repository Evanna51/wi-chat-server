/**
 * 记录每次 LLM 调用到 provider_call_log 表。
 * 表由 migration 012 创建；若表不存在则静默跳过（向后兼容）。
 */
let _db = null;
let _stmt = null;
let _tableChecked = false;
let _tableExists = false;

function getDb() {
  if (!_db) _db = require("../db").db;
  return _db;
}

function ensureChecked() {
  if (_tableChecked) return;
  _tableChecked = true;
  try {
    getDb().prepare("SELECT 1 FROM provider_call_log LIMIT 1").get();
    _tableExists = true;
  } catch {
    _tableExists = false;
  }
}

function getStmt() {
  if (_stmt) return _stmt;
  _stmt = getDb().prepare(
    `INSERT INTO provider_call_log
     (provider, call_type, model, input_tokens, output_tokens, latency_ms, ok, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  return _stmt;
}

function recordProviderCall({ provider, callType, model, inputTokens, outputTokens, latencyMs, ok }) {
  ensureChecked();
  if (!_tableExists) return;
  try {
    getStmt().run(
      provider,
      callType,
      model || "",
      inputTokens || 0,
      outputTokens || 0,
      latencyMs || 0,
      ok ? 1 : 0,
      Date.now()
    );
  } catch {
    // non-critical: logging must not break LLM calls
  }
}

module.exports = { recordProviderCall };
