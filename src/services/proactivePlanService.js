const { v7: uuidv7 } = require("uuid");
const config = require("../config");
const { getProvider } = require("../llm");
const { buildStatePromptFragment } = require("./characterStateService");
const { renderBackgroundForIntrospection } = require("./character/promptComposer");
// T-CC-08: identity + dynamics 注入
const {
  getCharacterIdentity,
  buildIdentityPromptFragment,
} = require("./character/identityService");
const { buildRelationshipFragment } = require("./character/relationshipDynamicsService");
// T-CC4-02: behavior intent 注入
const {
  evaluate: evaluateBehaviorIntent,
  buildIntentPromptFragment,
} = require("./character/behaviorPlanner");
const {
  db,
  getAssistantProfile,
  listProactiveAssistantProfiles,
  getRecentTurnsAcrossSessions,
  getRecentMemoryItems,
  getConfidentFactsForAssistant,
  getLastAssistantInteractionAt,
  insertBehaviorJournalEntry,
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
 * single-user 模型下的默认接收者。
 * 之前依赖 local_subscribers 表；那张表已随 HTTP 轮询通道一起删除（migration 015）。
 * WS 推送时 server 用此 userId 路由到 ws/connections.js 中已注册的 socket 集合；
 * 多用户场景请改 env DEFAULT_USER_ID。
 */
function pickFallbackUserId() {
  return process.env.DEFAULT_USER_ID || "default-user";
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

function buildPlanPrompt({
  characterBackground,
  triggerReason,
  triggerExplanation,
  triggerContext,
  recentTurns,
  userFacts,
  relevantMemories,
  recentDrafts,
  stateFragment,
  identityFragment,
  dynamicsFragment,
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

  const scenarioOneLine = (
    triggerReason === "inactive_7d"
      ? "用户已经几天没回你了。这是隔了一段时间重新开口，不是延续上次话题。"
      : triggerReason === "daily_greeting"
      ? "早上的节奏型日常问候，轻量自然就好。"
      : "按你的角色性格自由发挥。"
  );

  return [
    `你是这个角色，要给用户主动发一条消息。`,
    scenarioOneLine,
    `输出里用"你"自指、用"ta"指代用户，不要写具体名字（消息正文 body 直接对 ta 说话即可）。`,
    "",
    // T-CC-08 注入：identity → state → dynamics
    ...(identityFragment ? [identityFragment, ""] : []),
    ...(stateFragment ? [stateFragment, ""] : []),
    ...(dynamicsFragment ? [dynamicsFragment, ""] : []),
    `触发：${triggerReason} — ${triggerExplanation}`,
    "",
    "角色档案：",
    renderBackgroundForIntrospection(characterBackground, 800),
    "",
    "最近 6 条对话：",
    turnLines || "- 无",
    "",
    "用户事实：",
    factLines || "- 无",
    "",
    "相关记忆：",
    memLines || "- 无",
    "",
    "你最近发过的主动消息（避免角度雷同）：",
    draftLines || "- 无",
    "",
    "输出 JSON：",
    '{"intent":"ask_followup|check_in|share_thought|remind","title":"<≤20字>","body":"<正文>","anchorTopic":"<引用的具体事物，没有就空字符串>","rationale":"<为什么这时候写这条>"}',
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
  const body = clipText(raw.body || "", 1000);
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
  // 如果 72h 内有用户消息，next_push 在管，长期 trigger 不重复出手
  // （理论上 72h+无用户消息才会触到这里，但显式兜一道）
  const lastUserAt = getLastUserMessageAt(assistantId);
  if (lastUserAt && (now - lastUserAt) <= NEXT_PUSH_FRESHNESS_WINDOW_MS) return null;
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

async function generatePlanForAssistant({ profile, now, userId, force = false }) {
  const assistantId = profile.assistant_id;
  let triggers = evaluateAllTriggers({ assistantId, now, profile });

  // force 模式：用户在管理面板手动点"立即生成一条主动消息"，绕过 trigger 评估，
  // 直接合成一个 manual_request 类型的 trigger，scheduled_at 为 2 分钟后让 plan
  // executor 立刻派发。
  if (force && triggers.length === 0) {
    let scheduledAt = now + 2 * 60 * 1000;
    if (isInQuietHours(new Date(scheduledAt), QUIET_HOURS)) {
      scheduledAt = nextQuietEndHourMs(scheduledAt);
    }
    triggers = [
      {
        triggerReason: "manual_request",
        triggerExplanation: "用户在管理面板手动触发，立即生成一条问候/关心",
        triggerContext: "manual override; no organic trigger condition matched",
        scheduledAt,
      },
    ];
  }

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
        characterBackground: profile.character_background || "",
        triggerReason: trigger.triggerReason,
        triggerExplanation: trigger.triggerExplanation,
        triggerContext: trigger.triggerContext,
        recentTurns,
        userFacts,
        relevantMemories,
        recentDrafts,
        stateFragment: buildStatePromptFragment(assistantId),
        identityFragment: buildIdentityPromptFragment(getCharacterIdentity(assistantId)),
        dynamicsFragment: buildRelationshipFragment(assistantId),
      });
      let raw;
      try {
        raw = await callLlmForPlanDraft(prompt, { temperature: params.temperature, assistantId });
      } catch (error) {
        lastErr = error;
        continue;
      }
      const draft = normalizePlanDraft(raw);
      const reasons = [];
      // 仅保留两条最低质量门槛：
      //   - body 太短（< 4 字）：基本不像一句话
      //   - 与最近草稿语义太重（jaccard > 0.55）：连续几条角度雷同
      // 黑名单短语 / anchor 必填 / anchor 7 天去重 全部移除——它们会把"中午问吃饭"
      // 这种自然问候和"延续上轮话题"这种连续性都误杀。
      if (!draft.body || draft.body.length < 4) reasons.push("body_too_short");
      const corpus = recentDrafts.map((d) => d.draft_body || "").filter(Boolean);
      const score = maxJaccardAgainst(draft.body, corpus);
      if (score > 0.55) reasons.push(`jaccard_against_drafts:${score.toFixed(2)}`);
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
      // 命名约束：避免把 character_name 写进 draft_title，改名后会留旧名
      draftTitle: chosen.title || "想说点什么",
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
  force = false,
} = {}) {
  let profiles;
  if (assistantId) {
    const p = getAssistantProfile(assistantId);
    // force 模式下忽略 allow_proactive_message 开关
    profiles = p && (force || p.allow_proactive_message === 1) ? [p] : [];
  } else {
    // 全量场景仍尊重 allow_proactive_message=1
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
      const r = await generatePlanForAssistant({ profile, now, userId, force });
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

// ────────────────────────────────────────────────────────────────────────────
// Next-push（滚动单条计划，72h 窗口内事件驱动）
//
// 与 long-term cron 触发的 inactive_7d / daily_greeting 不同：
//
//   1. 每次 turn（user 或 AI）落库 → cancel 已存在的 next_push pending 行 →
//      调 LLM，输入完整上下文，让 AI 自己决定 delayMs + body + intent，
//      或者主动 skip（例如判断"用户在忙"）。
//   2. 同一 (assistant, user) 同一时刻最多 1 条 pending next_push（不变量）。
//   3. 72h 内用户没回 → 不再排 next_push，让 inactive_7d 接管长期计划。
//      用户一回 → 取消长期 plan + 重新进入 next_push 模式。
//   4. AI 派发完一条 next_push 后会立刻再 schedule 一次（option A）；如果 AI
//      连续 3 次都决定 "skip 用户在忙"，自然就静默到下次用户回复。
//
// userId 取 process.env.DEFAULT_USER_ID（single-user 模型，跟 long-term plan 一致）。
// ────────────────────────────────────────────────────────────────────────────

const NEXT_PUSH_TRIGGER_REASON = "next_push";
const NEXT_PUSH_FRESHNESS_WINDOW_MS = 72 * 60 * 60 * 1000;
const NEXT_PUSH_MIN_DELAY_MS = 60 * 1000; // 最少 1 分钟，防 LLM 给 0 立即派发
const NEXT_PUSH_MAX_DELAY_MS = NEXT_PUSH_FRESHNESS_WINDOW_MS; // 最多顶到 72h 边界

// T-15 自递归限流：plan-executor 派发完一条 next_push 后会立刻再 schedule，
// 若 LLM 持续返回小 delay 会导致连环推送。下面两个闸门确保即便 LLM 抽风，单 assistant 不会被淹。
const NEXT_PUSH_MIN_GAP_FROM_LAST_MS = 30 * 60 * 1000;       // 距离上一条主动消息最少间隔 30min
const NEXT_PUSH_24H_MAX_COUNT = 12;                          // 24h 滑窗最多 12 条 next_push（约每 2h 一条）

function getLastProactiveAt(assistantId) {
  try {
    const row = db
      .prepare("SELECT last_proactive_at FROM character_state WHERE assistant_id = ?")
      .get(assistantId);
    return row?.last_proactive_at || null;
  } catch {
    return null;
  }
}

function countNextPushIn24h(assistantId, now) {
  const since = now - 24 * 60 * 60 * 1000;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM proactive_plans
        WHERE assistant_id = ?
          AND trigger_reason = ?
          AND status IN ('sent', 'pending')
          AND created_at >= ?`
    )
    .get(assistantId, NEXT_PUSH_TRIGGER_REASON, since);
  return row?.n || 0;
}

function getLastUserMessageAt(assistantId) {
  const row = db
    .prepare(
      `SELECT created_at FROM conversation_turns
        WHERE assistant_id = ? AND role = 'user'
        ORDER BY created_at DESC LIMIT 1`
    )
    .get(assistantId);
  return row?.created_at || null;
}

function cancelExistingNextPushPlans(assistantId, reason = "replaced_by_new_turn") {
  const now = Date.now();
  return db
    .prepare(
      `UPDATE proactive_plans
          SET status = 'cancelled', cancelled_reason = ?, updated_at = ?
        WHERE assistant_id = ?
          AND trigger_reason = ?
          AND status = 'pending'`
    )
    .run(reason, now, assistantId, NEXT_PUSH_TRIGGER_REASON).changes || 0;
}

function buildNextPushPrompt({
  characterBackground,
  recentTurns,
  userFacts,
  coreFacts,
  lifeEvents,
  lastUserMessage,
  recentAssistantMessages,
  stateFragment,
  identityFragment,
  dynamicsFragment,
  intentFragment,
  nowIso,
  hoursSinceLastUserReply,
}) {
  const turnLines = recentTurns
    .slice(0, 6)
    .map((t) => `- ${t.role}: ${clipText(t.content, 140)}`)
    .join("\n");
  const factLines = (userFacts || [])
    .slice(0, 8)
    .map((f) => `- ${f.fact_key}=${clipText(f.fact_value, 80)}`)
    .join("\n");
  const coreFactLines = (coreFacts || [])
    .slice(0, 8)
    .map((f) => `- ${f.factKey}=${clipText(f.factValue, 80)} (imp=${(f.importance ?? 0).toFixed(2)})`)
    .join("\n");
  const lifeLines = (lifeEvents || [])
    .slice(0, 5)
    .map((m) => `- ${clipText(m.content, 120)}`)
    .join("\n");
  const myMsgLines = (recentAssistantMessages || [])
    .slice(0, 3)
    .map((t) => `- ${clipText(t.content, 140)}`)
    .join("\n");

  return [
    `你是这个角色。和用户在持续对话中——决定下一次想说什么、什么时候说，或者这次不发。`,
    `输出里用"你"自指、用"ta"指代用户，不要写具体名字。`,
    "",
    // T-CC-08 注入：identity → state → dynamics
    ...(identityFragment ? [identityFragment, ""] : []),
    ...(stateFragment ? [stateFragment, ""] : []),
    ...(dynamicsFragment ? [dynamicsFragment, ""] : []),
    // T-CC4-02 注入：本次主动消息的意图（behaviorPlanner 决策）
    ...(intentFragment ? [intentFragment, ""] : []),
    "角色档案：",
    renderBackgroundForIntrospection(characterBackground, 600),
    "",
    "关键 facts：",
    coreFactLines || "- 无",
    "",
    "用户事实：",
    factLines || "- 无",
    "",
    "你最近的生活/心境：",
    lifeLines || "- 无",
    "",
    "最近 6 条对话：",
    turnLines || "- 无",
    "",
    `用户上一句：「${clipText(lastUserMessage || "（无）", 200)}」`,
    "",
    "你最近发过的话（避免角度雷同）：",
    myMsgLines || "- 无",
    "",
    `当前时间：${nowIso}（距用户上次回复约 ${hoursSinceLastUserReply.toFixed(1)} 小时）`,
    "",
    `delayMs ∈ [${NEXT_PUSH_MIN_DELAY_MS}, 72h]，要不发则 skip=true 配 skipReason（任意理由）。`,
    "频率完全自由，按角色 + 当下情境自己定。亲密关系想几分钟一条就几分钟一条，想隔半天就隔半天；普通关系自然拉长；不需要任何\"标准节奏\"。",
    "",
    "输出 JSON：",
    '{"skip":false,"skipReason":"","delayMs":1800000,"intent":"ask_followup|check_in|share_thought|remind","title":"<≤20字>","body":"<正文>","anchorTopic":"<引用的具体事物，没有就空字符串>","rationale":"<为什么这时候这条/为什么 skip>"}',
  ].join("\n");
}

function normalizeNextPushDraft(raw = {}) {
  if (raw.skip === true || String(raw.skip || "").toLowerCase() === "true") {
    return { skip: true, skipReason: clipText(raw.skipReason || "ai_chose_skip", 80) };
  }
  const intentRaw = String(raw.intent || "")
    .trim().toLowerCase().replace(/[\s-]+/g, "_");
  const intent = VALID_INTENTS.has(intentRaw) ? intentRaw : "check_in";
  const delayMs = Math.max(
    NEXT_PUSH_MIN_DELAY_MS,
    Math.min(NEXT_PUSH_MAX_DELAY_MS, Number(raw.delayMs) || 0)
  );
  return {
    skip: false,
    skipReason: null,
    delayMs,
    intent,
    title: clipText(raw.title || "", 40),
    body: clipText(raw.body || "", 1000),
    anchorTopic: clipText(raw.anchorTopic || "", 60),
    rationale: clipText(raw.rationale || "", 200),
  };
}

/**
 * 给 (assistantId, userId) 排下一次推送计划。事件驱动，调用方：
 *   - HTTP /api/sync/push 收到 user-role turn 后
 *   - WS message_create 收到消息后（同样路径）
 *   - plan-executor 派发完一条 next_push 后（option A）
 *
 * 返回 { ok, planId? , skipped? , reason? }；不抛错（内部 try/catch）让调用方放心
 * 在事件 hook 里直接调。
 */
async function scheduleNextPushPlan({ assistantId, userId = null, now = Date.now() } = {}) {
  if (!assistantId) return { ok: false, skipped: "no_assistant_id" };

  try {
    const profile = getAssistantProfile(assistantId);
    if (!profile) return { ok: false, skipped: "no_profile" };
    if (profile.allow_proactive_message !== 1) return { ok: false, skipped: "proactive_disabled" };

    const lastUserAt = getLastUserMessageAt(assistantId);
    if (!lastUserAt) return { ok: false, skipped: "no_user_history" };

    const sinceLastUserMs = now - lastUserAt;
    if (sinceLastUserMs > NEXT_PUSH_FRESHNESS_WINDOW_MS) {
      // 72h 已过 — next_push 不再排，让 inactive_7d 等长期 trigger 接管。
      // 顺带 cancel 任何残留 pending（理论上不会有）
      cancelExistingNextPushPlans(assistantId, "past_72h_handover_to_long_term");
      return { ok: false, skipped: "past_72h_handover_to_long_term" };
    }

    // T-15 限流闸门 1：距离上一条主动消息不能太近，防自递归冲量
    const lastProactiveAt = getLastProactiveAt(assistantId);
    if (lastProactiveAt && now - lastProactiveAt < NEXT_PUSH_MIN_GAP_FROM_LAST_MS) {
      return {
        ok: false,
        skipped: "min_gap_from_last_proactive",
        msSinceLastProactive: now - lastProactiveAt,
      };
    }

    // T-15 限流闸门 2：24h 滑窗 next_push 派发次数封顶
    const recent24hCount = countNextPushIn24h(assistantId, now);
    if (recent24hCount >= NEXT_PUSH_24H_MAX_COUNT) {
      return {
        ok: false,
        skipped: "next_push_24h_cap_exceeded",
        recent24hCount,
      };
    }

    // 不变量：先 cancel 旧的，再插新的
    cancelExistingNextPushPlans(assistantId, "replaced_by_new_turn");

    const recentTurns = getRecentTurnsAcrossSessions({ assistantId, limit: 8 });
    const lastUserTurn = recentTurns.find((t) => t.role === "user");
    const recentAssistantMessages = recentTurns.filter((t) => t.role === "assistant").slice(0, 3);
    const userFacts = getConfidentFactsForAssistant({ assistantId, minConfidence: 0.5, limit: 12 });

    let coreFacts = [];
    try {
      const { getCoreFacts } = require("./memoryEditService");
      coreFacts = getCoreFacts(assistantId, { limit: 8 });
    } catch (e) { /* ignore */ }

    let lifeEvents = [];
    try {
      lifeEvents = getRecentMemoryItems({
        assistantId,
        memoryTypes: ["life_event", "work_event"],
        limit: 5,
      });
    } catch (e) { /* ignore */ }

    const stateFragment = (() => {
      try { return buildStatePromptFragment(assistantId); } catch { return ""; }
    })();
    const identityFragment = (() => {
      try { return buildIdentityPromptFragment(getCharacterIdentity(assistantId)); } catch { return ""; }
    })();
    const dynamicsFragment = (() => {
      try { return buildRelationshipFragment(assistantId); } catch { return ""; }
    })();
    // T-CC4-02: behaviorPlanner 决策本次推送意图。intent='none' 时早 return，不发。
    const intentResult = (() => {
      try { return evaluateBehaviorIntent(assistantId, { now }); } catch (err) {
        console.warn(`[proactive] intent eval failed: ${err.message}`);
        return null;
      }
    })();
    if (intentResult?.intent === "none") {
      return { ok: true, skipped: "behavior_intent_none", driver: intentResult.driver };
    }
    const intentFragment = intentResult ? buildIntentPromptFragment(intentResult) : "";

    const prompt = buildNextPushPrompt({
      characterBackground: profile.character_background || "",
      recentTurns,
      userFacts,
      coreFacts,
      lifeEvents,
      lastUserMessage: lastUserTurn?.content || "",
      recentAssistantMessages,
      stateFragment,
      identityFragment,
      dynamicsFragment,
      intentFragment,
      // 显式给 LLM 看本地时间（上海时间），不用 toISOString —— 那是 UTC，LLM 会按字面值解读，时间错位 8h
      nowIso: formatLocalTs(now),
      hoursSinceLastUserReply: sinceLastUserMs / (60 * 60 * 1000),
    });

    let raw;
    try {
      raw = await callLlmForPlanDraft(prompt, { temperature: 0.7, maxTokens: 800, assistantId });
    } catch (e) {
      return { ok: false, skipped: "llm_unreachable", error: e.message };
    }

    const draft = normalizeNextPushDraft(raw);

    if (draft.skip) {
      insertBehaviorJournalEntry({
        runType: "next_push_schedule",
        assistantId,
        sessionId: profile.last_session_id || null,
        shouldPushMessage: false,
        status: "skipped",
        reason: "ai_chose_skip",
        input: { sinceLastUserMs, lastUserPreview: clipText(lastUserTurn?.content || "", 80) },
        result: { skipReason: draft.skipReason },
        createdAt: now,
      });
      return { ok: true, skipped: "ai_chose_skip", skipReason: draft.skipReason };
    }

    if (!draft.body || draft.body.length < 2) {
      return { ok: false, skipped: "empty_body" };
    }

    const scheduledAt = now + draft.delayMs;
    if (scheduledAt - lastUserAt > NEXT_PUSH_FRESHNESS_WINDOW_MS) {
      // delay 超出 72h 窗口边界 → 让 long-term 接管
      return { ok: false, skipped: "scheduled_beyond_72h_window" };
    }

    const planId = insertProactivePlan({
      assistantId,
      userId: userId || process.env.DEFAULT_USER_ID || "default-user",
      triggerReason: NEXT_PUSH_TRIGGER_REASON,
      intent: draft.intent,
      // 命名约束：避免把 character_name 写进 draft_title，改名后会留旧名
      draftTitle: draft.title || "想说点什么",
      draftBody: draft.body,
      anchorTopic: draft.anchorTopic,
      rationale: draft.rationale,
      scheduledAt,
      now,
    });

    insertBehaviorJournalEntry({
      runType: "next_push_schedule",
      assistantId,
      sessionId: profile.last_session_id || null,
      shouldPushMessage: true,
      status: "ok",
      reason: "next_push_planned",
      messageIntent: draft.intent,
      draftMessage: draft.body,
      input: { sinceLastUserMs, delayMs: draft.delayMs },
      result: { planId, anchorTopic: draft.anchorTopic, scheduledAt },
      createdAt: now,
    });

    return { ok: true, planId, scheduledAt, delayMs: draft.delayMs, body: draft.body };
  } catch (error) {
    return { ok: false, skipped: "exception", error: error.message };
  }
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
  scheduleNextPushPlan,
  cancelExistingNextPushPlans,
  NEXT_PUSH_TRIGGER_REASON,
  NEXT_PUSH_FRESHNESS_WINDOW_MS,
};
