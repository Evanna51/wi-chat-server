/**
 * Tavily search provider —— https://docs.tavily.com/docs/rest-api/api-reference
 *
 * 用 Node fetch 调 POST https://api.tavily.com/search。
 * 不写自己的 timeout / retry 包装，挂在 registeredFetch 上跟项目其它 outbound HTTP
 * 共享 call registry（admin 可以 cancel / 看到在飞调用）。
 */

const { registeredFetch } = require("../../utils/registeredFetch");

const TAVILY_URL = "https://api.tavily.com/search";
const TIMEOUT_MS = 15000;

/**
 * @param {object} args
 * @param {string} args.apiKey       Tavily API key
 * @param {string} args.query        搜索词
 * @param {string} [args.topic]      'general' | 'news'。默认 'news' 适合"找热点"场景。
 * @param {number} [args.maxResults] 默认 5
 * @param {number} [args.days]       仅 topic='news' 有效，限定最近 N 天。默认 7。
 * @param {string} [args.scopeKey]   call registry scope（默认 assistantId）
 * @returns {Promise<{results: Array<{title,url,content,score,publishedDate?}>, query: string, answer?: string}>}
 */
async function search({
  apiKey,
  query,
  topic = "news",
  maxResults = 5,
  days = 7,
  scopeKey = null,
} = {}) {
  if (!apiKey) throw new Error("tavily_api_key_missing");
  if (!query || !query.trim()) throw new Error("tavily_query_empty");

  const body = {
    api_key: apiKey,
    query: query.trim().slice(0, 400),
    search_depth: "basic", // basic 比 advanced 快很多 + 便宜，热点场景够用
    topic,
    max_results: Math.max(1, Math.min(10, maxResults)),
    include_answer: false,
    include_raw_content: false,
  };
  if (topic === "news") body.days = Math.max(1, Math.min(30, days));

  const res = await registeredFetch(
    TAVILY_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    {
      timeoutMs: TIMEOUT_MS,
      kind: "web_search",
      scopeKey,
      summary: `tavily ${query.slice(0, 40)}`,
    }
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`tavily http ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return {
    query,
    results: results.map((r) => ({
      title: String(r.title || "").slice(0, 200),
      url: String(r.url || "").slice(0, 500),
      content: String(r.content || "").slice(0, 800),
      score: typeof r.score === "number" ? r.score : 0,
      publishedDate: r.published_date || null,
    })),
    answer: data?.answer || null,
  };
}

module.exports = { search };
