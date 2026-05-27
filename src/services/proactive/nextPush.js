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
 *   - 'life_event_seed'：lifeBeatTickService 触发 —— 角色刚发生了 anchored beat
 *     （想起 她 的瞬间），把 beat 内容作为 seed 注入 prompt 让 LLM 围绕它展开。
 *     续链语义同 'post_dispatch'：有 pending 就跳过，让已经生成的 plan 先派出去。
 * 详见 scheduleNextPushPlan 顶部注释 + docs/character-life-beat-plan.md。
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
  findUsedAnchorTopicWithin,
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

/**
 * 把 lifeBeatTickService 传来的 anchored beat seed 渲染成 prompt 段。
 * seed = { activity, reachSeed, importance, beatScheduledAt }
 *
 * 设计取舍：用「当下契机」开头标记，让 LLM 把它当**触发因**而不是普通素材。
 * 但同时强约束「不要假设 她 的喜好」—— anchored beat 的 reachSeed 可能是
 * 「她 上次提想试 X」这种来自对话的引用，可以引用；但仍要避免 LLM 把它升级
 * 成「她 爱 X」的事实断言。
 */
function _renderLifeBeatSeed(seed) {
  if (!seed) return "";
  const ts = seed.beatScheduledAt ? new Date(seed.beatScheduledAt) : null;
  const timeLabel = ts
    ? `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}`
    : "刚才";
  const lines = [
    "**当下契机（这是你刚刚真实经历的一个瞬间，本条主动消息应该围绕它自然展开）**：",
    `- 时刻：${timeLabel}`,
    `- 你在：${clipText(seed.activity || "", 200)}`,
  ];
  if (seed.reachSeed) {
    lines.push(`- 触发你想到 她 的点：${clipText(seed.reachSeed, 160)}`);
  }
  lines.push(
    '→ 用这个契机自然引出消息（"我刚才在 X / 看到 Y 想到你"），不要硬塞，',
    "  不要假设 她 的喜好（除非【用户事实】里有），不要把契机直接背诵给 她。",
    '  契机是你"为什么这一刻想说话"的理由，不是消息正文本身。'
  );
  return lines.join("\n");
}

// ── Prompt ───────────────────────────────────────────────────────────
//
// 2026-05-24：把单次 LLM 调用拆成两步（think → compose），让"判断"与"写"分开。
//   step 1 think：吃所有上下文，决定 shouldPush + delayMs + mood + topicCandidate + intent +
//                 anchorTopic + rationale；skip 的话给 skipReason
//   step 2 compose：只在 shouldPush=true 时跑，吃 step 1 输出 + 写作约束，产出 title + body
// 好处：
//   1. think 的 rationale 直接落盘进 proactive_plans.rationale —— 用户翻日记时能看到
//      "她那天为什么决定不联系我"
//   2. compose 拿着已经决定好的 mood / topic / intent，prompt 焦点单一，正文质量更稳
//   3. skip 路径不再消耗 compose 的 token

function _renderSharedContext({
  characterBackground,
  recentTurns,
  userFacts,
  coreFacts,
  lifeEvents,
  relevantMemories,
  lastUserMessage,
  recentAssistantMessages,
  recentProactiveDrafts,
  stateFragment,
  identityFragment,
  dynamicsFragment,
  intentFragment,
  lifeBeatSeed,
  now,
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
      return `- [${d.status || "?"}${ageStr ? "/" + ageStr : ""}] ${clipText(d.draft_body || "", 280)}`;
    })
    .join("\n");

  return {
    identityFragment, stateFragment, dynamicsFragment, intentFragment,
    lifeBeatSeed, characterBackground,
    coreFactLines, factLines, lifeLines, recallLines,
    turnLines, lastUserMessage, myMsgLines, draftLines,
  };
}

// ── Think prompt（step 1：决定要不要发 + 心情 / 话题 / intent） ───────

