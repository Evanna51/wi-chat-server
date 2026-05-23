/**
 * 长期 trigger 主动消息：inactive_7d / daily_greeting / manual_request。
 *
 * 拆分自原 src/services/proactivePlanService.js（2026-05-23）。
 *
 * 跑法：scheduler.js 的 plan-generation cron 周期性调 generatePlans，扫所有
 * allow_proactive_message=1 的 assistant，对每个角色：
 *   1) 跑 evaluateAllTriggers → 拿到本轮 hit 的 trigger 列表
 *   2) 对每个 trigger 跑 LLM 生成 draft，做最低质量过滤（body 长度 / jaccard）
 *   3) 写入 proactive_plans 表，等 plan-executor 派发
 *
 * 与 nextPush 的关系：next_push 是 72h 内事件驱动；长期 trigger 是 72h+ 的接管。
 * evaluateInactive7d 显式让 last_user 在 72h 内时让位给 next_push。
 */

const config = require("../../config");
const {
  getAssistantProfile,
  listProactiveAssistantProfiles,
  getRecentTurnsAcrossSessions,
  getConfidentFactsForAssistant,
  insertBehaviorJournalEntry,
  getLastAssistantInteractionAt,
} = require("../../db");
const { retrieveMemory } = require("../memoryRetrievalService");
const { buildStatePromptFragment } = require("../characterStateService");
const { renderBackgroundForIntrospection } = require("../character/promptComposer");
const {
  getCharacterIdentity,
  buildIdentityPromptFragment,
} = require("../character/identityService");
const { buildRelationshipFragment } = require("../character/relationshipDynamicsService");
const { maxJaccardAgainst } = require("../textDedupService");
const { parseQuietHours, isInQuietHours } = require("../characterEngine");

const {
  clipText,
  relativeTimeLabel,
  startOfDayMs,
  jitterMs,
  VALID_INTENTS,
  callLlmForPlanDraft,
  NEXT_PUSH_FRESHNESS_WINDOW_MS,
  pickFallbackUserId,
} = require("./shared");
const {
  findRecentPendingByTriggerWithin,
  getRecentDraftsForAssistant,
  insertProactivePlan,
  getLastUserMessageAt,
} = require("./store");

// ── 静默时段 ─────────────────────────────────────────────────────────

const QUIET_HOURS = parseQuietHours(config.autonomousQuietHours);

function nextQuietEndHourMs(now) {
  // 推到下一个非静默整点，再加 0~20 min jitter，避免所有消息堆在整点。
  for (let i = 0; i < 24; i += 1) {
    const candidate = new Date(now + i * 60 * 60 * 1000);
    candidate.setMinutes(0, 0, 0);
    if (!isInQuietHours(candidate, QUIET_HOURS)) {
      return candidate.getTime() + jitterMs(20 * 60 * 1000);
    }
  }
  return now;
}

// ── Triggers ─────────────────────────────────────────────────────────

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
    // 09:05 ~ 09:25，避免随机到 0 落在 09:00 整点，给用户准点推送的观感
    scheduledAt =
      startOfDay + 9 * 60 * 60 * 1000 + 5 * 60 * 1000 + jitterMs(20 * 60 * 1000);
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

// ── Prompt + draft 规范化 ─────────────────────────────────────────────

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
  now = Date.now(),
}) {
  // 每条素材都带相对时间标签，让 LLM 看清"几天前的事 vs 今天的事"，
  // 避免把旧事件当今天事来问（"今天吃的怎么样" 但其实那顿是 3 天前的）。
  const turnLines = recentTurns
    .slice(0, 6)
    .map((t) => `- [${relativeTimeLabel(t.created_at, now)}] ${t.role}: ${clipText(t.content, 140)}`)
    .join("\n");
  // userFacts 是无时效的"用户属性"，不带时间标签
  const factLines = userFacts
    .slice(0, 12)
    .map((f) => `- ${f.fact_key}=${clipText(f.fact_value, 80)}`)
    .join("\n");
  const memLines = relevantMemories
    .slice(0, 5)
    .map((m) => {
      const ts = m.createdAt || m.created_at || 0;
      const type = m.memoryType || m.memory_type || "memory";
      return `- [${relativeTimeLabel(ts, now)}/${type}] ${clipText(m.content, 140)}`;
    })
    .join("\n");
  const draftLines = recentDrafts
    .slice(0, 10)
    .map(
      (d) =>
        `- [${relativeTimeLabel(d.created_at, now)}/${d.trigger_reason || "unknown"}/${d.status || "?"}] ${clipText(
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
    "**时间感（强制遵守）**：每条素材前面 [N 天前 / 昨天 / ...] 是这件事实际发生的时间，不是现在。引用旧事件必须带时间感（『前几天提到的 X』『上次说去 Y 怎么样了』），不要把 3 天前的事说成『今天』。时间近（≤ 6 小时）才说『刚才/今天』。",
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

// ── 单角色生成 ───────────────────────────────────────────────────────

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
        now,
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

// ── 多角色入口（cron 主调用方） ───────────────────────────────────────

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

module.exports = {
  generatePlans,
  generatePlanForAssistant,
  // 暴露用于测试 / debug
  evaluateAllTriggers,
  evaluateInactive7d,
  evaluateDailyGreeting,
};
