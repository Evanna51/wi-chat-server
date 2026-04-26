const { z } = require("zod");
const { v7: uuidv7 } = require("uuid");
const config = require("../config");
const {
  getRecentConversationTurns,
  getRecentAssistantInteractions,
  getRecentMemoryItems,
  insertMemoryItem,
  insertOutboxEvent,
} = require("../db");
const { getTimeBucket } = require("./characterEngine");

function clipText(input = "", maxLen = 500) {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function normalizeLifeMemoryDecision(raw = {}) {
  const memoryType = raw.memoryType === "work_event" ? "work_event" : "life_event";
  const summary = clipText(raw.summary || "", 500);
  const confidenceRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0.5;
  const why = clipText(raw.why || "model_reason_unknown", 255);
  const shouldPersist =
    typeof raw.shouldPersist === "boolean"
      ? raw.shouldPersist
      : String(raw.shouldPersist || "").trim().toLowerCase() === "true";
  return { memoryType, summary, confidence, why, shouldPersist };
}

const lifeMemorySchema = z
  .object({
    memoryType: z.enum(["life_event", "work_event"]),
    summary: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1),
    why: z.string().min(1).max(255),
    shouldPersist: z.boolean(),
  })
  .strict();

function stableHash(text = "") {
  let h = 0;
  const src = String(text || "");
  for (let i = 0; i < src.length; i += 1) {
    h = (h * 31 + src.charCodeAt(i)) >>> 0;
  }
  return h;
}

function shouldSuggestSpecialEvent({ assistantId, now }) {
  // Keep "special things" as low-frequency spice (~15%).
  const slot = Math.floor(now / (30 * 60 * 1000));
  const score = stableHash(`${assistantId}:${slot}`) % 100;
  return score < 15;
}

function shouldUseExactTimePhrase({ assistantId, now }) {
  // Mix timeBucket vs exact HH:mm for style variety.
  const slot = Math.floor(now / (10 * 60 * 1000));
  const score = stableHash(`time:${assistantId}:${slot}`) % 100;
  return score < 40;
}