function buildThinkPrompt({
  ctx,
  nowIso,
  hoursSinceLastUserReply,
  nowDate,
}) {
  return [
    `你是这个角色。和用户在持续对话中——现在要判断：**你想不想给 她 发消息**，什么时候发，发什么话题，用什么情绪基调。`,
    `这一步只是想清楚，不写正文。输出里用"你"自指、用"她"指代用户，不要写具体名字。`,
    "",
    ...(ctx.identityFragment ? [ctx.identityFragment, ""] : []),
    ...(ctx.stateFragment ? [ctx.stateFragment, ""] : []),
    ...(ctx.dynamicsFragment ? [ctx.dynamicsFragment, ""] : []),
    ...(ctx.intentFragment ? [ctx.intentFragment, ""] : []),
    ...(ctx.lifeBeatSeed ? [_renderLifeBeatSeed(ctx.lifeBeatSeed), ""] : []),
    "角色档案：",
    renderBackgroundForIntrospection(ctx.characterBackground, 600),
    "",
    "关键 facts：",
    ctx.coreFactLines || "- 无",
    "",
    "用户事实：",
    ctx.factLines || "- 无",
    "",
    "你最近的生活/心境：",
    ctx.lifeLines || "- 无",
    "",
    "和上一句相关的旧记忆（语义召回）：",
    ctx.recallLines || "- 无",
    "",
    "最近 6 条对话：",
    ctx.turnLines || "- 无",
    "",
    `用户上一句：「${clipText(ctx.lastUserMessage || "（无）", 200)}」`,
    "",
    "你最近发过的话（避免角度雷同）：",
    ctx.myMsgLines || "- 无",
    "",
    "你最近主动发过 / 计划过的消息（按时间倒序，含未派发的草稿）：",
    ctx.draftLines || "- 无",
    "",
    "**判断时考虑这些**：",
    "- 上一条已发出 + 她 还没回 → 倾向 skip 或换完全不同的话题，绝不重复同一关心点",
    "- 上一条是几小时前的早安/吃饭问候，现在到相邻时段 → 可承接（但承接句要引用具体内容）",
    "- 上一条 cancelled 草稿 → 把它当作『试过被否了』，换角度",
    "- 几条草稿同句同角度 → 强烈倾向 skip",
    "- **她 上一句是「晚安」/「再见」/「先睡了」/「去忙了」/「拜拜」等结束语** → 强烈 skip 或 delay ≥ 4h；她 主动结束了对话，立刻追发消息会破坏刚才那句话的情绪",
    "",
    `当前时间：${nowIso}（距用户上次回复约 ${hoursSinceLastUserReply.toFixed(1)} 小时）`,
    nowDate ? `时间段：${_timeBucket(nowDate.getHours())}，${_weekdayLabel(nowDate)}` : "",
    "",
    "时间敏感判断（按角色 + 关系亲密度调整，仅当符合时才参考）：",
    "- 早晨 6-9 点 + 关系密切（intimacyLevel ≥ 3）→ 倾向发早安/天气/早餐关心，不要 skip",
    "- 中午 12-14 / 傍晚 18-21 + 之前聊过吃饭 → 可以发吃没吃饭",
    "- 晚上 21-24 + 之前聊过失眠 / 工作累 → 倾向轻问候 / 睡前关心",
    "- 深夜 0-6：除非角色或 她 明确是夜猫子，否则保守 skip（让 她 睡）",
    "- 周末早晨：可以更松弛、生活化",
    "- 工作日早晨：可以鼓励性的简短一句",
    "- 已经超过 4h 没主动发 + 时段合适 → 即使没强信号也可以发简短问候",
    "",
    `delayMs ∈ [${NEXT_PUSH_MIN_DELAY_MS}, 72h]。频率完全自由，按角色 + 当下情境自己定。`,
    "",
    "**recallQuery（重要）**：",
    "- 上面【和上一句相关的旧记忆】是 server 基于 她 最后一句自动召回的，可能不是你真正想引用的角度",
    "- 如果你心里想聊的事（topicCandidate）需要更具体的旧记忆来支撑（比如『上次 她 说的 X』『前几天那次 Y』），写一个简短 query（10-40 字）让 server 重新搜",
    "- query 写你想找的核心词 / 短语，越具体越好；不需要重搜就留空字符串",
    "- 例：topicCandidate=『问问她上次面试的结果』 → recallQuery=『上次面试 紧张 准备』",
    "- 例：topicCandidate=『分享我今天看的电影』 → recallQuery=''（不需要查 她 的旧记忆）",
    "",
    "**depth（消息分量）**：",
    "- brief：日常关心、轻问候、随口一提 → compose 写 30-80 字",
    "- medium：有具体事件想跟进、有情绪想分享 → compose 写 80-160 字",
    "- deep：严肃话题上次没说完（她 或 你 当时搁置了）、或超过 3 天未联系 → compose 写 160-280 字",
    "→ 优先 brief；只有真的有足够内容支撑才升 depth",
    "",
    "输出 JSON（只判断，不写正文）：",
    '{"shouldPush":true,"skipReason":"","delayMs":1800000,"mood":"<你当下的情绪基调，2-6字，如：温柔关切/想念/淡淡好奇/略疲>","topicCandidate":"<唯一切入点，10-30字；只选一件事，compose 阶段不会再扩展其他话题>","anchorTopic":"<要引用的具体旧事物，没有就空字符串>","depth":"brief|medium|deep","intent":"ask_followup|check_in|share_thought|remind","recallQuery":"<想重搜的旧记忆 query，不需要就空>","rationale":"<为什么这时候这条 / 为什么 skip，30-100字>"}',
  ].join("\n");
}

