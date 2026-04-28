const { v7: uuidv7 } = require("uuid");
const config = require("../config");
const { fetchWithTimeout } = require("../utils/fetchWithTimeout");
const {
  db,
  getAssistantProfile,
  listProactiveAssistantProfiles,
  getRecentTurnsAcrossSessions,
  getRecentMemoryItems,
  getConfidentFactsForAssistant,
  getLastAssistantInteractionAt,
  insertBehaviorJournalEntry,
  listLocalSubscriberIds,
} = require("../db");
const { retrieveMemory } = require("./memoryRetrievalService");
const {
  containsBlacklistedPhrase,
  maxJaccardAgainst,
} = require("./textDedupService");
const { parseQuietHours, isInQuietHours } = require("./characterEngine");

function clipText(input = "", maxLen = 240) {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function pickFallbackUserId() {
  const subs = listLocalSubscriberIds();
  if (subs.length) return subs[0].user_id;
  return "default-user";
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

async function callLlmForPlanDraft(prompt, { temperature = 0.75, maxTokens = 600 } = {}) {
  const endpoint = `${config.qwenBaseUrl.replace(/\/$/, "")}/chat/completions`;
  const res = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.qwenApiKey}`,
    },
    body: JSON.stringify({
      model: config.qwenModel,
      temperature,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  }, 30000);
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`plan llm http ${res.status}: ${txt.slice(0, 200)}`);
  }
  const body = await res.json();
  const content = body?.choices?.[0]?.message?.content || "";
  return parseStrictJsonObject(content);
}

function buildPlanPrompt({
  characterName,
  characterBackground,
  triggerReason,
  triggerExplanation,
  triggerContext,
  recentTurns,
  userFacts,
  relevantMemories,
  recentDrafts,
}) {
  const turnLines = recentTurns
    .slice(0, 6)
    .map((t) => `- ${t.role}: ${clipText(t.content, 140)}`)
    .join("\n");
  const factLines = userFacts
    .slice(0, 12)
    .map((f) => `- ${f.fact_key}=${clipText(f.fact_value, 80)}`)
    .join("\n");
  const memLines = relevantMemories
    .slice(0, 5)
    .map((m) => `- ${m.memory_type || m.memoryType || "memory"}: ${clipText(m.content, 140)}`)
    .join("\n");
  const draftLines = recentDrafts
    .slice(0, 10)
    .map(
      (d) =>
        `- [${d.trigger_reason || "unknown"}/${d.status || "?"}] ${clipText(
          d.draft_body || "",
          120
        )}`
    )
    .join("\n");

  return [
    `你是 AI 角色「${characterName}」，要给用户主动发一条消息。这条消息是开场——发完之后用户会回，会展开成一段对话。`,
    "",
    "【触发原因】",
    `原因码：${triggerReason}`,
    `原因描述：${triggerExplanation}`,
    `原因背景：${triggerContext}`,
    "",
    "【角色档案】",
    clipText(characterBackground || "无", 800),
    "",
    "【最近 6 条对话】",
    turnLines || "- 无",
    "",
    "【已知用户事实，请认真利用】",
    factLines || "- 无",
    "",
    "【相关记忆，可以从中找引子】",
    memLines || "- 无",
    "",
    "【你之前发过的主动消息草稿（不论已发未发），本次必须用完全不同的开场角度】",
    draftLines || "- 无",
    "",
    "【硬性要求】",
    "1. 一到两句话，总长 ≤ 50 字",
    "2. **必须有具体引子**：从 userFacts、recentMemories 或 recentTurns 里抓**一个具体的人/事/物**作为切入点",
    "3. **绝对禁止**这些通用开场（出现立即作废）：",
    "   - \"最近怎么样\" \"在干嘛\" \"想你了\" \"好久没聊\" \"近况如何\" \"你还好吗\" \"睡了吗\"",
    "   - \"今天过得怎么样\" \"有没有空\" \"在忙什么\"",
    "4. 语气和角色性格一致",
    "5. 主动消息的目的不是问候，是**让用户感到\"被记住\"**——开口要让用户立刻知道你记得他说过的某件具体事",
    "",
    "严格输出 JSON：",
    "{",
    '  "intent": "ask_followup" | "check_in" | "share_thought" | "remind",',
    '  "title": "<≤ 20 字的通知标题>",',
    '  "body": "<开场消息正文，≤ 50 字>",',
    '  "anchorTopic": "<被引用的具体话题/事物，3-12 字，不能为空>",',
    '  "rationale": "<为什么这一条比泛泛问候更值得发，一句话>"',
    "}",
  ].join("\n");
}

const VALID_INTENTS = new Set(["ask_followup", "check_in", "share_thought", "remind"]);

function normalizePlanDraft(raw = {}) {
  const intentRaw = String(raw.intent || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const intent = VALID_INTENTS.has(intentRaw) ? intentRaw : "check_in";
  const title = clipText(raw.title || "", 40);
  const body = clipText(raw.body || "", 200);
  const anchorTopic = clipText(raw.anchorTopic || "", 60);
  const rationale = clipText(raw.rationale || "", 200);
  return { intent, title, body, anchorTopic, rationale };
}

// ---- Triggers ----

const QUIET_HOURS = parseQuietHours(config.autonomousQuietHours);

function startOfDayMs(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
}

function nextQuietEndHourMs(now) {
  // Push to next non-quiet integer hour.
  for (let i = 0; i < 24; i += 1) {
    const candidate = new Date(now + i * 60 * 60 * 1000);
    candidate.setMinutes(0, 0, 0);
    if (!isInQuietHours(candidate, QUIET_HOURS)) return candidate.getTime();
  }
  return now;
}

function evaluateInactive7d({ assistantId, now }) {
  const lastAt = getLastAssistantInteractionAt(assistantId);
  if (!lastAt) return null;
  if (lastAt >= now - 7 * 24 * 60 * 60 * 1000) return null;
  const daysSince = Math.floor((now - lastAt) / (24 * 60 * 60 * 1000));
  let scheduledAt = now + 2 * 60 * 60 * 1000; // 2h after now
  if (isInQuietHours(new Date(scheduledAt), QUIET_HOURS)) {
    scheduledAt = nextQuietEndHourMs(scheduledAt);
  }
  return {
    triggerReason: "inactive_7d",
    triggerExplanation: `用户已经 ${daysSince} 天没找你聊过了`,
    triggerContext: `上次互动时间戳 ${lastAt}，距今约 ${daysSince} 天`,
    scheduledAt,
  };
}

function evaluateDailyGreeting({ assistantId, now, profile }) {
  const lastProactiveAt = profile?.last_proactive_check_at || 0;
  if (lastProactiveAt > now - 24 * 60 * 60 * 1000) return null;
  const startOfDay = startOfDayMs(now);
  const elapsed = now - startOfDay;
  let scheduledAt;
  if (elapsed < 9 * 60 * 60 * 1000) {
    scheduledAt = startOfDay + 9 * 60 * 60 * 1000; // today 09:00
  } else {
    return null;
  }
  if (isInQuietHours(new Date(scheduledAt), QUIET_HOURS)) {
    scheduledAt = nextQuietEndHourMs(scheduledAt);
  }
  return {
    triggerReason: "daily_greeting",
    triggerExplanation: "想问候用户",
    triggerContext: "节奏型问候，今天还没主动联系过用户",
    scheduledAt,
  };
}

// TODO Phase B+: implement followup_promise (extract follow-up hooks from recent turns).
// TODO Phase B+: implement birthday_or_anniversary (scan memory_facts for date-keyed facts).

function evaluateAllTriggers({ assistantId, now, profile }) {
  const out = [];
  const inactive = evaluateInactive7d({ assistantId, now });
  if (inactive) out.push(inactive);
  const greeting = evaluateDailyGreeting({ assistantId, now, profile });
  if (greeting) out.push(greeting);
  return out;
}

// ---- DB helpers ----

function findRecentPendingByTriggerWithin({ assistantId, triggerReason, now, withinMs }) {
  return db
    .prepare(
      `SELECT id, status, scheduled_at, created_at
       FROM proactive_plans
       WHERE assistant_id = ?
         AND trigger_reason = ?
         AND status = 'pending'
         AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(assistantId, triggerReason, now - withinMs);
}

function findUsedAnchorTopicWithin({ assistantId, anchorTopic, withinMs, now }) {
  if (!anchorTopic) return null;
  return db
    .prepare(
      `SELECT id, status, scheduled_at, anchor_topic
       FROM proactive_plans
       WHERE assistant_id = ?
         AND anchor_topic = ?
         AND created_at >= ?
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(assistantId, anchorTopic, now - withinMs);
}

function getRecentDraftsForAssistant(assistantId, limit = 10) {
  return db
    .prepare(
      `SELECT id, trigger_reason, draft_body, anchor_topic, status, created_at
       FROM proactive_plans
       WHERE assistant_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    )
    .all(assistantId, limit);
}

function insertProactivePlan({
  assistantId,
  userId,
  triggerReason,
  intent,
  draftTitle,
  draftBody,
  anchorTopic,
  rationale,
  scheduledAt,
  now = Date.now(),
}) {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO proactive_plans
      (id, assistant_id, user_id, trigger_reason, intent, draft_title, draft_body, anchor_topic, rationale, scheduled_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(
    id,
    assistantId,
    userId,
    triggerReason,
    intent,
    draftTitle,
    draftBody,
    anchorTopic || null,
    rationale || null,
    scheduledAt,
    now,
    now
  );
  return id;
}

function cancelPendingPlansForAssistant(assistantId, reason = "user_active") {
  if (!assistantId) return 0;
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE proactive_plans
       SET status = 'cancelled', cancelled_reason = ?, updated_at = ?
       WHERE assistant_id = ? AND status = 'pending'`
    )
    .run(reason, now, assistantId);
  return result.changes || 0;
}

function listPendingPlans({ assistantId } = {}) {
  if (assistantId) {
    return db
      .prepare(
        `SELECT * FROM proactive_plans
         WHERE assistant_id = ? AND status = 'pending'
         ORDER BY scheduled_at ASC`
      )
      .all(assistantId);
  }
  return db
    .prepare(
      `SELECT * FROM proactive_plans
       WHERE status = 'pending'
       ORDER BY scheduled_at ASC`
    )
    .all();
}

function listPlansByStatus({ assistantId, status }) {
  const rows = db
    .prepare(
      `SELECT * FROM proactive_plans
       WHERE ${assistantId ? "assistant_id = ? AND " : ""}status = ?
       ORDER BY scheduled_at ASC`
    )
    .all(...(assistantId ? [assistantId, status] : [status]));
  return rows;
}

function findPlanById(id) {
  return db.prepare("SELECT * FROM proactive_plans WHERE id = ?").get(id);
}

function markPlanSent(planId, now = Date.now()) {
  const result = db
    .prepare(
      `UPDATE proactive_plans
       SET status = 'sent', sent_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`
    )
    .run(now, now, planId);
  return result.changes || 0;
}

function cancelPlanById(planId, reason = "manual") {
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE proactive_plans
       SET status = 'cancelled', cancelled_reason = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`
    )
    .run(reason, now, planId);
  return result.changes || 0;
}

function fetchDuePendingPlans(now = Date.now()) {
  return db
    .prepare(
      `SELECT * FROM proactive_plans
       WHERE status = 'pending' AND scheduled_at <= ?
       ORDER BY scheduled_at ASC
       LIMIT 50`
    )
    .all(now);
}

// ---- Main generator ----

async function generatePlanForAssistant({ profile, now, userId }) {
  const assistantId = profile.assistant_id;
  const triggers = evaluateAllTriggers({ assistantId, now, profile });
  if (!triggers.length) {
    return { generated: 0, skipped: [{ reason: "no_trigger_hit", assistantId }] };
  }

  const recentTurns = getRecentTurnsAcrossSessions({ assistantId, limit: 8 });
  const userFacts = getConfidentFactsForAssistant({
    assistantId,
    minConfidence: 0.5,
    limit: 30,
  });
  const recentDrafts = getRecentDraftsForAssistant(assistantId, 10);

  let relevantMemories = [];
  try {
    const lastSessionId = profile.last_session_id || `persona:${assistantId}`;
    const memSeed = recentTurns.find((t) => t.role === "user")?.content || profile.character_name || "";
    if (memSeed) {
      relevantMemories = await retrieveMemory({
        assistantId,
        sessionId: lastSessionId,
        query: memSeed,
        topK: 5,
      });
    }
  } catch (e) {
    relevantMemories = [];
  }

  const generatedIds = [];
  const skippedDetails = [];

  for (const trigger of triggers) {
    // De-dup: same assistant + same trigger_reason within 24h, pending
    const dup = findRecentPendingByTriggerWithin({
      assistantId,
      triggerReason: trigger.triggerReason,
      now,
      withinMs: 24 * 60 * 60 * 1000,
    });
    if (dup) {
      skippedDetails.push({
        triggerReason: trigger.triggerReason,
        skipped: "duplicate_within_24h",
      });
      continue;
    }

    const attempts = [
      { temperature: 0.75 },
      { temperature: 0.85 },
    ];
    let chosen = null;
    let dropReasons = [];
    let lastErr = null;

    for (let attemptIdx = 0; attemptIdx < attempts.length; attemptIdx += 1) {
      const params = attempts[attemptIdx];
      const prompt = buildPlanPrompt({
        characterName: profile.character_name || assistantId,
        characterBackground: profile.character_background || "",
        triggerReason: trigger.triggerReason,
        triggerExplanation: trigger.triggerExplanation,
        triggerContext: trigger.triggerContext,
        recentTurns,
        userFacts,
        relevantMemories,
        recentDrafts,
      });
      let raw;
      try {
        raw = await callLlmForPlanDraft(prompt, { temperature: params.temperature });
      } catch (error) {
        lastErr = error;
        continue;
      }
      const draft = normalizePlanDraft(raw);
      const reasons = [];
      if (!draft.body || draft.body.length < 4) reasons.push("body_too_short");
      if (!draft.anchorTopic) reasons.push("anchor_topic_empty");
      if (containsBlacklistedPhrase(draft.body)) reasons.push("blacklisted_phrase");
      const corpus = recentDrafts.map((d) => d.draft_body || "").filter(Boolean);
      const score = maxJaccardAgainst(draft.body, corpus);
      if (score > 0.4) reasons.push(`jaccard_against_drafts:${score.toFixed(2)}`);
      const usedAnchor = findUsedAnchorTopicWithin({
        assistantId,
        anchorTopic: draft.anchorTopic,
        withinMs: 7 * 24 * 60 * 60 * 1000,
        now,
      });
      if (usedAnchor) reasons.push("anchor_topic_used_within_7d");
      if (!reasons.length) {
        chosen = draft;
        break;
      }
      dropReasons = reasons;
    }

    if (!chosen) {
      insertBehaviorJournalEntry({
        runType: "plan_generation_tick",
        assistantId,
        sessionId: profile.last_session_id || null,
        shouldPushMessage: false,
        status: "skipped",
        reason: lastErr ? "llm_unreachable" : "all_drafts_rejected",
        input: {
          triggerReason: trigger.triggerReason,
          triggerExplanation: trigger.triggerExplanation,
        },
        result: { dropReasons },
        errorMessage: lastErr ? lastErr.message : "",
        createdAt: now,
      });
      skippedDetails.push({
        triggerReason: trigger.triggerReason,
        skipped: lastErr ? "llm_unreachable" : "all_drafts_rejected",
        dropReasons,
      });
      continue;
    }

    const planId = insertProactivePlan({
      assistantId,
      userId,
      triggerReason: trigger.triggerReason,
      intent: chosen.intent,
      draftTitle: chosen.title || `${profile.character_name || assistantId} 想说`,
      draftBody: chosen.body,
      anchorTopic: chosen.anchorTopic,
      rationale: chosen.rationale,
      scheduledAt: trigger.scheduledAt,
      now,
    });
    generatedIds.push({
      planId,
      triggerReason: trigger.triggerReason,
      scheduledAt: trigger.scheduledAt,
      body: chosen.body,
      anchorTopic: chosen.anchorTopic,
    });
    insertBehaviorJournalEntry({
      runType: "plan_generation_tick",
      assistantId,
      sessionId: profile.last_session_id || null,
      shouldPushMessage: true,
      status: "ok",
      reason: "plan_generated",
      messageIntent: chosen.intent,
      draftMessage: chosen.body,
      input: {
        triggerReason: trigger.triggerReason,
        scheduledAt: trigger.scheduledAt,
      },
      result: { planId, anchorTopic: chosen.anchorTopic },
      createdAt: now,
    });
  }

  return { generated: generatedIds.length, generatedIds, skipped: skippedDetails };
}

async function generatePlans({
  assistantId = null,
  now = Date.now(),
  windowHours = 24,
} = {}) {
  let profiles;
  if (assistantId) {
    const p = getAssistantProfile(assistantId);
    profiles = p && p.allow_proactive_message === 1 ? [p] : [];
  } else {
    profiles = listProactiveAssistantProfiles();
  }

  const userId = pickFallbackUserId();

  const stats = {
    profiles: profiles.length,
    generated: 0,
    skipped: 0,
    details: [],
  };
  for (const profile of profiles) {
    try {
      const r = await generatePlanForAssistant({ profile, now, userId });
      stats.generated += r.generated || 0;
      stats.skipped += (r.skipped || []).length;
      stats.details.push({
        assistantId: profile.assistant_id,
        characterName: profile.character_name,
        generated: r.generated,
        generatedIds: r.generatedIds || [],
        skipped: r.skipped,
      });
    } catch (error) {
      stats.details.push({
        assistantId: profile.assistant_id,
        error: error.message,
      });
    }
  }
  return stats;
}

module.exports = {
  generatePlans,
  cancelPendingPlansForAssistant,
  listPendingPlans,
  listPlansByStatus,
  findPlanById,
  markPlanSent,
  cancelPlanById,
  getRecentDraftsForAssistant,
  fetchDuePendingPlans,
};
