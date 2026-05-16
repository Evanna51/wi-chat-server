/**
 * attentionWindow — 1 小时滚动注意力（attention_window_1h）
 *
 * 时间尺度填补：
 *   - salient phrase  当前一句
 *   - attention 1h    过去 1 小时（本模块）  ← 滚动现场
 *   - active_topics   几天
 *   - episodes        1-2 周
 *   - reflection      月级
 *
 * 输出：
 *   {
 *     topics: ["...", ...]    // ≤5 个 3-12 字主题短语
 *     innerFocus: "..."        // ≤60 字，角色 latched on 什么（不是用户在说啥）
 *     emotionalTone: "..."     // 当前对话整体基调（calm/tense/intimate/...）
 *     turnCount: number
 *     ts: number
 *   }
 *
 * 实现：
 *   - 拉最近 1h conversation_turns（最多 30 条）
 *   - 构造 transcript → 1 次本地 LLM 调用（Qwen）→ JSON 输出
 *   - 内存缓存 5 min（per assistantId）
 *
 * LLM 失败 / 无 turn → 返回空 payload（调用方决定是否注入 prompt）
 */

const { ChatOpenAI } = require("@langchain/openai");
const config = require("../../config");
const { db } = require("../../db");

const TTL_MS = 5 * 60 * 1000;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_TURNS = 30;
const TURN_CONTENT_CAP = 150;

let cachedLlm = null;
let cachedProvider = null;
function getLlm() {
  const llmCfg = config.getServerLlmConfig();
  // provider 切换时丢弃旧 client（避免持有过期 baseUrl/apiKey）
  if (cachedLlm && cachedProvider === llmCfg.provider) return cachedLlm;
  cachedLlm = new ChatOpenAI({
    model: llmCfg.model,
    temperature: 0.2, // 低温度，稳定 JSON 输出
    maxTokens: 200,
    apiKey: llmCfg.apiKey,
    configuration: { baseURL: llmCfg.baseUrl },
  });
  cachedProvider = llmCfg.provider;
  return cachedLlm;
}

const CACHE = new Map(); // assistantId -> { ts, payload }

const PROMPT_TEMPLATE = `你是对话观察者。下面是一个 AI 角色和用户在过去 1 小时内的对话片段。
请输出 JSON，包含三个字段：

{
  "topics": ["...", ...],       // 他们正在聊的具体话题，最多 5 个，每个 3-12 字短语
  "inner_focus": "...",          // 一句话（≤30 字）描述这个 AI 角色内心 latched on 的点。不是复述用户说什么，而是角色"放不下"的细节
  "emotional_tone": "..."        // 整体基调，从这个枚举里选一个：calm / intimate / tense / playful / heavy / probing / reconnecting
}

对话内容（user/assistant 交替）：
{TRANSCRIPT}

只返回 JSON，不要任何解释。`;

const VALID_TONES = new Set([
  "calm", "intimate", "tense", "playful", "heavy", "probing", "reconnecting",
]);

function emptyPayload(now, turnCount = 0) {
  return {
    topics: [],
    innerFocus: null,
    emotionalTone: null,
    turnCount,
    ts: now,
  };
}

function parseLooseJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/**
 * @param {string} assistantId
 * @param {object} [opts]
 * @param {number} [opts.now=Date.now()]
 * @param {boolean} [opts.forceRefresh=false] 跳过缓存
 * @returns {Promise<{topics:string[], innerFocus:string|null, emotionalTone:string|null, turnCount:number, ts:number}>}
 */
async function buildAttention1h(assistantId, { now = Date.now(), forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = CACHE.get(assistantId);
    if (cached && now - cached.ts < TTL_MS) return cached.payload;
  }

  const since = now - WINDOW_MS;
  const turns = db
    .prepare(
      `SELECT role, content FROM conversation_turns
       WHERE assistant_id = ? AND created_at >= ? AND role IN ('user','assistant')
       ORDER BY created_at ASC LIMIT ?`
    )
    .all(assistantId, since, MAX_TURNS);

  if (!turns.length) {
    const payload = emptyPayload(now);
    CACHE.set(assistantId, { ts: now, payload });
    return payload;
  }

  const transcript = turns
    .map((t) => `${t.role}: ${(t.content || "").slice(0, TURN_CONTENT_CAP)}`)
    .join("\n");
  const prompt = PROMPT_TEMPLATE.replace("{TRANSCRIPT}", transcript);

  let payload = emptyPayload(now, turns.length);
  try {
    const resp = await getLlm().invoke([{ role: "user", content: prompt }]);
    const text = typeof resp.content === "string" ? resp.content : "";
    const json = parseLooseJson(text);
    if (json) {
      if (Array.isArray(json.topics)) {
        payload.topics = json.topics
          .slice(0, 5)
          .map((s) => String(s).slice(0, 30))
          .filter(Boolean);
      }
      if (typeof json.inner_focus === "string" && json.inner_focus.trim()) {
        payload.innerFocus = json.inner_focus.trim().slice(0, 60);
      }
      if (typeof json.emotional_tone === "string" && VALID_TONES.has(json.emotional_tone)) {
        payload.emotionalTone = json.emotional_tone;
      }
    }
  } catch (e) {
    console.warn("[attentionWindow] LLM failed:", e.message);
  }

  CACHE.set(assistantId, { ts: now, payload });
  return payload;
}

function invalidateCache(assistantId) {
  if (assistantId) CACHE.delete(assistantId);
  else CACHE.clear();
}

function _cacheStats() {
  return { size: CACHE.size, ttlMs: TTL_MS, windowMs: WINDOW_MS };
}

module.exports = { buildAttention1h, invalidateCache, _cacheStats };