function normalizeThinkOutput(raw = {}) {
  const shouldPush =
    raw.shouldPush === true || String(raw.shouldPush || "").toLowerCase() === "true";
  if (!shouldPush) {
    return {
      shouldPush: false,
      skipReason: clipText(raw.skipReason || raw.rationale || "ai_chose_skip", 120),
      rationale: clipText(raw.rationale || raw.skipReason || "", 200),
    };
  }
  const intentRaw = String(raw.intent || "")
    .trim().toLowerCase().replace(/[\s-]+/g, "_");
  const intent = VALID_INTENTS.has(intentRaw) ? intentRaw : "check_in";
  const delayMs = Math.max(
    NEXT_PUSH_MIN_DELAY_MS,
    Math.min(NEXT_PUSH_MAX_DELAY_MS, Number(raw.delayMs) || 0)
  );
  const depthRaw = String(raw.depth || "").toLowerCase().trim();
  const depth = ["medium", "deep"].includes(depthRaw) ? depthRaw : "brief";
  return {
    shouldPush: true,
    delayMs,
    mood: clipText(raw.mood || "", 24),
    topicCandidate: clipText(raw.topicCandidate || "", 80),
    anchorTopic: clipText(raw.anchorTopic || "", 60),
    depth,
    intent,
    recallQuery: clipText(raw.recallQuery || "", 120),
    rationale: clipText(raw.rationale || "", 200),
  };
}

// ── Compose prompt（step 2：写正文。已经决定了 mood + topic + intent） ─

