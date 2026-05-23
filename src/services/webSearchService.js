/**
 * Web search 抽象层 + 每角色每日配额闸门。
 *
 * 当前只接 Tavily（user 选定 2026-05-23）。其他 provider（Brave / SerpAPI /
 * DuckDuckGo）走相同 interface 加到 src/services/webSearch/ 下即可，无需改本文件。
 *
 * 配额：每个 assistant 每自然日最多 N 次（默认 3，env: WEB_SEARCH_DAILY_CAP）。
 * 配额计数从 character_behavior_journal 表 run_type='web_search' 行扫，
 * 不另起表节省 DB 占用。
 *
 * 单次失败不抛错 —— 返回 { ok:false, reason } 让调用方平滑降级。
 */

const config = require("../config");
const { db, insertBehaviorJournalEntry } = require("../db");

function _todayStartMs(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 数本日 web_search 调用次数（不分成功失败 — 失败也消耗配额，防止 retry 风暴）。
 */
function countTodayCalls(assistantId, now = Date.now()) {
  if (!assistantId) return 0;
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM character_behavior_journal
          WHERE assistant_id = ?
            AND run_type = 'web_search'
            AND created_at >= ?`
      )
      .get(assistantId, _todayStartMs(now));
    return row?.n || 0;
  } catch {
    return 0;
  }
}

function _loadProvider(name) {
  switch ((name || "tavily").toLowerCase()) {
    case "tavily":
      return require("./webSearch/tavily");
    // 未来加 provider 在这里 dispatch
    default:
      throw new Error(`unsupported_web_search_provider: ${name}`);
  }
}

/**
 * 跑一次 web search。
 *
 * @param {object} args
 * @param {string} args.assistantId   配额 & journal 维度
 * @param {string} args.query          搜索词
 * @param {string} [args.topic]        'general' | 'news'，默认 'news'
 * @param {number} [args.maxResults]   默认 5
 * @returns {Promise<{ok:true, query, results}|{ok:false, reason, error?}>}
 */
async function runWebSearch({
  assistantId,
  query,
  topic = "news",
  maxResults = 5,
  now = Date.now(),
} = {}) {
  if (!query || !String(query).trim()) {
    return { ok: false, reason: "empty_query" };
  }

  const providerName = (config.webSearchProvider || "tavily").toLowerCase();
  let provider;
  try {
    provider = _loadProvider(providerName);
  } catch (e) {
    return { ok: false, reason: "provider_not_loaded", error: e.message };
  }

  // 配额：每角色每自然日 N 次（env WEB_SEARCH_DAILY_CAP，默认 3）。
  // **先检查再增 counter** —— 失败也算消耗，由 journal_entry 写入兜底。
  const cap = config.webSearchDailyCap || 3;
  if (assistantId) {
    const used = countTodayCalls(assistantId, now);
    if (used >= cap) {
      return { ok: false, reason: "daily_cap_exceeded", used, cap };
    }
  }

  // Tavily 是当前唯一 provider，apiKey 从 config 读；未来 multi-provider
  // 时按 providerName 分发不同 api key
  const apiKey = providerName === "tavily" ? config.tavilyApiKey : null;
  if (!apiKey) {
    return { ok: false, reason: "api_key_missing", provider: providerName };
  }

  let result;
  try {
    result = await provider.search({
      apiKey,
      query,
      topic,
      maxResults,
      scopeKey: assistantId || null,
    });
  } catch (e) {
    // 仍然写一条 journal 记录配额消耗
    try {
      insertBehaviorJournalEntry({
        runType: "web_search",
        assistantId: assistantId || "_system",
        sessionId: null,
        shouldPushMessage: false,
        status: "error",
        reason: "provider_error",
        input: { query, topic, provider: providerName },
        result: {},
        errorMessage: e.message || String(e),
        createdAt: now,
      });
    } catch { /* ignore */ }
    return { ok: false, reason: "provider_error", error: e.message };
  }

  // 成功也写一条 journal，便于 admin 看调用历史
  try {
    insertBehaviorJournalEntry({
      runType: "web_search",
      assistantId: assistantId || "_system",
      sessionId: null,
      shouldPushMessage: false,
      status: "ok",
      reason: "search_completed",
      input: { query, topic, provider: providerName, maxResults },
      result: { resultCount: result.results.length, topUrls: result.results.slice(0, 3).map((r) => r.url) },
      createdAt: now,
    });
  } catch { /* ignore */ }

  return { ok: true, query: result.query, results: result.results, answer: result.answer };
}

module.exports = {
  runWebSearch,
  countTodayCalls,
};
