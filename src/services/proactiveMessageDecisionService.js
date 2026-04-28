const { z } = require("zod");
const config = require("../config");
const { fetchWithTimeout } = require("../utils/fetchWithTimeout");
const {
  getRecentConversationTurns,
  getRecentAssistantInteractions,
  getRecentMemoryItems,
} = require("../db");
const { getTimeBucket } = require("./characterEngine");

function clipText(input = "", maxLen = 240) {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function normalizeIntent(value = "") {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  const map = {
    care: "care",
    caring: "care",
    support: "care",
    empathy: "care",
    checkin: "checkin",
    greeting: "checkin",
    hello: "checkin",
    ping: "checkin",
    share: "share",
    update: "share",
    task: "task",
    reminder: "task",
  };
  return map[raw] || "checkin";
}

function normalizeDecision(raw = {}) {
  const shouldPushMessage =
    typeof raw.shouldPushMessage === "boolean"
      ? raw.shouldPushMessage
      : String(raw.shouldPushMessage || "").trim().toLowerCase() === "true";
  const reason = clipText(raw.reason || "model_reason_unknown", 255);
  const messageIntent = normalizeIntent(raw.messageIntent);
  const draft = clipText(raw.draft || "", 500);
  return { shouldPushMessage, reason, messageIntent, draft };
}

const proactiveMessageSchema = z
  .object({
    shouldPushMessage: z.boolean(),
    reason: z.string().min(1).max(255),
    messageIntent: z.enum(["care", "checkin", "share", "task"]),
    draft: z.string().max(500).default(""),
  })
  .strict();

function parseStrictJsonObject(text = "") {
  const normalized = String(text || "").trim();
  if (normalized.startsWith("{") && normalized.endsWith("}")) {
    const parsed = JSON.parse(normalized);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("proactive message ai output is not json object");
    }
    return parsed;
  }
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("proactive message ai output is not strict json object");
  }
  const parsed = JSON.parse(normalized.slice(start, end + 1));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("proactive message ai output is not json object");
  }
  return parsed;
}

function buildPrompt({
  assistantId,
  state,
  assistantProfile,
  now,
  recentTurns,
  recentInteractions,
  recentMemories,
}) {
  const timeBucket = getTimeBucket(new Date(now));
  const turnLines = recentTurns
    .slice(0, 8)
    .map((item) => `- ${item.role}: ${clipText(item.content, 120)}`)
    .join("\n");
  const memoryLines = recentMemories
    .slice(0, 4)
    .map((item) => `- ${item.memory_type}: ${clipText(item.content, 140)}`)
    .join("\n");
  const interactionLines = recentInteractions
    .slice(0, 8)
    .map((item) => `- [${item.session_id}] ${item.role}: ${clipText(item.content, 120)}`)
    .join("\n");

  return [
    "你是主动对话决策器。你需要判断当前是否应该由角色主动发起一条消息。",
    "只输出一个JSON对象，不要任何额外文本。",
    '格式: {"shouldPushMessage":true|false,"reason":"snake_case_reason","messageIntent":"care|checkin|share|task","draft":"..."}',
    "规则:",
    "1) 若最近用户活跃很高或刚互动，不应打扰。",
    "2) 若最近生活记忆显示有可自然分享的近况，可倾向发起。",
    "3) draft为20-60字，不自我介绍，不提及AI；如果不发起可为空。",
    `assistantId: ${assistantId}`,
    `角色名: ${assistantProfile.characterName || assistantId}`,
    `角色背景: ${clipText(assistantProfile.characterBackground || "无", 600)}`,
    `熟悉度: ${state.familiarity || 0}/100`,
    `时间段: ${timeBucket}`,
    `当前时间戳: ${now}`,
    "当前会话最近对话:",
    turnLines || "- 无（当前会话）",
    "跨会话最近互动:",
    interactionLines || "- 无（跨会话）",
    "最近生活/工作记忆:",
    memoryLines || "- 无",
  ].join("\n");
}

async function runAiDecision(prompt) {
  const endpoint = `${config.qwenBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.qwenApiKey}`,
    },
    body: JSON.stringify({
      model: config.qwenModel,
      temperature: 0,
      max_tokens: 180,
      messages: [{ role: "user", content: prompt }],
    }),
  }, 30000);
  if (!res.ok) {
    throw new Error(`proactive message ai failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const content = body?.choices?.[0]?.message?.content || "";
  const raw = parseStrictJsonObject(content);
  return proactiveMessageSchema.parse(normalizeDecision(raw));
}

async function shouldGenerateProactiveMessage({
  assistantId,
  sessionId,
  state,
  assistantProfile = {},
  now = Date.now(),
}) {
  const recentTurns = getRecentConversationTurns({ assistantId, sessionId, limit: 10 });
  const recentInteractions = getRecentAssistantInteractions({ assistantId, limit: 12 });
  const recentMemories = getRecentMemoryItems({
    assistantId,
    memoryTypes: ["life_event", "work_event"],
    limit: 6,
  });

  const prompt = buildPrompt({
    assistantId,
    state,
    assistantProfile,
    now,
    recentTurns,
    recentInteractions,
    recentMemories,
  });

  try {
    const decision = await runAiDecision(prompt);
    return {
      ok: true,
      decision,
      context: { recentTurns, recentInteractions, recentMemories },
    };
  } catch (error) {
    return {
      ok: false,
      decision: {
        shouldPushMessage: false,
        reason: "fallback_non_json",
        messageIntent: "checkin",
        draft: "",
      },
      context: { recentTurns, recentInteractions, recentMemories },
      error: error.message,
    };
  }
}

module.exports = { shouldGenerateProactiveMessage };