function buildComposePrompt({
  ctx,
  thinkOutput, // { mood, topicCandidate, anchorTopic, intent, rationale }
  nowIso,
}) {
  return [
    `你是这个角色。你已经决定要给 她 发一条主动消息。现在写正文。`,
    `输出里用"你"自指、用"她"指代用户，不要写具体名字。`,
    "",
    "**你刚才的内心判断（必须遵循）**：",
    `- 心情：${thinkOutput.mood || "（未指定）"}`,
    `- 想说的切入点：${thinkOutput.topicCandidate || "（未指定）"}`,
    `- 引用的旧事物：${thinkOutput.anchorTopic || "（无）"}`,
    `- 意图：${thinkOutput.intent}`,
    `- 为什么这时候这条：${thinkOutput.rationale || "（未指定）"}`,
    "→ 围绕『想说的切入点』展开。不要换话题，不要扩大范围。",
    "",
    "**正文规格（强制）**：",
    ...(thinkOutput.depth === "deep"
      ? [
          "- 分量：deep —— 严肃话题搁置 / 久未联系，允许 160-280 字、3-5 句；有足够情感重量时才往上写，写完就够",
        ]
      : thinkOutput.depth === "medium"
      ? [
          "- 分量：medium —— 有具体事件想跟进，目标 80-160 字、2-4 句",
        ]
      : [
          "- 分量：brief（默认）—— 日常关心，目标 30-80 字、1-2 句；这是一条短信，不是一封信",
        ]),
    "- 只展开『想说的切入点』这一个话题；下面的【用户事实】是背景参考，不是清单，不要逐一提及",
    "- **check_in 类消息禁止用通用句式**（'记得吃饭'/'记得休息'/'保重身体'等）——必须结合【用户事实】或当前上下文里的具体细节（ta 在做什么、ta 的饮食偏好/禁忌、今天发生了什么）来写；没有具体素材就不写这类话",
    "- 禁止使用 AI/科幻自我描述词（如'数字意识体'/'信号序列'/'感知一切'/'数字空间'等）—— 这类词让消息读起来像 chatbot 台词，破坏真实感",
    "- 【角色人格】是你说话的底色，不要把里面的概念词直接说出来；用情绪、动作或具体细节来体现它",
    "",
    "**事实边界（强制遵守）**：",
    "- 只有【关键 facts】和【用户事实】两段里出现过的事实，你才能在消息里以『已知』语气提及（『你爱吃 X』『你做 Y 工作』等）",
    "- 【你最近的生活/心境】里的『我做了 X』可以引用；但里面如果出现『你爱 X / 你喜欢 X』这种**对用户的预设**，那只是你脑里的假设，**不是已确认的事实**，正文里不要把它当事实重复给 ta",
    "- 不确定时用试探语气（『是不是』『还记得吗』），不要用断言",
    "- 反例：life event 写『我买了你爱吃的黑巧克力』——不要在正文说『我买了你爱吃的黑巧克力』，可以说『我买了点黑巧克力』或『超市看到黑巧克力，想起你』",
    "",
    "**时间感（强制遵守）**：",
    "- 素材前面 [N 天前 / 昨天 / 3 小时前 / ...] 是这件事**实际发生的时间**，不是现在",
    "- 引用旧事件**必须带时间感**：『3 天前你说要去...』『上次提到的 X』『前几天那顿 Y』——不是『今天的 X 怎么样』",
    "- 时间近（≤ 6 小时）才说『刚才/今天』；昨天就说『昨天』；2-6 天说『前几天 / N 天前』；更久说『上周 / 上个月』",
    "",
    "**连续性**：",
    "- 这条要明显能让 她 感受到『你记得自己上一条说过什么』",
    "- 看一眼下面【你最近主动发过的话】，不要和它们句式 / 角度雷同",
    "- **禁止复用**：不得在正文里重复出现【你最近主动发过的话】中任何连续 8 字以上的片段（原句照搬是最差的连续性）",
    "",
    ...(ctx.identityFragment ? [ctx.identityFragment, ""] : []),
    ...(ctx.lifeBeatSeed ? [_renderLifeBeatSeed(ctx.lifeBeatSeed), ""] : []),
    "角色档案：",
    renderBackgroundForIntrospection(ctx.characterBackground, 600),
    "",
    "关键 facts：",
    ctx.coreFactLines || "- 无",
    "",
    "用户事实：",
    ctx.factLines || "- 无",
    "",
    "你最近的生活/心境：",
    ctx.lifeLines || "- 无",
    "",
    "和上一句相关的旧记忆：",
    ctx.recallLines || "- 无",
    "",
    "最近 6 条对话：",
    ctx.turnLines || "- 无",
    "",
    `用户上一句：「${clipText(ctx.lastUserMessage || "（无）", 200)}」`,
    "",
    "你最近主动发过的话（避免雷同）：",
    ctx.draftLines || "- 无",
    "",
    `当前时间：${nowIso}`,
    "",
    "输出 JSON：",
    '{"title":"<≤20字>","body":"<正文>"}',
  ].join("\n");
}

