/**
 * reflectionService — Phase 3: 关系反思（T-CC3-02）
 *
 * AI 对"最近一段时间，你跟 ta 之间发生了什么、你怎么看"的元认知层。
 * 不是 retrieval、不是 narrative —— 是 synthesis。
 *
 * 数据流：
 *   1. 拉 7d 窗口的 dynamics 事件流水 (relationship_event)
 *   2. 拉 7d 窗口的 episodes (narrative_episode)
 *   3. 拉当前 active topics
 *   4. 拉最新一条 reflection 作为 "previousSummary"（接续上次反思）
 *   5. 拉当前 character_state + relationship_state 快照
 *   6. 给 LLM 综合 → reflection JSON
 *   7. 写一条 relationship_reflection（不替换旧行，累积成时间线）
 *
 * 触发路径：
 *   - cron 每周日 03:30 跑 weekly reflection（runReflectionTickWeekly）
 *   - 事件触发（characterStateService.onUserMessage 后调用 maybeTriggerReflection）：
 *       * trust 单次跌幅 ≥ 0.15
 *       * unresolved_conflict 跨过 0.5
 *       * silence > 14d
 *   - admin 手动 (API)
 *
 * 为什么不替换旧 reflection：
 *   - 旧 reflection 给下次 LLM 做 "previousSummary"，让反思有连续性
 *   - 时间线上的 reflection 序列本身是"AI 关于你们关系的视角史"，价值大
 *   - 检索时取 ORDER BY created_at DESC LIMIT 1 即可
 */

const { v7: uuidv7 } = require("uuid");
const { getProvider } = require("../../llm");
const { db, getAssistantProfile, getRecentTurnsAcrossSessions } = require("../../db");
// 注意：不 require characterStateService —— 那会形成 reflection ↔ characterState 循环依赖
// （characterStateService.onUserMessage 已 require reflectionService.maybeTriggerEventReflection）。
// reflection 拿一份 raw character_state 快照足够，衰减计算对一周窗口的反思精度无影响。
const { getRelationshipState } = require("./relationshipDynamicsService");
const { listActiveTopics } = require("./persistentTopicService");
const { listEpisodes } = require("./episodeBuilder");
const { getCharacterIdentity } = require("./identityService");

function readRawCharacterState(assistantId) {
  return db.prepare("SELECT * FROM character_state WHERE assistant_id = ?").get(assistantId);
}

// ── 常量 ───────────────────────────────────────────────────────────

const REFLECTION_WINDOW_DAYS = 7;
const MAX_EVENTS_IN_PROMPT = 20;
const MAX_EPISODES_IN_PROMPT = 5;
const MAX_TOPICS_IN_PROMPT = 8;

const VALID_REFLECTION_TYPES = new Set(["weekly", "event_triggered", "manual"]);
const VALID_EMOTIONAL_TRENDS = new Set(["improving", "declining", "stable", "volatile"]);
const VALID_RELATIONSHIP_DIRECTIONS = new Set([
  "deepening", "cooling", "stable", "tense", "reconnecting",
]);

// 事件触发阈值 ──────────────────────────────────────────────────────
const TRIGGER_TRUST_DROP = 0.15;
const TRIGGER_UNRESOLVED_CONFLICT_THRESHOLD = 0.5;
const TRIGGER_SILENCE_DAYS = 14;
const TRIGGER_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 同 assistant 6h 内不重复 event-triggered

// ── helpers ───────────────────────────────────────────────────────