function formatClockTime(now) {
  const d = new Date(now);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function buildRoutineHint(now, lastInteractionAt = 0) {
  const hour = new Date(now).getHours();
  const idleMs = lastInteractionAt > 0 ? now - lastInteractionAt : Number.POSITIVE_INFINITY;
  const isRecentlyActive = idleMs <= 60 * 60 * 1000;
  if (hour >= 1 && hour < 6 && !isRecentlyActive) {
    return "当前时段更可能在睡觉/浅眠/夜间休息，也允许失眠、夜醒、低落等夜间状态；工作场景需有证据。";
  }
  if (hour >= 6 && hour < 9) {
    return "优先早晨生活行为：起床、洗漱、早餐、通勤准备。";
  }
  if (hour >= 11 && hour < 14) {
    return "优先中午生活行为：午餐、短休、简短工作收尾。";
  }
  if (hour >= 18 && hour < 21) {
    return "优先晚间生活行为：晚餐、散步、放松、整理当天事务。";
  }
  return "优先具体行为，也允许补充人物心情与状态。";
}

function hasConcreteBehavior(summary = "") {
  const text = String(summary || "");
  return /(睡|入睡|醒来|起床|午休|休息|吃|进食|早餐|午餐|晚餐|做饭|泡面|工作|开会|值班|接诊|问诊|写|阅读|学习|通勤|散步|跑步|洗澡|打扫|购物)/.test(
    text
  );
}

function isAbstractSummary(summary = "") {
  const text = String(summary || "");
  return /(提供支持|整理方案|情绪支持|反思|思考|探讨|交流|关注状态|推进关系)/.test(text);
}

function hasEmotionOrState(summary = "") {
  const text = String(summary || "");
  return /(心情|情绪|焦虑|紧张|平静|低落|烦躁|放松|疲惫|失眠|夜醒|困倦|担忧|开心|难过)/.test(
    text
  );
}

function shouldPreferSleep(now, lastInteractionAt = 0) {
  const hour = new Date(now).getHours();
  const idleMs = lastInteractionAt > 0 ? now - lastInteractionAt : Number.POSITIVE_INFINITY;
  return hour >= 1 && hour < 6 && idleMs > 90 * 60 * 1000;
}

function hasNightWorkEvidence(summary = "") {
  const text = String(summary || "");
  return /(夜班|值班|急诊|加班|赶稿|通宵|失眠|夜读|夜间接诊)/.test(text);
}

function markAiNoUpdate(why = "") {
  const base = String(why || "").trim();
  if (!base) return "ai_no_state_update";
  if (base.startsWith("ai_no_state_update")) return base;
  return `ai_no_state_update:${base}`;
}

function normalizeDecision(decision, { now, lastInteractionAt }) {
  const summary = String(decision.summary || "").trim();
  const next = { ...decision, summary };
  if (!next.shouldPersist) {
    return {
      ...next,
      why: markAiNoUpdate(next.why),
    };
  }

  const hasConcrete = hasConcreteBehavior(summary);
  const hasState = hasEmotionOrState(summary);

  // Keep minimal signal quality: allow concrete behavior OR mood/state expression.
  if (!hasConcrete && !hasState) {
    return {
      ...next,
      shouldPersist: false,
      why: "summary_lacks_behavior_or_state_signal",
    };
  }

  // If summary is abstract but still meaningful, keep it with a softer confidence cap.
  if (isAbstractSummary(summary) && !hasConcrete) {
    next.confidence = Math.min(next.confidence, 0.6);
    next.why = "abstract_state_expression";
  }

  if (
    shouldPreferSleep(now, lastInteractionAt) &&
    next.memoryType === "work_event" &&
    !hasNightWorkEvidence(summary)
  ) {
    return {
      ...next,
      // Night work without evidence is still allowed, but downgraded and converted to life-state.
      memoryType: "life_event",
      confidence: Math.min(next.confidence, 0.55),
      why: "nighttime_state_preferred_over_work",
    };
  }

  return next;
}

function parseStrictJsonObject(text = "") {
  const normalized = String(text || "").trim();
  if (normalized.startsWith("{") && normalized.endsWith("}")) {
    const parsed = JSON.parse(normalized);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("life memory ai output is not json object");
    }
    return parsed;
  }
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("life memory ai output is not strict json object");
  }
  const parsed = JSON.parse(normalized.slice(start, end + 1));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("life memory ai output is not json object");
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
    .slice(0, 6)
    .map((item) => `- ${item.role}: ${clipText(item.content, 120)}`)
    .join("\n");
  const interactionLines = recentInteractions
    .slice(0, 6)
    .map((item) => `- [${item.session_id}] ${item.role}: ${clipText(item.content, 120)}`)
    .join("\n");
  const memoryLines = recentMemories
    .slice(0, 12)
    .map((item) => `- ${item.memory_type}: ${clipText(item.content, 140)}`)
    .join("\n");
  const lastInteractionAt = recentInteractions?.[0]?.created_at || 0;
  const routineHint = buildRoutineHint(now, lastInteractionAt);
  const specialEventHint = shouldSuggestSpecialEvent({ assistantId, now })
    ? "本次可小概率采用“特殊小事”表达：例如上班中发生的事情、路上看到的小事件、临时插曲。"
    : "本次以日常routine为主，特殊事件仅在有上下文时使用。";
  const timeStyleHint = shouldUseExactTimePhrase({ assistantId, now })
    ? `时间表达建议使用具体时刻（如 ${formatClockTime(now)}）。`
    : `时间表达建议使用时间段（如 ${timeBucket}）。`;
  return [
    "你是角色自驱生活模拟器。你需要基于角色背景、最近对话和时间段，判断角色当前可能在做的生活/工作事项。",
    "只输出一个JSON对象，不要任何额外文本。",
    '格式: {"memoryType":"life_event|work_event","summary":"...","confidence":0-1,"why":"snake_case_reason","shouldPersist":true|false}',
    "要求:",
    "1) summary 12-80字，优先具体行为（如睡觉/吃饭/通勤/工作动作），也允许人物心情/状态（如失眠、焦虑、平静）。",
    "2) 如果缺少上下文，不要编造, 或者与最近一条life/work记忆相比没有明显新变化（只是同一状态重复描述），shouldPersist=false。",
    "3) confidence反映可信度，0-1。",
    "4) 凌晨时段优先休息/睡眠或失眠状态；若写工作场景，需要上下文证据（夜班/急事/持续工作）。",
    "5) 允许出现少量非routine的小事件（偶遇、路上见闻、临时变化），但不能喧宾夺主。",
    "6) 时间表达可用timeBucket或具体时间（HH:mm），两者都可接受。",
    "7) shouldPersist=false 时，summary 用简短原因描述即可（例如“状态延续，无新增事件”）。",
    `作息提示: ${routineHint}`,
    `特殊事件提示: ${specialEventHint}`,
    `时间表达提示: ${timeStyleHint}`,
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
  const res = await fetch(endpoint, {
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
  });
  if (!res.ok) {
    throw new Error(`life memory ai failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  const content = body?.choices?.[0]?.message?.content || "";
  const raw = parseStrictJsonObject(content);
  return lifeMemorySchema.parse(normalizeLifeMemoryDecision(raw));
}

async function generateLifeMemory({
  assistantId,
  sessionId,
  state,
  assistantProfile = {},
  now = Date.now(),
  dryRun = false,
}) {
  const recentTurns = getRecentConversationTurns({ assistantId, sessionId, limit: 8 });
  const recentInteractions = getRecentAssistantInteractions({ assistantId, limit: 10 });
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
  const lastInteractionAt = recentInteractions?.[0]?.created_at || 0;

  let decision = {
    memoryType: "life_event",
    summary: "",
    confidence: 0,
    why: "fallback_non_json",
    shouldPersist: false,
  };

  try {
    decision = normalizeDecision(await runAiDecision(prompt), {
      now,
      lastInteractionAt,
    });
  } catch (error) {
    return {
      ok: false,
      persisted: false,
      decision,
      context: { recentTurns, recentInteractions, recentMemories },
      error: error.message,
    };
  }

  if (!decision.shouldPersist) {
    return {
      ok: true,
      persisted: false,
      decision,
      context: { recentTurns, recentInteractions, recentMemories },
    };
  }

  if (dryRun) {
    return {
      ok: true,
      persisted: false,
      dryRun: true,
      decision,
      context: { recentTurns, recentInteractions, recentMemories },
    };
  }

  const summary = decision.summary.trim();
  const sourceTurnId = `auto-life:${uuidv7()}`;
  const memoryId = insertMemoryItem({
    assistantId,
    sessionId,
    sourceTurnId,
    content: summary,
    memoryType: decision.memoryType,
    salience: Math.max(0.3, Math.min(1, decision.confidence)),
    confidence: decision.confidence,
  });
  insertOutboxEvent({
    eventType: "memory_item.created",
    aggregateType: "memory_item",
    aggregateId: memoryId,
    dedupeKey: `memory-index:${memoryId}`,
    payload: { memoryId },
  });
  return {
    ok: true,
    persisted: true,
    memoryId,
    decision,
    context: { recentTurns, recentInteractions, recentMemories },
  };
}

module.exports = { generateLifeMemory };
