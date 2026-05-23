/**
 * Next-push（滚动单条计划，72h 窗口内事件驱动）。
 *
 * 拆分自原 src/services/proactivePlanService.js（2026-05-23）。
 *
 * 与 long-term cron 触发的 inactive_7d / daily_greeting 不同：
 *   1. 每次 turn（user 或 AI）落库 → cancel 已存在的 next_push pending 行 →
 *      调 LLM，输入完整上下文，让 AI 自己决定 delayMs + body + intent，
 *      或者主动 skip（例如判断"用户在忙"）。
 *   2. 同一 (assistant, user) 同一时刻最多 1 条 pending next_push（不变量）。
 *   3. 72h 内用户没回 → 不再排 next_push，让 inactive_7d 接管长期计划。
 *      用户一回 → 取消长期 plan + 重新进入 next_push 模式。
 *   4. AI 派发完一条 next_push 后会立刻再 schedule 一次（option A）；如果 AI
 *      连续 3 次都决定 "skip 用户在忙"，自然就静默到下次用户回复。
 *
 * userId 取 process.env.DEFAULT_USER_ID（single-user 模型，跟 long-term plan 一致）。
 *
 * reason 调用语义（由调用方传入）：
 *   - 'user_event'（默认）：用户刚动作，cancel 旧 pending 重排
 *   - 'post_dispatch' / 'watchdog'：被动续链，如果还有 pending 就跳过
 * 详见 scheduleNextPushPlan 顶部注释。
 */

const {
  db,
  getAssistantProfile,
  getRecentTurnsAcrossSessions,
  getRecentMemoryItems,
  getConfidentFactsForAssistant,
  insertBehaviorJournalEntry,
} = require("../../db");
const { buildStatePromptFragment } = require("../characterStateService");
const { renderBackgroundForIntrospection } = require("../character/promptComposer");
const {
  getCharacterIdentity,
  buildIdentityPromptFragment,
} = require("../character/identityService");
const { buildRelationshipFragment } = require("../character/relationshipDynamicsService");
const {
  evaluate: evaluateBehaviorIntent,
  buildIntentPromptFragment,
} = require("../character/behaviorPlanner");
const { buildAttention1h } = require("../character/attentionWindow");
const { maxJaccardAgainst } = require("../textDedupService");
const { retrieveMemory } = require("../memoryRetrievalService");

const {
  clipText,
  formatLocalTs,
  relativeTimeLabel,
  VALID_INTENTS,
  callLlmForPlanDraft,
  NEXT_PUSH_TRIGGER_REASON,
  NEXT_PUSH_FRESHNESS_WINDOW_MS,
} = require("./shared");
const {
  cancelExistingNextPushPlans,
  getLastProactiveAt,
  countNextPushIn24h,
  getLastUserMessageAt,
  insertProactivePlan,
} = require("./store");

// ── 常量 ─────────────────────────────────────────────────────────────

const NEXT_PUSH_MIN_DELAY_MS = 60 * 1000; // 最少 1 分钟，防 LLM 给 0 立即派发
const NEXT_PUSH_MAX_DELAY_MS = NEXT_PUSH_FRESHNESS_WINDOW_MS; // 最多顶到 72h 边界

// T-15 自递归限流：plan-executor 派发完一条 next_push 后会立刻再 schedule，
// 若 LLM 持续返回小 delay 会导致连环推送。下面两个闸门确保即便 LLM 抽风，单 assistant 不会被淹。
const NEXT_PUSH_MIN_GAP_FROM_LAST_MS = 30 * 60 * 1000;       // 距离上一条主动消息最少间隔 30min
const NEXT_PUSH_24H_MAX_COUNT = 12;                          // 24h 滑窗最多 12 条 next_push（约每 2h 一条）

// ── 时间段分桶（本地小时 → 自然语言标签） ────────────────────────────

function _timeBucket(hour) {
  if (hour >= 0 && hour < 6) return "深夜（0-6 点）";
  if (hour >= 6 && hour < 9) return "早晨（6-9 点 — 适合发早安）";
  if (hour >= 9 && hour < 12) return "上午";
  if (hour >= 12 && hour < 14) return "中午（12-14 点 — 适合关心吃饭）";
  if (hour >= 14 && hour < 18) return "下午";
  if (hour >= 18 && hour < 21) return "傍晚（18-21 点 — 适合关心晚餐 / 一天总结）";
  if (hour >= 21 && hour < 24) return "晚上（21-24 点 — 适合睡前问候）";
  return "未知";
}
function _weekdayLabel(date) {
  const d = date.getDay(); // 0=Sun..6=Sat
  const isWeekend = d === 0 || d === 6;
  const map = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  return `${map[d]}（${isWeekend ? "周末" : "工作日"}）`;
}