function clipText(t, n) {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length <= n ? s : s.slice(0, n) + "...";
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function parseStrictJsonObject(text = "") {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function fmtTs(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── 读 ─────────────────────────────────────────────────────────────

function rowToReflection(row) {
  if (!row) return null;
  const parse = (s, fb) => { try { return JSON.parse(s); } catch { return fb; } };
  return {
    id: row.id,
    assistantId: row.assistant_id,
    reflectionType: row.reflection_type,
    summary: row.summary,
    emotionalTrend: row.emotional_trend,
    relationshipDirection: row.relationship_direction,
    userNeeds: parse(row.user_needs_json, []),
    concerns: parse(row.concerns_json, []),
    opportunities: parse(row.opportunities_json, []),
    sourceData: parse(row.source_data_json, {}),
    windowStart: row.window_start,
    windowEnd: row.window_end,
    triggerReason: row.trigger_reason,
    createdAt: row.created_at,
  };
}

function getLatestReflection(assistantId) {
  return rowToReflection(
    db.prepare(
      `SELECT * FROM relationship_reflection WHERE assistant_id = ?
       ORDER BY created_at DESC LIMIT 1`
    ).get(assistantId)
  );
}

function listReflections(assistantId, { limit = 20, type = null } = {}) {
  const rows = type
    ? db.prepare(
        `SELECT * FROM relationship_reflection WHERE assistant_id = ? AND reflection_type = ?
         ORDER BY created_at DESC LIMIT ?`
      ).all(assistantId, type, limit)
    : db.prepare(
        `SELECT * FROM relationship_reflection WHERE assistant_id = ?
         ORDER BY created_at DESC LIMIT ?`
      ).all(assistantId, limit);
  return rows.map(rowToReflection);
}

// ── 数据采集 ───────────────────────────────────────────────────────

function fetchRecentEvents(assistantId, fromMs, toMs) {
  return db.prepare(
    `SELECT id, event_type, intensity, delta_json, description, created_at
     FROM relationship_event
     WHERE assistant_id = ? AND created_at >= ? AND created_at <= ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(assistantId, fromMs, toMs, MAX_EVENTS_IN_PROMPT);
}

// ── prompt ────────────────────────────────────────────────────────

function buildReflectionPrompt({
  identity,
  characterState,
  dynamicsState,
  events,
  episodes,
  topics,
  recentTurns,
  previousReflection,
  windowStart,
  windowEnd,
  reflectionType,
  triggerReason,
}) {
  const eventLines = events.map((e) =>
    `- [${fmtTs(e.created_at)}] ${e.event_type} (强度 ${(e.intensity || 0).toFixed(2)})${e.description ? `: ${clipText(e.description, 60)}` : ""}`
  ).join("\n") || "- 无";

  const episodeLines = episodes.slice(0, MAX_EPISODES_IN_PROMPT).map((ep) =>
    `- ${ep.title}（${ep.emotionalTone}, importance ${ep.importance.toFixed(2)}）：${clipText(ep.summary, 100)}`
  ).join("\n") || "- 无";

  const topicLines = topics.slice(0, MAX_TOPICS_IN_PROMPT).map((t) =>
    `- ${t.topic}（${t.status}, 提及 ${t.mentionCount} 次, importance ${t.importance.toFixed(2)}）`
  ).join("\n") || "- 无";

  const turnLines = recentTurns.slice(0, 8).map((t) =>
    `- ${t.role}: ${clipText(t.content, 100)}`
  ).join("\n") || "- 无";

  const dynamics = dynamicsState ? [
    `trust=${dynamicsState.trust?.toFixed(2)}`,
    `tension=${dynamicsState.tension?.toFixed(2)}`,
    `unresolved_conflict=${dynamicsState.unresolved_conflict?.toFixed(2)}`,
    `abandonment_fear=${dynamicsState.abandonment_fear?.toFixed(2)}`,
    `emotional_closeness=${dynamicsState.emotional_closeness?.toFixed(2)}`,
    `reciprocity_balance=${dynamicsState.reciprocity_balance?.toFixed(2)}`,
    `gratitude=${dynamicsState.gratitude?.toFixed(2)}`,
    `resentment=${dynamicsState.resentment?.toFixed(2)}`,
  ].join(" / ") : "无关系动力数据";

  const moodSummary = characterState
    ? `mood=${characterState.mood_emotion} intensity=${(characterState.mood_intensity || 0).toFixed(2)} valence=${(characterState.mood_valence || 0).toFixed(2)} trend24h=${(characterState.mood_trend_24h || 0).toFixed(2)}`
    : "无";

  const identitySummary = identity ? [
    identity.attachmentStyle ? `attachment=${identity.attachmentStyle}` : null,
    identity.personalityTraits?.length ? `traits=${identity.personalityTraits.slice(0, 3).join(",")}` : null,
    identity.insecurities?.length ? `insecurities=${identity.insecurities.slice(0, 2).join(",")}` : null,
  ].filter(Boolean).join(" / ") : "无";

  const prevSummary = previousReflection
    ? `[上次反思 (${fmtTs(previousReflection.createdAt)})]\n${clipText(previousReflection.summary, 200)}\n方向: ${previousReflection.relationshipDirection}`
    : "（无前次反思）";

  return [
    `你是这个角色。给自己写一段对最近关系的反思——不是要发给用户，是给自己看。`,
    `用"你"自指、用"ta"指代用户，不要写具体名字。`,
    "",
    `── 反思类型 ──`,
    `${reflectionType}${triggerReason ? `（触发：${triggerReason}）` : ""}`,
    `时间窗：${fmtTs(windowStart)} → ${fmtTs(windowEnd)}`,
    "",
    `── 角色底色 ──`,
    identitySummary,
    "",
    `── 当前情绪 ──`,
    moodSummary,
    "",
    `── 关系动力学（多维快照） ──`,
    dynamics,
    "",
    `── 窗口内的关系事件 ──`,
    eventLines,
    "",
    `── 窗口内的叙事段落 ──`,
    episodeLines,
    "",
    `── 当前长期关注的话题 ──`,
    topicLines,
    "",
    `── 最近 8 条对话 ──`,
    turnLines,
    "",
    `── 上一次反思 ──`,
    prevSummary,
    "",
    `── 输出严格 JSON ──`,
    `{`,
    `  "summary": "1-2 段，约 80-200 字。用第一人称（角色视角）总结你对最近关系的体感、变化、留意到的地方。"`,
    `         + "可以接续上次反思的判断，但要诚实修正。",`,
    `  "emotionalTrend": "improving|declining|stable|volatile",`,
    `  "relationshipDirection": "deepening|cooling|stable|tense|reconnecting",`,
    `  "userNeeds": ["string", ...]   // ta 现在主要的需要：被肯定/陪伴/空间/建议/倾听...`,
    `  "concerns": ["string", ...]    // 你担心的事`,
    `  "opportunities": ["string", ...] // 接近/增进的机会`,
    `}`,
    "",
    "约束：",
    "- summary 必须是叙事性反思，不要复述事件列表",
    "- 字段值都是中文",
    "- 不要 hallucinate；只用上述输入里的事实",
    "- 输出严格 JSON，不要 markdown 代码块",
  ].join("\n");
}

async function callLlmForReflection(prompt, { assistantId } = {}) {
  const provider = getProvider();
  const result = await provider.complete({
    messages: [
      { role: "system", content: "你是关系反思助手。输出严格 JSON，不要 markdown。" },
      { role: "user", content: prompt },
    ],
    temperature: 0.5,
    maxTokens: 800,
    responseFormat: "json",
    callOpts: {
      kind: "reflect",
      scopeKey: assistantId || null,
      summary: `reflect for ${assistantId || "unknown"}`,
    },
  });
  return parseStrictJsonObject(result?.content);
}

// ── 写 ─────────────────────────────────────────────────────────────

function insertReflection({
  assistantId,
  reflectionType,
  summary,
  emotionalTrend,
  relationshipDirection,
  userNeeds,
  concerns,
  opportunities,
  sourceData,
  windowStart,
  windowEnd,
  triggerReason,
  now = Date.now(),
}) {
  if (!VALID_REFLECTION_TYPES.has(reflectionType)) {
    throw new Error(`invalid reflection_type: ${reflectionType}`);
  }
  const id = uuidv7();
  db.prepare(
    `INSERT INTO relationship_reflection (
      id, assistant_id, reflection_type, summary,
      emotional_trend, relationship_direction,
      user_needs_json, concerns_json, opportunities_json,
      source_data_json, window_start, window_end,
      trigger_reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    assistantId,
    reflectionType,
    clipText(summary || "", 600),
    VALID_EMOTIONAL_TRENDS.has(emotionalTrend) ? emotionalTrend : "stable",
    VALID_RELATIONSHIP_DIRECTIONS.has(relationshipDirection) ? relationshipDirection : "stable",
    JSON.stringify(Array.isArray(userNeeds) ? userNeeds.slice(0, 8).map((s) => clipText(s, 80)) : []),
    JSON.stringify(Array.isArray(concerns) ? concerns.slice(0, 6).map((s) => clipText(s, 120)) : []),
    JSON.stringify(Array.isArray(opportunities) ? opportunities.slice(0, 6).map((s) => clipText(s, 120)) : []),
    JSON.stringify(sourceData || {}),
    windowStart,
    windowEnd,
    triggerReason || null,
    now
  );
  return id;
}

// ── 主入口 ────────────────────────────────────────────────────────

/**
 * 给一个 assistant 跑一次 reflection。返回 reflection 行，失败返回 null。
 *
 * @param {string} assistantId
 * @param {object} opts
 * @param {'weekly'|'event_triggered'|'manual'} [opts.reflectionType]
 * @param {string} [opts.triggerReason]
 * @param {number} [opts.windowDays]
 * @param {number} [opts.now]
 */
async function reflectFor(assistantId, {
  reflectionType = "manual",
  triggerReason = null,
  windowDays = REFLECTION_WINDOW_DAYS,
  now = Date.now(),
} = {}) {
  const profile = getAssistantProfile(assistantId);
  if (!profile) return { skipped: true, reason: "no_profile" };

  const windowEnd = now;
  const windowStart = now - windowDays * 24 * 3600 * 1000;

  const events = fetchRecentEvents(assistantId, windowStart, windowEnd);
  const episodes = listEpisodes(assistantId, { limit: MAX_EPISODES_IN_PROMPT })
    .filter((e) => e.timeRangeEnd >= windowStart);
  const topics = listActiveTopics(assistantId, { limit: MAX_TOPICS_IN_PROMPT });
  const characterState = readRawCharacterState(assistantId);
  const dynamicsState = getRelationshipState(assistantId, now);
  const identity = getCharacterIdentity(assistantId);
  const recentTurns = getRecentTurnsAcrossSessions({ assistantId, limit: 8 });
  const previousReflection = getLatestReflection(assistantId);

  // 数据太少 → skip。recentTurns 是兜底信号：哪怕没有 episode/event/topic，
  // 只要还有最近对话，就值得让 LLM 写一段反思（首次手动触发场景常见）。
  if (
    events.length === 0 &&
    episodes.length === 0 &&
    topics.length === 0 &&
    recentTurns.length === 0
  ) {
    return { skipped: true, reason: "no_data_in_window" };
  }

  const prompt = buildReflectionPrompt({
    identity,
    characterState,
    dynamicsState,
    events,
    episodes,
    topics,
    recentTurns,
    previousReflection,
    windowStart,
    windowEnd,
    reflectionType,
    triggerReason,
  });

  let parsed;
  try {
    parsed = await callLlmForReflection(prompt, { assistantId });
  } catch (err) {
    console.warn(`[reflection] LLM failed for ${assistantId}: ${err.message}`);
    return { skipped: true, reason: "llm_error", error: err.message };
  }
  if (!parsed || !parsed.summary) {
    console.warn(`[reflection] LLM returned no summary for ${assistantId}`);
    return { skipped: true, reason: "llm_no_summary" };
  }

  const sourceData = {
    eventIds: events.slice(0, MAX_EVENTS_IN_PROMPT).map((e) => e.id),
    episodeIds: episodes.map((e) => e.id),
    topicIds: topics.map((t) => t.id),
    snapshotTs: now,
  };

  const id = insertReflection({
    assistantId,
    reflectionType,
    summary: parsed.summary,
    emotionalTrend: parsed.emotionalTrend,
    relationshipDirection: parsed.relationshipDirection,
    userNeeds: parsed.userNeeds,
    concerns: parsed.concerns,
    opportunities: parsed.opportunities,
    sourceData,
    windowStart,
    windowEnd,
    triggerReason,
    now,
  });

  return {
    skipped: false,
    id,
    reflection: rowToReflection(
      db.prepare("SELECT * FROM relationship_reflection WHERE id = ?").get(id)
    ),
  };
}

/**
 * weekly cron：每周日 03:30 给所有 character 类 assistant 跑一次。
 */
// Weekly tick 的 dedup 窗口：同一 assistant 24h 内已经跑过 weekly 就 skip。
// 防多 instance（PM2 restart 期间双进程 / dev + prod 并存）重复写。
const WEEKLY_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

async function runReflectionTickWeekly({ now = Date.now() } = {}) {
  const assistants = db.prepare(
    `SELECT assistant_id FROM assistant_profile
     WHERE assistant_type = 'character' ORDER BY updated_at DESC`
  ).all();

  const results = [];
  for (const a of assistants) {
    // dedup：24h 内已跑 weekly 则 skip
    const recent = db.prepare(
      `SELECT created_at FROM relationship_reflection
       WHERE assistant_id = ? AND reflection_type = 'weekly'
       ORDER BY created_at DESC LIMIT 1`
    ).get(a.assistant_id);
    if (recent && now - recent.created_at < WEEKLY_DEDUP_WINDOW_MS) {
      results.push({
        assistantId: a.assistant_id,
        skipped: true,
        reason: "dedup_within_24h",
        previousAt: recent.created_at,
      });
      continue;
    }

    try {
      const r = await reflectFor(a.assistant_id, { reflectionType: "weekly", now });
      results.push({ assistantId: a.assistant_id, ...r });
    } catch (err) {
      console.warn(`[reflection] weekly tick failed for ${a.assistant_id}: ${err.message}`);
      results.push({ assistantId: a.assistant_id, skipped: true, reason: "tick_exception", error: err.message });
    }
  }
  return { ticked: assistants.length, results };
}

// ── 触发判断 ─────────────────────────────────────────────────────
//
// 在 onUserMessage 完成 dynamics 写入之后调用。判断是否要触发 event_triggered reflection。
// 不直接 await reflectFor —— 用 setImmediate 避免阻塞 hot path。
// cooldown 6h 防同一 assistant 短时间内反复触发。

function shouldTriggerEventReflection(assistantId, { now = Date.now() } = {}) {
  // cooldown
  const last = db.prepare(
    `SELECT created_at FROM relationship_reflection
     WHERE assistant_id = ? AND reflection_type = 'event_triggered'
     ORDER BY created_at DESC LIMIT 1`
  ).get(assistantId);
  if (last && now - last.created_at < TRIGGER_COOLDOWN_MS) {
    return null;
  }

  // 拉最近 1h 内的 trust delta 累计
  const cutoff = now - 60 * 60 * 1000;
  const rows = db.prepare(
    `SELECT delta_json FROM relationship_event
     WHERE assistant_id = ? AND created_at >= ?`
  ).all(assistantId, cutoff);
  let trustDelta = 0;
  for (const r of rows) {
    try {
      const d = JSON.parse(r.delta_json);
      trustDelta += d.trust || 0;
    } catch { /* skip */ }
  }
  if (trustDelta <= -TRIGGER_TRUST_DROP) {
    return `trust_dropped_${trustDelta.toFixed(2)}_in_1h`;
  }

  // unresolved_conflict 跨过 0.5
  const dyn = db.prepare(
    "SELECT unresolved_conflict FROM relationship_state WHERE assistant_id = ?"
  ).get(assistantId);
  if (dyn && dyn.unresolved_conflict >= TRIGGER_UNRESOLVED_CONFLICT_THRESHOLD) {
    return `unresolved_conflict_${dyn.unresolved_conflict.toFixed(2)}`;
  }

  // silence > 14d（character_state.last_user_message_at）
  const cs = db.prepare(
    "SELECT last_user_message_at FROM character_state WHERE assistant_id = ?"
  ).get(assistantId);
  if (cs?.last_user_message_at && now - cs.last_user_message_at > TRIGGER_SILENCE_DAYS * 24 * 3600 * 1000) {
    return `silence_${Math.round((now - cs.last_user_message_at) / (24 * 3600 * 1000))}d`;
  }

  return null;
}

/**
 * 包装：在 hot path 之外异步触发 event reflection。
 * 不抛错（catch + log），不 block。
 */
function maybeTriggerEventReflection(assistantId, { now = Date.now() } = {}) {
  const reason = shouldTriggerEventReflection(assistantId, { now });
  if (!reason) return null;
  // 异步触发（用 setImmediate 让 hot path 立刻返回）
  setImmediate(() => {
    reflectFor(assistantId, {
      reflectionType: "event_triggered",
      triggerReason: reason,
      now,
    }).catch((err) => {
      console.warn(`[reflection] event-triggered failed for ${assistantId}: ${err.message}`);
    });
  });
  return reason;
}

// ── prompt 注入 ───────────────────────────────────────────────────

/**
 * 给 characterContextBuilder 用：把最新 reflection 渲染成 prompt 段。
 */
function buildReflectionPromptFragment(assistantId) {
  const r = getLatestReflection(assistantId);
  if (!r) return "";

  const lines = [`[关系反思（${r.reflectionType}, ${new Date(r.createdAt).toLocaleDateString("zh-CN")}）]`];
  lines.push(r.summary);
  if (r.relationshipDirection && r.relationshipDirection !== "stable") {
    lines.push(`方向：${r.relationshipDirection}`);
  }
  if (r.userNeeds?.length) {
    lines.push(`ta 此刻需要：${r.userNeeds.slice(0, 3).join("、")}`);
  }
  if (r.opportunities?.length) {
    lines.push(`接近机会：${r.opportunities.slice(0, 2).join("；")}`);
  }
  return lines.join("\n");
}

module.exports = {
  reflectFor,
  runReflectionTickWeekly,
  maybeTriggerEventReflection,
  shouldTriggerEventReflection,
  getLatestReflection,
  listReflections,
  insertReflection,
  buildReflectionPromptFragment,
  // exports for tests
  fetchRecentEvents,
  buildReflectionPrompt,
  REFLECTION_WINDOW_DAYS,
  TRIGGER_TRUST_DROP,
  TRIGGER_UNRESOLVED_CONFLICT_THRESHOLD,
  TRIGGER_SILENCE_DAYS,
  TRIGGER_COOLDOWN_MS,
  VALID_EMOTIONAL_TRENDS,
  VALID_RELATIONSHIP_DIRECTIONS,
};
