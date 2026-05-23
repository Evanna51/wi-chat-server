/**
 * proactive 模块通用工具 / 常量 / LLM 调用包装。
 *
 * 拆分自原 src/services/proactivePlanService.js（2026-05-23）。
 * 这一层不依赖 store / longTerm / nextPush / watchdog，避免循环 require。
 */

const { getProvider } = require("../../llm");

// ── 通用文本工具 ──────────────────────────────────────────────────────

function clipText(input = "", maxLen = 240) {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

/**
 * 给 LLM 看的人类可读时间戳（上海时间）。Date 的 getX 方法依赖 process.env.TZ；
 * 我们在 ecosystem.config.js 里强制 TZ=Asia/Shanghai 保证一致。
 */
function formatLocalTs(ts) {
  if (!ts) return "未知";
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}（上海时间）`;
}

/**
 * 相对时间标签：把 ms epoch 时间戳变成"刚刚"/"3 小时前"/"昨天"/"3 天前"/"2 周前"。
 *
 * 用于 prompt 里给 LLM 看 "用户什么时候说过这件事" —— 之前 prompt 只给原始内容
 * 不给时间，LLM 会把 3 天前的吃饭说成"今天吃的怎么样"，造成时间错位幻觉。
 *
 * 边界用"自然日"切（不是滚动 24h），更贴近人的时间感：23 点说的事，过了凌晨
 * 就算"昨天"；不会出现"23 小时前 = 今天" / "25 小时前 = 昨天"这种割裂。
 */
function relativeTimeLabel(ts, now = Date.now()) {
  if (!ts) return "";
  const diff = now - ts;
  if (diff < 60 * 1000) return "刚刚";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  // 同一自然日内才说"X 小时前"，跨日就用"昨天/N 天前"
  const today0 = new Date(now); today0.setHours(0, 0, 0, 0);
  const tsDay = new Date(ts); tsDay.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((today0.getTime() - tsDay.getTime()) / (24 * 60 * 60 * 1000));
  if (dayDiff <= 0) return `${hours} 小时前`;
  if (dayDiff === 1) return "昨天";
  if (dayDiff === 2) return "前天";
  if (dayDiff < 7) return `${dayDiff} 天前`;
  if (dayDiff < 14) return "上周";
  if (dayDiff < 30) return `${Math.floor(dayDiff / 7)} 周前`;
  if (dayDiff < 365) return `${Math.floor(dayDiff / 30)} 个月前`;
  return `${Math.floor(dayDiff / 365)} 年前`;
}

function parseStrictJsonObject(text = "") {
  const normalized = String(text || "").trim();
  const fenced = normalized.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("plan ai output missing json object");
  }
  const parsed = JSON.parse(fenced.slice(start, end + 1));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("plan ai output not json object");
  }
  return parsed;
}

// ── 时间 / 抖动 ───────────────────────────────────────────────────────

function startOfDayMs(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

// 0..maxMs 的随机毫秒（整均匀分布）
function jitterMs(maxMs) {
  return Math.floor(Math.random() * (maxMs + 1));
}

// ── LLM 调用 ─────────────────────────────────────────────────────────

const VALID_INTENTS = new Set(["ask_followup", "check_in", "share_thought", "remind"]);

async function callLlmForPlanDraft(prompt, { temperature = 0.75, maxTokens = 600, assistantId } = {}) {
  const { content } = await getProvider().complete({
    messages: [
      { role: "system", content: "你是角色主动消息生成器。以角色身份写一条自然的主动消息。输出严格 JSON，不要 markdown 代码块。" },
      { role: "user", content: prompt },
    ],
    temperature,
    maxTokens,
    responseFormat: "json",
    callOpts: {
      kind: "proactive_plan",
      scopeKey: assistantId || null,
      summary: `proactive ${(prompt || "").slice(0, 30)}`,
    },
  });
  return parseStrictJsonObject(content);
}

// ── 跨模块共用的领域常量 ─────────────────────────────────────────────
//
// next_push 用的 72h 新鲜度窗口 —— longTerm 的 evaluateInactive7d 也要用（用户最近
// 72h 内有消息时长期 trigger 让位给 next_push），放 shared 避免循环依赖。

const NEXT_PUSH_TRIGGER_REASON = "next_push";
const NEXT_PUSH_FRESHNESS_WINDOW_MS = 72 * 60 * 60 * 1000;

// ── single-user 模型下的默认接收者 ───────────────────────────────────
//
// 之前依赖 local_subscribers 表；那张表已随 HTTP 轮询通道一起删除（migration 015）。
// WS 推送时 server 用此 userId 路由到 ws/connections.js 中已注册的 socket 集合；
// 多用户场景请改 env DEFAULT_USER_ID。

function pickFallbackUserId() {
  return process.env.DEFAULT_USER_ID || "default-user";
}

module.exports = {
  // text
  clipText,
  formatLocalTs,
  relativeTimeLabel,
  parseStrictJsonObject,
  // time
  startOfDayMs,
  jitterMs,
  // llm
  VALID_INTENTS,
  callLlmForPlanDraft,
  // domain
  NEXT_PUSH_TRIGGER_REASON,
  NEXT_PUSH_FRESHNESS_WINDOW_MS,
  pickFallbackUserId,
};