// ── Prompt ───────────────────────────────────────────────────────────

function buildNextPushPrompt({
  characterBackground,
  recentTurns,
  userFacts,
  coreFacts,
  lifeEvents,
  relevantMemories,
  lastUserMessage,
  recentAssistantMessages,
  recentProactiveDrafts, // 含 sent / cancelled / pending 的最近 proactive 草稿，避免 LLM 重复同一句
  stateFragment,
  identityFragment,
  dynamicsFragment,
  intentFragment,
  nowIso,
  now,
  hoursSinceLastUserReply,
  nowDate, // 本地 Date 对象，用来抽时间段
}) {
  // 每条都带相对时间标签 —— 不然 LLM 看不出 3 天前的事和今天的事区别，会把
  // 旧事件当今天事来问（"今天吃的怎么样？" 但其实那顿饭是 3 天前的）。
  const turnLines = recentTurns
    .slice(0, 6)
    .map((t) => `- [${relativeTimeLabel(t.created_at, now)}] ${t.role}: ${clipText(t.content, 140)}`)
    .join("\n");
  // userFacts / coreFacts 是"对用户的事实判断"，本质上是无时效的（"你做金融"
  // 而不是"你 3 天前做金融"），不给时间标签避免误导。
  const factLines = (userFacts || [])
    .slice(0, 8)
    .map((f) => `- ${f.fact_key}=${clipText(f.fact_value, 80)}`)
    .join("\n");
  const coreFactLines = (coreFacts || [])
    .slice(0, 8)
    .map((f) => `- ${f.factKey}=${clipText(f.factValue, 80)} (imp=${(f.importance ?? 0).toFixed(2)})`)
    .join("\n");
  // life_event / work_event 是有时间的具体事件，必须带时间标签
  const lifeLines = (lifeEvents || [])
    .slice(0, 5)
    .map((m) => `- [${relativeTimeLabel(m.created_at, now)}] ${clipText(m.content, 120)}`)
    .join("\n");
  const myMsgLines = (recentAssistantMessages || [])
    .slice(0, 3)
    .map((t) => `- [${relativeTimeLabel(t.created_at, now)}] ${clipText(t.content, 140)}`)
    .join("\n");
  // 语义召回的记忆 —— 跟 longTerm 路径对齐，让 LLM 能引用到 lastUserMessage 相关的
  // 旧记忆。每条也带时间，避免把上周的事说成今天的。
  const recallLines = (relevantMemories || [])
    .slice(0, 5)
    .map((m) => {
      const ts = m.createdAt || m.created_at || 0;
      const type = m.memoryType || m.memory_type || "memory";
      return `- [${relativeTimeLabel(ts, now)}/${type}] ${clipText(m.content, 130)}`;
    })
    .join("\n");
  // 把最近的 proactive 草稿（不分 status）也铺给 LLM 看 —— 之前 watchdog 30min
  // 一遍循环生成同一句 body，LLM 看不到自己 cancelled 的旧草稿，只看 conversation_turns
  // 里没有的"自言自语"，所以反复重复同一句。把 status / 时间也一起给，让 LLM 知道
  // "这句你已经说过 / 计划过 N 次了，换个角度或者干脆 skip"。
  const draftLines = (recentProactiveDrafts || [])
    .slice(0, 6)
    .map((d) => {
      const ageMin = d.created_at
        ? Math.max(0, Math.round((Date.now() - d.created_at) / 60000))
        : null;
      const ageStr = ageMin == null ? "" : `${ageMin}min 前`;
      return `- [${d.status || "?"}${ageStr ? "/" + ageStr : ""}] ${clipText(d.draft_body || "", 120)}`;
    })
    .join("\n");

  return [
    `你是这个角色。和用户在持续对话中——决定下一次想说什么、什么时候说，或者这次不发。`,
    `输出里用"你"自指、用"ta"指代用户，不要写具体名字。`,
    "",
    "**事实边界（强制遵守）**：",
    "- 只有【关键 facts】和【用户事实】两段里出现过的事实，你才能在消息里以『已知』语气提及（『你爱吃 X』『你做 Y 工作』『你住 Z』等用户偏好/属性）",
    "- 【你最近的生活/心境】是你的内心独白和行为日志 —— 里面『我做了 X』是你的行为可以引用；但里面如果出现『你爱 X / 你喜欢 X / 你习惯 X』这种**对用户的预设**，那只是你脑里的假设，**不是已确认的事实**，主动消息里不要把它当事实重复给 ta",
    "- 不确定时用试探语气（『是不是』『还记得吗』），不要用断言（『你爱的』『你最喜欢的』）",
    "- 反例：life event 写『我买了你爱吃的黑巧克力』——不要在主动消息里说『我买了你爱吃的黑巧克力』，可以说『我买了点黑巧克力』或『超市看到黑巧克力，想起你』",
    "",
    "**时间感（强制遵守）**：",
    "- 上面每条素材前面 [N 天前 / 昨天 / 3 小时前 / ...] 是这件事**实际发生的时间**，不是现在",
    "- 引用旧事件**必须带时间感**：『3 天前你说要去...，后来怎么样了』、『上次提到的 X』、『前几天那顿 Y』——不是『今天的 X 怎么样』",
    "- 反例：素材写『[3 天前] 用户：今晚吃日料』。**不能说**『今天吃了什么』或『今晚的日料好吃吗』；**可以说**『前几天那顿日料怎么样』『3 天前说去吃日料，味道还行吗』",
    "- 时间近（≤ 6 小时）才说『刚才/今天』；昨天就说『昨天』；2-6 天说『前几天 / N 天前』；更久说『上周 / 上个月』",
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
    "和上一句相关的旧记忆（语义召回）：",
    recallLines || "- 无",
    "",
    "最近 6 条对话：",
    turnLines || "- 无",
    "",
    `用户上一句：「${clipText(lastUserMessage || "（无）", 200)}」`,
    "",
    "你最近发过的话（避免角度雷同）：",
    myMsgLines || "- 无",
    "",
    "你最近主动发过 / 计划过的消息（按时间倒序，含未派发的草稿）：",
    draftLines || "- 无",
    "",
    "**主动消息连续性原则**（仔细看上面那段，按情况选）：",
    "- 上一条已发出 + ta 还没回：**绝对不要重复同一句 / 同一个关心点**。要么换完全不同的话题（『对了，今天 X 怎么样』），要么直接 skip 让 ta 喘口气",
    "- 上一条是几小时前发的早安/吃饭类问候，现在又到了相邻时段：可以承接（『早上那杯茶喝了吗』『中午吃了没』），但**承接句要明显引用上一条的具体内容**，不能再说一遍开场白",
    "- 上一条是 cancelled 的草稿（说明系统判断过不合适没派发）：把它当作『试过这个角度但被否了』，换角度",
    "- 几条草稿都是同一句或同一角度：强烈建议 skip，避免你看起来像复读机",
    "- 这条要明显能让 ta 感受到『你记得自己上一条说过什么』，不要给 ta 一种『每条消息都是独立的、互不相关的』机器人观感",
    "",
    `当前时间：${nowIso}（距用户上次回复约 ${hoursSinceLastUserReply.toFixed(1)} 小时）`,
    nowDate ? `时间段：${_timeBucket(nowDate.getHours())}，${_weekdayLabel(nowDate)}` : "",
    "",
    "时间敏感判断（按角色 + 关系亲密度调整，仅当符合时才参考）：",
    "- 早晨 6-9 点 + 关系密切（intimacyLevel ≥ 3）→ 倾向发早安/天气/早餐关心，不要 skip",
    "- 中午 12-14 / 傍晚 18-21 + 之前聊过吃饭 → 可以发吃没吃饭",
    "- 晚上 21-24 + 之前聊过失眠 / 工作累 → 倾向轻问候 / 睡前关心",
    "- 深夜 0-6：除非角色或 ta 明确是夜猫子，否则保守 skip（让 ta 睡）",
    "- 周末早晨：可以更松弛、生活化（『周末了 / 睡晚一点』）",
    "- 工作日早晨：可以鼓励性的简短一句",
    "- 已经超过 4h 没主动发 + 时段合适 → 即使没强信号也可以发『我在』或简短问候",
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

// ── 主入口 ───────────────────────────────────────────────────────────

/**
 * 给 (assistantId, userId) 排下一次推送计划。事件驱动，调用方：
 *   - HTTP /api/sync/push 收到 user-role turn 后        → reason='user_event'
 *   - WS message_create 收到消息后（同样路径）           → reason='user_event'
 *   - plan-executor 派发完一条 next_push 后（option A） → reason='post_dispatch'
 *   - proactive-watchdog cron                            → reason='watchdog'
 *
 * reason 语义：
 *   - 'user_event'：用户刚动作，上下文已变 → 总是 cancel 旧 pending 重排
 *   - 'post_dispatch' / 'watchdog'：被动续链 → **如果还有 pending 就跳过，让它派发**
 *
 * 此前 watchdog 每 30 min 调一次本函数 → 函数内部 cancelExistingNextPushPlans
 * 把还没到 scheduled_at 的 pending plan 砍掉 → 派出去的概率永远是 0，链路死锁。
 *
 * 返回 { ok, planId? , skipped? , reason? }；不抛错（内部 try/catch）让调用方放心
 * 在事件 hook 里直接调。
 */
async function scheduleNextPushPlan({
  assistantId,
  userId = null,
  now = Date.now(),
  reason = "user_event",
} = {}) {
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

    // 被动续链路径（watchdog / post_dispatch）：如果已有 pending next_push，就让它走完，
    // 不要 cancel + 重排，否则 watchdog 每 30min 自己把刚生成的 plan 砍掉，永远派不出去。
    // user_event 路径才需要刷新上下文（用户刚发了消息，AI 上一份草稿可能已经过时）。
    if (reason !== "user_event") {
      const existingPending = db
        .prepare(
          `SELECT id, scheduled_at, draft_body FROM proactive_plans
            WHERE assistant_id = ?
              AND trigger_reason = ?
              AND status = 'pending'
            ORDER BY scheduled_at ASC
            LIMIT 1`
        )
        .get(assistantId, NEXT_PUSH_TRIGGER_REASON);
      if (existingPending) {
        return {
          ok: false,
          skipped: "has_active_pending",
          pendingPlanId: existingPending.id,
          pendingScheduledAt: existingPending.scheduled_at,
        };
      }
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
      const { getCoreFacts } = require("../memoryEditService");
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
    // 2026-05-10: 加 attention_1h 入参 — 让启发式判断能用上 LLM 提炼的"现场感"。
    let attention1h = null;
    try {
      attention1h = await buildAttention1h(assistantId, { now });
    } catch (err) {
      console.warn(`[proactive] attention_1h failed: ${err.message}`);
    }
    const intentResult = (() => {
      try { return evaluateBehaviorIntent(assistantId, { now, attention1h }); } catch (err) {
        console.warn(`[proactive] intent eval failed: ${err.message}`);
        return null;
      }
    })();
    if (intentResult?.intent === "none") {
      return { ok: true, skipped: "behavior_intent_none", driver: intentResult.driver };
    }
    const intentFragment = intentResult ? buildIntentPromptFragment(intentResult) : "";

    // 最近 48h 内的 next_push 草稿（含 cancelled），喂给 LLM 让它看见自己重复 —— 否则
    // conversation_turns 里没有 watchdog cancelled 那批，LLM 永远以为这是"第一次说"。
    let recentProactiveDrafts = [];
    try {
      recentProactiveDrafts = db
        .prepare(
          `SELECT draft_body, status, created_at FROM proactive_plans
            WHERE assistant_id = ?
              AND trigger_reason = ?
              AND created_at >= ?
            ORDER BY created_at DESC
            LIMIT 6`
        )
        .all(assistantId, NEXT_PUSH_TRIGGER_REASON, now - 48 * 60 * 60 * 1000);
    } catch (e) { /* ignore */ }

    // 语义召回：以 lastUserTurn 为 seed，让 next_push 能用到向量检索的旧记忆
    // （跟 longTerm 路径对齐）。之前 next_push 只看 facts + lifeEvents top-N，引用
    // 不到"上次聊到 X 时你提到 Y"这种语义相关但不在最新窗口里的记忆。
    let relevantMemories = [];
    try {
      const memSeed = lastUserTurn?.content || profile.character_name || "";
      if (memSeed) {
        relevantMemories = await retrieveMemory({
          assistantId,
          sessionId: profile.last_session_id || `persona:${assistantId}`,
          query: memSeed,
          topK: 5,
        });
      }
    } catch (e) {
      console.warn(`[proactive] next_push retrieveMemory failed: ${e.message}`);
    }

    const prompt = buildNextPushPrompt({
      characterBackground: profile.character_background || "",
      recentTurns,
      userFacts,
      coreFacts,
      lifeEvents,
      relevantMemories,
      lastUserMessage: lastUserTurn?.content || "",
      recentAssistantMessages,
      recentProactiveDrafts,
      stateFragment,
      identityFragment,
      dynamicsFragment,
      intentFragment,
      // 显式给 LLM 看本地时间（上海时间），不用 toISOString —— 那是 UTC，LLM 会按字面值解读，时间错位 8h
      nowIso: formatLocalTs(now),
      now,
      nowDate: new Date(now), // 用来在 prompt 里渲染时间段 / 工作日
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

    // Jaccard dedup —— 与 generatePlanForAssistant 对齐。低温 + 同上下文下 LLM 会
    // 反复吐同一句话，没拦截就 30min 一条循环推送给用户。> 0.55 视为雷同直接 skip。
    //
    // 语料：最近 48h 内同一 assistant 的所有 next_push 草稿（含 cancelled），不限 status。
    // 之前过滤 status IN ('sent','pending') 会把 watchdog 死循环里被 cancel 的同 body
    // 排除在 corpus 外，dedup 形同虚设。窗口拉到 48h 防止"24h 边界滑出"导致同 body 复活。
    try {
      const corpusRows = db
        .prepare(
          `SELECT draft_body FROM proactive_plans
            WHERE assistant_id = ?
              AND trigger_reason = ?
              AND created_at >= ?
            ORDER BY created_at DESC
            LIMIT 12`
        )
        .all(assistantId, NEXT_PUSH_TRIGGER_REASON, now - 48 * 60 * 60 * 1000);
      const corpus = corpusRows.map((r) => r.draft_body || "").filter(Boolean);
      const score = maxJaccardAgainst(draft.body, corpus);
      if (score > 0.55) {
        insertBehaviorJournalEntry({
          runType: "next_push_schedule",
          assistantId,
          sessionId: profile.last_session_id || null,
          shouldPushMessage: false,
          status: "skipped",
          reason: "duplicate_against_recent_drafts",
          input: { sinceLastUserMs, jaccardScore: Number(score.toFixed(2)) },
          result: { draftBody: clipText(draft.body, 120) },
          createdAt: now,
        });
        return {
          ok: true,
          skipped: "duplicate_against_recent_drafts",
          jaccardScore: Number(score.toFixed(2)),
        };
      }
    } catch (e) {
      // dedup 失败不阻塞主流程（最多就是退化到没有 dedup，由 30min gap 闸门兜底）
      console.warn(`[proactive] next_push jaccard dedup failed: ${e.message}`);
    }

    // 抖动：watchdog cron 在 :00/:30 fires，LLM 又稳定返回 1800000ms (=30min) 这种整数 delay，
    // 直接 now + delayMs 会让所有 next_push 都落在 :00 / :30 准点，观感像机器人定时发。
    // ±10min 均匀抖动后再 clamp 回 [MIN_DELAY, 72h 窗口]。
    const NEXT_PUSH_JITTER_BAND_MS = 10 * 60 * 1000;
    const jitter = Math.floor((Math.random() - 0.5) * 2 * NEXT_PUSH_JITTER_BAND_MS);
    let scheduledAt = now + draft.delayMs + jitter;
    if (scheduledAt < now + NEXT_PUSH_MIN_DELAY_MS) {
      scheduledAt = now + NEXT_PUSH_MIN_DELAY_MS;
    }
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
  scheduleNextPushPlan,
  // 限流常量暴露用于 watchdog 复用 / 测试
  NEXT_PUSH_MIN_DELAY_MS,
  NEXT_PUSH_MAX_DELAY_MS,
  NEXT_PUSH_MIN_GAP_FROM_LAST_MS,
  NEXT_PUSH_24H_MAX_COUNT,
};