function normalizeComposeOutput(raw = {}, depth = "brief") {
  const bodyLimit = depth === "deep" ? 500 : depth === "medium" ? 320 : 160;
  return {
    title: clipText(raw.title || "", 40),
    body: clipText(raw.body || "", bodyLimit),
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
  seed = null,  // life_event_seed 路径专用：{ activity, reachSeed, importance, beatScheduledAt }
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
    const userFacts = getConfidentFactsForAssistant({
      assistantId,
      minConfidence: 0.5,
      limit: 12,
      characterName: profile.character_name,
    });

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

    // 把所有素材渲染成 prompt 段，两步 LLM 调用共享同一份上下文。
    const ctx = _renderSharedContext({
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
      lifeBeatSeed: reason === "life_event_seed" ? seed : null,
      now,
    });
    // 显式给 LLM 看本地时间（上海时间），不用 toISOString —— 那是 UTC，时间错位 8h
    const nowIso = formatLocalTs(now);
    const nowDate = new Date(now);
    const hoursSinceLastUserReply = sinceLastUserMs / (60 * 60 * 1000);

    // ── step 1: think —— 决定要不要发 + 心情 / 话题 / intent ──
    const thinkPrompt = buildThinkPrompt({ ctx, nowIso, hoursSinceLastUserReply, nowDate });
    let thinkRaw;
    try {
      thinkRaw = await callLlmForPlanDraft(thinkPrompt, {
        temperature: 0.6,           // 判断阶段降一点温度，决策更稳
        maxTokens: 400,
        assistantId,
      });
    } catch (e) {
      return { ok: false, skipped: "llm_unreachable", error: e.message };
    }
    const think = normalizeThinkOutput(thinkRaw);

    if (!think.shouldPush) {
      // Web-topic fallback：LLM 说没话题 → 兜底跑 web search 找热点重写一条。
      // 配额闸门在 webSearchService 里（每角色每自然日 3 次默认）。失败就接受原 skip。
      try {
        const { tryWebTopicFallback } = require("./topicFallback");
        const fb = await tryWebTopicFallback({ assistantId, profile, now });
        if (fb?.ok) {
          // 用 trigger_reason='web_topic' 与普通 next_push 区分；post_dispatch
          // 路径只对 NEXT_PUSH_TRIGGER_REASON 续链，web_topic 不会自递归。
          const NEXT_PUSH_JITTER_BAND_MS = 10 * 60 * 1000;
          const jitter = Math.floor((Math.random() - 0.5) * 2 * NEXT_PUSH_JITTER_BAND_MS);
          // web_topic 默认排在 5~15min 后（短延迟让用户感觉是"刚看到就分享"）
          let scheduledAt = now + 10 * 60 * 1000 + jitter;
          if (scheduledAt < now + NEXT_PUSH_MIN_DELAY_MS) {
            scheduledAt = now + NEXT_PUSH_MIN_DELAY_MS;
          }
          const planId = insertProactivePlan({
            assistantId,
            userId: userId || process.env.DEFAULT_USER_ID || "default-user",
            triggerReason: "web_topic",
            intent: fb.intent,
            draftTitle: fb.title || "想说点什么",
            draftBody: fb.body,
            anchorTopic: fb.anchorTopic,
            // rationale 里塞 sourceUrl 方便回查
            rationale: clipText(
              `${fb.rationale}${fb.sourceUrl ? ` | src=${fb.sourceUrl}` : ""}`,
              500
            ),
            scheduledAt,
            now,
          });
          insertBehaviorJournalEntry({
            runType: "next_push_schedule",
            assistantId,
            sessionId: profile.last_session_id || null,
            shouldPushMessage: true,
            status: "ok",
            reason: "web_topic_planned",
            messageIntent: fb.intent,
            draftMessage: fb.body,
            input: { sinceLastUserMs, originalSkipReason: think.skipReason, query: fb.query },
            result: { planId, sourceUrl: fb.sourceUrl, scheduledAt },
            createdAt: now,
          });
          return {
            ok: true,
            planId,
            scheduledAt,
            body: fb.body,
            via: "web_topic",
            sourceUrl: fb.sourceUrl,
          };
        }
        // fallback 失败（query_planner / no_snippets / daily_cap_exceeded /
        // api_key_missing 等）→ 落 journal 但仍接受原 skip
        insertBehaviorJournalEntry({
          runType: "next_push_schedule",
          assistantId,
          sessionId: profile.last_session_id || null,
          shouldPushMessage: false,
          status: "skipped",
          reason: "ai_chose_skip",
          input: {
            sinceLastUserMs,
            lastUserPreview: clipText(lastUserTurn?.content || "", 80),
            webFallbackReason: fb?.reason || "unknown",
          },
          result: { skipReason: think.skipReason, thinkRationale: think.rationale },
          createdAt: now,
        });
        return {
          ok: true,
          skipped: "ai_chose_skip",
          skipReason: think.skipReason,
          thinkRationale: think.rationale,
          webFallback: fb?.reason || null,
        };
      } catch (e) {
        // fallback 抛错也不阻塞主流程
        console.warn(`[proactive] web_topic fallback failed: ${e.message}`);
        insertBehaviorJournalEntry({
          runType: "next_push_schedule",
          assistantId,
          sessionId: profile.last_session_id || null,
          shouldPushMessage: false,
          status: "skipped",
          reason: "ai_chose_skip",
          input: { sinceLastUserMs, webFallbackError: e.message },
          result: { skipReason: think.skipReason, thinkRationale: think.rationale },
          createdAt: now,
        });
        return {
          ok: true,
          skipped: "ai_chose_skip",
          skipReason: think.skipReason,
          thinkRationale: think.rationale,
        };
      }
    }

    // ── agentic recall（think 与 compose 之间）──
    // think 觉得需要更具体的旧记忆来支撑 topicCandidate 时，会输出 recallQuery；
    // server 拿到非空 query 就再跑一次 retrieveMemory，结果替换 ctx.recallLines 喂给 compose。
    // 空 query → 保留原 ctx（lastUserTurn 锚定的初始召回）。
    let agenticRecallHits = 0;
    if (think.recallQuery && think.recallQuery.trim()) {
      try {
        const items = await retrieveMemory({
          assistantId,
          sessionId: profile.last_session_id || `persona:${assistantId}`,
          query: think.recallQuery,
          topK: 5,
        });
        agenticRecallHits = items.length;
        if (items.length > 0) {
          // 重渲染 recallLines —— 跟 _renderSharedContext 里同步格式（带相对时间 + type 标签）
          ctx.recallLines = items
            .slice(0, 5)
            .map((m) => {
              const ts = m.createdAt || m.created_at || 0;
              const type = m.memoryType || m.memory_type || "memory";
              return `- [${relativeTimeLabel(ts, now)}/${type}] ${clipText(m.content, 130)}`;
            })
            .join("\n");
        }
      } catch (e) {
        console.warn(`[proactive] agentic recall failed: ${e.message}`);
      }
    }

    // ── step 2: compose —— think 决定要发，现在写正文 ──
    const composePrompt = buildComposePrompt({ ctx, thinkOutput: think, nowIso });
    let composeRaw;
    try {
      const depthMaxTokens = think.depth === "deep" ? 550 : think.depth === "medium" ? 400 : 280;
      composeRaw = await callLlmForPlanDraft(composePrompt, {
        temperature: 0.75,           // 写正文阶段稍高温度保留语气多样
        maxTokens: depthMaxTokens,   // brief≈280字内 / medium≈400 / deep≈550（含 JSON 开销）
        assistantId,
      });
    } catch (e) {
      return { ok: false, skipped: "llm_unreachable", error: e.message, stage: "compose" };
    }
    const composed = normalizeComposeOutput(composeRaw, think.depth);

    if (!composed.body || composed.body.length < 2) {
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
              AND trigger_reason IN ('next_push', 'web_topic')
              AND created_at >= ?
            ORDER BY created_at DESC
            LIMIT 12`
        )
        .all(assistantId, now - 48 * 60 * 60 * 1000);
      const corpus = corpusRows.map((r) => r.draft_body || "").filter(Boolean);
      const score = maxJaccardAgainst(composed.body, corpus);
      if (score > 0.55) {
        insertBehaviorJournalEntry({
          runType: "next_push_schedule",
          assistantId,
          sessionId: profile.last_session_id || null,
          shouldPushMessage: false,
          status: "skipped",
          reason: "duplicate_against_recent_drafts",
          input: { sinceLastUserMs, jaccardScore: Number(score.toFixed(2)) },
          result: { draftBody: clipText(composed.body, 120), thinkRationale: think.rationale },
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

    // anchorTopic 去重：24h 内同一话题锚点已被使用过 → skip，强制换个角度。
    // findUsedAnchorTopicWithin 在 store.js 已存在，这里补调用。
    if (think.anchorTopic) {
      try {
        const usedAnchor = findUsedAnchorTopicWithin({
          assistantId,
          anchorTopic: think.anchorTopic,
          withinMs: 24 * 60 * 60 * 1000,
          now,
        });
        if (usedAnchor) {
          insertBehaviorJournalEntry({
            runType: "next_push_schedule",
            assistantId,
            sessionId: profile.last_session_id || null,
            shouldPushMessage: false,
            status: "skipped",
            reason: "anchor_topic_used_within_24h",
            input: { anchorTopic: think.anchorTopic, usedPlanId: usedAnchor.id },
            result: { draftBody: clipText(composed.body, 120) },
            createdAt: now,
          });
          return { ok: true, skipped: "anchor_topic_used_within_24h", anchorTopic: think.anchorTopic };
        }
      } catch (e) {
        console.warn(`[proactive] anchor_topic dedup failed: ${e.message}`);
      }
    }

    // 抖动：watchdog cron 在 :00/:30 fires，LLM 又稳定返回 1800000ms (=30min) 这种整数 delay，
    // 直接 now + delayMs 会让所有 next_push 都落在 :00 / :30 准点，观感像机器人定时发。
    // ±10min 均匀抖动后再 clamp 回 [MIN_DELAY, 72h 窗口]。
    const NEXT_PUSH_JITTER_BAND_MS = 10 * 60 * 1000;
    const jitter = Math.floor((Math.random() - 0.5) * 2 * NEXT_PUSH_JITTER_BAND_MS);
    let scheduledAt = now + think.delayMs + jitter;
    if (scheduledAt < now + NEXT_PUSH_MIN_DELAY_MS) {
      scheduledAt = now + NEXT_PUSH_MIN_DELAY_MS;
    }
    if (scheduledAt - lastUserAt > NEXT_PUSH_FRESHNESS_WINDOW_MS) {
      // delay 超出 72h 窗口边界 → 让 long-term 接管
      return { ok: false, skipped: "scheduled_beyond_72h_window" };
    }

    // rationale 拼成 "<think rationale> | mood=<...> | topic=<...>"，方便用户翻
    // proactive_plans 时直接看到 think step 的判断；500 字符上限由 clipText 兜底。
    const rationaleStored = clipText(
      [
        think.rationale || "",
        think.mood ? `mood=${think.mood}` : "",
        think.topicCandidate ? `topic=${think.topicCandidate}` : "",
      ].filter(Boolean).join(" | "),
      500
    );

    const planId = insertProactivePlan({
      assistantId,
      userId: userId || process.env.DEFAULT_USER_ID || "default-user",
      triggerReason: NEXT_PUSH_TRIGGER_REASON,
      intent: think.intent,
      // 命名约束：避免把 character_name 写进 draft_title，改名后会留旧名
      draftTitle: composed.title || "想说点什么",
      draftBody: composed.body,
      anchorTopic: think.anchorTopic,
      rationale: rationaleStored,
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
      messageIntent: think.intent,
      draftMessage: composed.body,
      input: {
        sinceLastUserMs,
        delayMs: think.delayMs,
        mood: think.mood,
        topicCandidate: think.topicCandidate,
        recallQuery: think.recallQuery || null,
      },
      result: {
        planId,
        anchorTopic: think.anchorTopic,
        scheduledAt,
        thinkRationale: think.rationale,
        agenticRecallHits,
      },
      createdAt: now,
    });

    return {
      ok: true,
      planId,
      scheduledAt,
      delayMs: think.delayMs,
      body: composed.body,
      mood: think.mood,
      topicCandidate: think.topicCandidate,
      agenticRecallHits,
    };
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
