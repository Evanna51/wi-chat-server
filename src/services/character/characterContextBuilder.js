/**
 * characterContextBuilder — 把 7 层认知态聚合成 payload + 拆 system/userPrefix 双段。
 *
 * CC-5.C 重写：
 *   * 旧版 1500 字单段 promptFragment（描述句堆叠）→ 新版 system + userPrefix 双段。
 *   * system 段：稳定 / 可缓存 / XML envelope 结构化（identity + voice anchor，英文）。
 *   * userPrefix 段：每条消息变 / 第一人称片段化独白（mood + dynamics 异常维度 +
 *     salient phrase + 1 条 unresolved episode/topic）。
 *   * 删除：socialMode prompt 段（让 LLM 从 trait + state 自挑姿态）；
 *           独立 reflection / episodes / topics 段（融进 userPrefix 独白）。
 *   * 预算：system 2500 / userPrefix 1000 / 合计 3500（旧 1500，复杂度涨了所以扩）。
 *
 * 去重（深度优化）：
 *   * `promptFragment` 字段（= system + "\n\n" + userPrefix）默认 **不** 返回，
 *     需 caller 显式 includePromptFragment=true 才得到。新客户端用 system + userPrefix
 *     双段；旧客户端继续传 includePromptFragment=true 兼容。
 *   * 删除 identity.characterBackground —— 这个字段无任何 consumer 在读，
 *     character_background 已经渲染进 system 段；要原始结构化形态走 /api/browse/assistants。
 *   * 结果：默认响应里 character_background 只出现 1 次（system 内），不再 3 次冗余。
 *
 * 视角原则：prompt 是写给角色 "自己" 的内心，不是写给 "读者" 的角色介绍。
 *   ✗ "ta 现在感到不安，trust 0.45"   ← 第三人称描述
 *   ✓ "我有点不安。trust 没那么稳了。"  ← 第一人称独白
 * LLM 读到第一人称片段会**接续**它，第三人称描述会**总结**它。这是为什么
 * 旧版 LLM 输出像 AI 助手 —— prompt 视角错了。
 */

const { getAssistantProfile } = require("../../db");
const {
  getCharacterIdentity,
  buildIdentityPromptFragment,
} = require("./identityService");
const {
  getEffectiveState,
  ensureDefaultState,
} = require("../characterStateService");
const { buildRelationshipStatePayload } = require("../relationshipStateView");
const { getRelationshipState } = require("./relationshipDynamicsService");
const { chooseSocialMode } = require("./socialModes");
const { listActiveTopics } = require("./persistentTopicService");
const { listEpisodes } = require("./episodeBuilder");
const { getLatestReflection } = require("./reflectionService");
const { resolveEmotion } = require("../emotionTaxonomy");
const { detectSalientPhrase } = require("./salientPhraseDetector");
const { parsePronouns } = require("./identityVocab");
const { composeForChatV3Default } = require("./promptComposer");

// ── 预算 ─────────────────────────────────────────────────────────────
//
// 旧 1500 字总预算在 7 层全部接入后已经常态被砍。CC-5 拆段后 cacheable system
// 可以放更长，hot path userPrefix 也放宽 —— 独白 lines 各自有 per-line cap，
// 自然不会爆，硬切反而切掉关键内心活动。把 USER_PREFIX 当 soft target，超了 warn 不切。
const SYSTEM_BUDGET_CHARS = 2500;
const USER_PREFIX_BUDGET_CHARS = 2000; // soft target（warn-not-cut），1000 → 2000
const MAX_FRAGMENT_LEN_CHARS = SYSTEM_BUDGET_CHARS + USER_PREFIX_BUDGET_CHARS; // 4500

// ── 选材范围 ─────────────────────────────────────────────────────────
const RECENT_EPISODES_DAYS = 30;
const RECENT_EPISODES_LIMIT = 3;          // payload 里返回 3 条；userPrefix 独白只取 1 条
const RECENT_EPISODES_MIN_IMPORTANCE = 0.5;
const ACTIVE_TOPICS_LIMIT = 5;            // payload 里返回 5；userPrefix 只取 1 条 unresolved
const REFLECTION_FRESHNESS_DAYS = 14;
const UNRESOLVED_TOPIC_STALE_DAYS = 7;    // status='unresolved' 且 >7d 未提才放进独白

// ── prompt 文案动态渲染 ──────────────────────────────────────────────
//
// Voice anchor 用英文 —— LLM 对英文 negative/framing instruction 响应更稳。
// "speak as <obj>, not about <obj>" 精准锚定要修的 bug：第三人称描述 / 总结 / 解释。
// 不写 "不要 X" 列表 —— 那种绝对禁令对 caretaker / philosopher 类角色伤害更大。
//
// 代词从 identity.pronouns 派生（she/her / he/him / they/them 三个 preset，
// 默认空 → fallback "they/them"）。男性 / non-binary 角色不会再被错称。

function renderRoleDirective(pronouns) {
  const obj = pronouns.object;
  return `You are ${obj}. Speak as ${obj}, not about ${obj}.`;
}

const SUBJECT_CONTRACTIONS = {
  she: "She's",
  he: "He's",
  they: "They're",
};

function renderVoiceAnchor(pronouns) {
  const { subject, possessive } = pronouns;
  const subjContr = SUBJECT_CONTRACTIONS[subject] || `${capitalize(subject)} is`;
  return (
    `${subjContr} mid-conversation, not on stage. Fragments, silences, and contradictions are natural.\n` +
    `Use ${possessive} skills the way ${subject} would.`
  );
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// 向后兼容导出（默认 "they" 形态，之前测试 / 调用方依赖的常量字面值）
const ROLE_DIRECTIVE = renderRoleDirective(parsePronouns(""));
const VOICE_ANCHOR = renderVoiceAnchor(parsePronouns(""));

// ── dynamics 异常维度 → 第一人称片段 模板 ─────────────────────────────
//
// 每个维度定义"远离 neutral 的方向"和"该方向触发的独白片段"。
// pickDynamicsAnomalies 按 severity（偏离量）排序，独白只取 top-1。
//
// 模板都是片段化、第一人称、不解释 —— 这是 voice 层的关键。
const DYNAMICS_FRAGMENT_TEMPLATES = Object.freeze([
  // good 方向：高 = 健康
  { key: "trust",                neutral: 0.5, dir: "high", threshold: 0.15, lowFrag:  "trust 没那么稳了。" },
  { key: "emotional_safety",     neutral: 0.5, dir: "high", threshold: 0.15, lowFrag:  "感觉不太安全。" },
  { key: "emotional_closeness",  neutral: 0.5, dir: "high", threshold: 0.2,  lowFrag:  "感觉离 ta 远了。" },
  { key: "gratitude",            neutral: 0,   dir: "high", threshold: 0.5,  highFrag: "心里有点暖。" },
  { key: "attachment",           neutral: 0,   dir: "high", threshold: 0.6,  highFrag: "这两天特别想 ta。" },

  // good 方向：低 = 健康
  { key: "abandonment_fear",     neutral: 0,   dir: "low",  threshold: 0.4,  highFrag: "心里空了一块。" },
  { key: "unresolved_conflict",  neutral: 0,   dir: "low",  threshold: 0.4,  highFrag: "上次的事还没真过去。" },
  { key: "resentment",           neutral: 0,   dir: "low",  threshold: 0.3,  highFrag: "心里有点堵。" },
  { key: "tension",              neutral: 0,   dir: "low",  threshold: 0.4,  highFrag: "气氛有点紧。" },
  { key: "social_distance",      neutral: 0,   dir: "low",  threshold: 0.5,  highFrag: "我想自己待一会。" },
]);

/**
 * 主入口：返回 7 层认知态 payload + V_NEW_LEAN slots + assistantPrefill。
 *
 * Phase 2 cleanup：移除旧 `system` / `userPrefix` / `promptFragment` 字段（V_NEW_LEAN
 * 落地后 chat path 走 slots；旧字段无 caller，无 dev 客户端兼容包袱）。
 *
 * @param {string} assistantId
 * @param {object} [opts]
 * @param {number}  [opts.now]
 * @param {string}  [opts.lastUserMessage]          可选；传了就跑 salient phrase detection
 *                                                  并在 prefill 独白开篇插一行
 */
function buildCharacterContext(assistantId, {
  now = Date.now(),
  lastUserMessage,
} = {}) {
  const profile = getAssistantProfile(assistantId);
  if (!profile) return null;

  ensureDefaultState(assistantId);

  const identity = getCharacterIdentity(assistantId);
  const characterState = getEffectiveState(assistantId, now);
  const relationshipPayload = buildRelationshipStatePayload(assistantId, { now });
  const dynamicsState = getRelationshipState(assistantId, now);

  const identityPayload = identity ? toIdentityPayload(identity, profile) : profileFallback(profile);
  const dynamicsPayload = dynamicsState ? toDynamicsPayload(dynamicsState) : null;
  const emotionPayload = toEmotionPayload(characterState);

  // socialMode 仍然算（payload 暴露给 client 用作显示），但**不再进 prompt** ——
  // LLM 自己从 trait + state 推姿态。
  const socialMode = chooseSocialMode({
    identity,
    characterState,
    dynamics: dynamicsState,
    emotion: emotionPayload,
  });

  const activeTopics = listActiveTopics(assistantId, { limit: ACTIVE_TOPICS_LIMIT });
  const recentEpisodes = listEpisodes(assistantId, {
    limit: RECENT_EPISODES_LIMIT,
    minImportance: RECENT_EPISODES_MIN_IMPORTANCE,
  }).filter((e) => e.timeRangeEnd >= now - RECENT_EPISODES_DAYS * 24 * 3600 * 1000);

  const latestReflection = getLatestReflection(assistantId);
  const freshReflection =
    latestReflection && now - latestReflection.createdAt < REFLECTION_FRESHNESS_DAYS * 24 * 3600 * 1000
      ? latestReflection
      : null;

  // CC-5.D：选择性注意 —— 仅 caller 显式传 lastUserMessage 时才扫
  const salientPhrase = lastUserMessage
    ? detectSalientPhrase(lastUserMessage, identity)
    : null;

  const result = {
    assistantId,
    ts: now,
    identity: identityPayload,
    characterState: relationshipPayload,
    emotion: emotionPayload,
    relationshipDynamics: dynamicsPayload,
    socialMode: {
      primary: socialMode.primary,
      secondary: socialMode.secondary,
      scores: socialMode.scores,
    },
    activeTopics,
    recentEpisodes,
    latestReflection: freshReflection,
    salientPhrase,
  };

  // 角色独白片段（mood + dynamics 异常 + salient phrase + reflection 等 7 项压缩）。
  // 客户端把它放到 system prompt 末尾作 [此刻] 段，给 LLM 锚定"角色当下视角"。
  const assistantPrefill = buildUserMonologue({
    characterState,
    dynamicsState,
    now,
    salientPhrase,
    recentEpisodes,
    activeTopics,
    freshReflection,
  });
  result.assistantPrefill = assistantPrefill;

  // 2026-05-10: 改用 V3 default 渲染，输出 schema 跟 chat hot path 一致
  // （含 <voice_skills> / <attention_1h>(空) / <avoid>），让 admin / boot cache 客户端
  // 拿到的 fallback prompt 跟 hot path 同结构。chat path 仍走 composeForChatV3 + router
  // 不受影响。
  const composed = composeForChatV3Default({
    profile,
    identity,
    coreFacts: [],
    retrievedMemories: [],
    recentReflection: freshReflection,
    activeEpisodes: recentEpisodes,
    activeTopics,
    salientPhrase,
    prefill: assistantPrefill,
  });
  result.slots = composed.slots;
  result.mergedSystem = composed.mergedSystem;

  return result;
}

// ── system 段（XML envelope，cacheable） ──────────────────────────────

/**
 * system 段：稳定 / 可缓存 / 通过 XML 标签分段。
 * 内容只放角色"是什么样的人"——人格、价值、招式、不变事实。
 * 不放 mood / dynamics 数值（那些每条消息变，破缓存）。
 */
function buildSystemSegment({ identity, profile }) {
  const parts = [];

  // 从 identity 派生人称代词（she/her / he/him / they/them / 自定义 / 空 fallback they）
  const pronouns = parsePronouns(identity ? identity.pronouns : "");

  // <role> ... 动态用对应 object 代词（避免 "Speak as her" 错用在男性 / non-binary 角色）
  parts.push(`<role>\n${renderRoleDirective(pronouns)}\n</role>`);

  // <character> ...
  const characterLines = [];
  if (profile.character_background) {
    characterLines.push(profile.character_background);
    characterLines.push(""); // 空行隔开
  }

  if (identity) {
    const idFrag = buildIdentityPromptFragment(identity);
    if (idFrag) characterLines.push(idFrag);
  } else {
    // profile fallback：只渲染最少信息
    if (profile.character_name) {
      characterLines.push(`[角色人格]\n姓名：${profile.character_name}`);
    }
  }

  parts.push(`<character>\n${characterLines.join("\n")}\n</character>`);

  // <voice> ... 主格 + 物主格也要跟着 pronouns 动态走
  parts.push(`<voice>\n${renderVoiceAnchor(pronouns)}\n</voice>`);

  let combined = parts.join("\n\n");

  // 超预算时优先砍 character_background（用户写的，可能很长）
  // —— 不砍 role / voice，那两段都很短且 critical
  if (combined.length > SYSTEM_BUDGET_CHARS) {
    combined = truncateCharacterSection(parts, SYSTEM_BUDGET_CHARS);
  }
  return combined;
}

/**
 * 兜底硬切：保留 <role> / <voice>，砍 <character> 内容。
 * 仅当用户写了超长 character_background 触发。
 */
function truncateCharacterSection(parts, budget) {
  // parts[0] = <role>...</role>
  // parts[1] = <character>...</character>
  // parts[2] = <voice>...</voice>
  const role = parts[0];
  const voice = parts[2];
  const charSeg = parts[1];

  const overhead = role.length + voice.length + 4; // 两个 \n\n
  const charBudget = Math.max(200, budget - overhead);

  let truncated = charSeg;
  if (truncated.length > charBudget) {
    // 保留 <character> 标签结构
    const innerStart = "<character>\n".length;
    const innerEnd = "\n</character>".length;
    const inner = truncated.slice(innerStart, truncated.length - innerEnd);
    const innerBudget = charBudget - innerStart - innerEnd - 3; // "..."
    truncated = `<character>\n${inner.slice(0, innerBudget)}...\n</character>`;
  }
  return [role, truncated, voice].join("\n\n");
}

// ── userPrefix 段（独白，per-message） ────────────────────────────────

/**
 * userPrefix 段：第一人称片段独白。
 *
 * 渲染顺序（从最 prominent 到最背景）：
 *   1. salient phrase（如有）—— 用户原话里被勾住的词，放最前
 *   2. mood 一行 —— 当下情绪片段
 *   3. dynamics 异常 top-1 —— 关系最异常的一维
 *   4. suppressed emotion（如有强度 > 0.3）—— 压抑情绪的提示
 *   5. unresolved episode 1 条（如有）—— "还在想..."
 *   6. unresolved + stale topic 1 条（如有）—— "那件事好久没提"
 *   7. reflection（如新鲜）—— "最近觉得..."
 */
function buildUserMonologue({
  characterState,
  dynamicsState,
  now,
  salientPhrase,
  recentEpisodes,
  activeTopics,
  freshReflection,
}) {
  const lines = [];

  // 1. salient phrase
  if (salientPhrase && salientPhrase.monologueLine) {
    lines.push(salientPhrase.monologueLine);
  }

  // 2. mood
  const moodFrag = renderMoodFragment(characterState);
  if (moodFrag) lines.push(moodFrag);

  // 3. dynamics top-1 anomaly
  if (dynamicsState) {
    const anomalies = pickDynamicsAnomalies(dynamicsState);
    if (anomalies.length > 0) lines.push(anomalies[0].fragment);
  }

  // 4. suppressed emotion
  if (characterState && characterState.suppressed_emotion && (characterState.suppressed_emotion_intensity ?? 0) > 0.3) {
    const sup = resolveEmotion(characterState.suppressed_emotion);
    lines.push(`心底压着 ${sup.zh}，没说出来。`);
  }

  // 5. unresolved episode
  const unresolvedEpisode = (recentEpisodes || []).find(
    (e) => e.unresolvedThreads && e.unresolvedThreads.length > 0
  );
  if (unresolvedEpisode) {
    const thread = unresolvedEpisode.unresolvedThreads[0];
    // per-line cap 28 → 80：内心独白的"还在想..."值得稍长一点
    const truncatedThread = thread.length > 80 ? thread.slice(0, 78) + "…" : thread;
    lines.push(`还在想：${truncatedThread}`);
  }

  // 6. unresolved + stale topic（topic 的字段叫 lastDiscussedAt）
  const staleTopic = (activeTopics || []).find((t) => {
    if (t.status !== "unresolved") return false;
    const daysSinceLastMention = (now - (t.lastDiscussedAt || 0)) / (24 * 3600 * 1000);
    return daysSinceLastMention >= UNRESOLVED_TOPIC_STALE_DAYS;
  });
  if (staleTopic) {
    lines.push(`「${staleTopic.topic}」那件事好久没提了。`);
  }

  // 7. fresh reflection（AI 自己对关系的反思视角，值得多放点空间）
  if (freshReflection && freshReflection.summary) {
    // per-line cap 80 → 240：reflection 是"AI 的视角史"，太短就成废话
    const sum = freshReflection.summary.length > 240
      ? freshReflection.summary.slice(0, 238) + "…"
      : freshReflection.summary;
    lines.push(`最近觉得：${sum}`);
  }

  if (lines.length === 0) {
    // 完全没异常态 —— 不输出独白，让 LLM 直接用 system 角色信息回
    return "";
  }

  const combined = `[此刻]\n${lines.join("\n")}`;
  // 不再在这里硬切独白 —— 每行都有自己的 per-line cap（reflection 240 / episode 80
  // / topic 短文本 / mood + dynamics 都是固定模板）。爆 budget 只能是真出问题的边缘
  // 情况；这种情况下宁可 warn + 全量返回，也不切坏内心活动的关键句。
  // soft target 用于 monitoring，不强切。
  if (combined.length > USER_PREFIX_BUDGET_CHARS) {
    console.warn(
      `[characterContext] userPrefix unusually long: ${combined.length} chars ` +
      `(soft target ${USER_PREFIX_BUDGET_CHARS}). 不切 —— 检查是否 per-line cap 失效。`
    );
  }
  return combined;
}

function renderMoodFragment(state) {
  if (!state) return null;
  const intensity = state.mood_intensity ?? 0;
  if (intensity < 0.3) return null; // 不显著情绪不显式提，让 LLM 自然回

  const valence = state.mood_valence ?? 0;
  const arousal = state.mood_arousal ?? 0;
  const moodId = state.mood_emotion;

  // 优先：用具体 emotion id 派生（更准）
  if (moodId && moodId !== "neutral") {
    const resolved = resolveEmotion(moodId);
    if (resolved && resolved.zh) {
      return `心里有点${resolved.zh}。`;
    }
  }

  // 兜底：valence × arousal 四象限
  if (valence < -0.3 && arousal > 0.5) return "心里有点紧。";
  if (valence < -0.3 && arousal < 0.3) return "心里闷闷的。";
  if (valence > 0.3 && arousal > 0.5) return "心里有点雀跃。";
  if (valence > 0.3 && arousal < 0.3) return "心里挺安定的。";
  if (valence < -0.3) return "心里不太对劲。";
  return null;
}

/**
 * 找 dynamics 12 维里偏离 neutral 最远的几个。
 * 只返回有对应 fragment 模板的维度（DYNAMICS_FRAGMENT_TEMPLATES 没覆盖的维度跳过）。
 *
 * @returns {Array<{ key, value, severity, fragment }>} 按 severity 降序
 */
function pickDynamicsAnomalies(state) {
  const scored = [];
  for (const tmpl of DYNAMICS_FRAGMENT_TEMPLATES) {
    const v = state[tmpl.key];
    if (typeof v !== "number") continue;

    if (tmpl.dir === "high") {
      // 健康向是高，异常是低
      const deficit = tmpl.neutral - v;
      if (deficit >= tmpl.threshold && tmpl.lowFrag) {
        scored.push({ key: tmpl.key, value: v, severity: deficit, fragment: tmpl.lowFrag });
      }
    } else {
      // 健康向是低，异常是高
      const excess = v - tmpl.neutral;
      if (excess >= tmpl.threshold && tmpl.highFrag) {
        scored.push({ key: tmpl.key, value: v, severity: excess, fragment: tmpl.highFrag });
      }
    }
  }
  scored.sort((a, b) => b.severity - a.severity);
  return scored;
}

// ── 拼装：system + userPrefix → combined ─────────────────────────────

function buildPromptSegments(args) {
  const system = buildSystemSegment(args);
  const userPrefix = buildUserMonologue(args);
  const combined = userPrefix ? `${system}\n\n${userPrefix}` : system;

  return { system, userPrefix, combined };
}

// ── payload 拍平（沿用原版） ─────────────────────────────────────────

// CC-5 dedup: characterBackground 不再放进 identity payload —— 它已经渲染进 system 段，
// 也能从 /api/browse/assistants 拿到原始 string，再返回一次纯属冗余。
function toIdentityPayload(identity, profile) {
  return {
    characterName: profile.character_name,
    identityId: identity.identityId,
    identityVersion: identity.identityVersion,
    speakingStyle: identity.speakingStyle,
    worldview: identity.worldview,
    personalityTraits: identity.personalityTraits,
    attachmentStyle: identity.attachmentStyle,
    emotionalSensitivity: identity.emotionalSensitivity,
    empathyLevel: identity.empathyLevel,
    expressiveness: identity.expressiveness,
    socialStrategyDefault: identity.socialStrategyDefault,
    values: identity.values,
    hardBoundaries: identity.hardBoundaries,
    softBoundaries: identity.softBoundaries,
    avoidanceTopics: identity.avoidanceTopics,
    triggeringTopics: identity.triggeringTopics,
    insecurities: identity.insecurities,
    coreWounds: identity.coreWounds,
    desires: identity.desires,
    careLanguages: identity.careLanguages,
    tensions: identity.tensions,
    skills: identity.skills || [],
    pronouns: identity.pronouns || "",
  };
}

function profileFallback(profile) {
  return {
    characterName: profile.character_name,
    identityId: null,
    identityVersion: 0,
    speakingStyle: "",
    worldview: "",
    personalityTraits: [],
    attachmentStyle: null,
    emotionalSensitivity: 0.5,
    empathyLevel: 0.5,
    expressiveness: 0.5,
    socialStrategyDefault: null,
    values: [],
    hardBoundaries: [],
    softBoundaries: [],
    avoidanceTopics: [],
    triggeringTopics: [],
    insecurities: [],
    coreWounds: [],
    desires: [],
    careLanguages: { give: [], receive: [] },
    tensions: {},
    skills: [],
    pronouns: "",
  };
}

function toDynamicsPayload(state) {
  return {
    trust: round3(state.trust),
    dependency: round3(state.dependency),
    emotionalSafety: round3(state.emotional_safety),
    attachment: round3(state.attachment),
    tension: round3(state.tension),
    unresolvedConflict: round3(state.unresolved_conflict),
    abandonmentFear: round3(state.abandonment_fear),
    reciprocityBalance: round3(state.reciprocity_balance),
    emotionalCloseness: round3(state.emotional_closeness),
    socialDistance: round3(state.social_distance),
    resentment: round3(state.resentment),
    gratitude: round3(state.gratitude),
    timestamps: {
      lastTrustEventAt: state.last_trust_event_at || null,
      lastConflictAt: state.last_conflict_at || null,
      lastReassuranceAt: state.last_reassurance_at || null,
      lastVulnerableShareAt: state.last_vulnerable_share_at || null,
      lastReciprocatedCareAt: state.last_reciprocated_care_at || null,
      lastDistancingSignalAt: state.last_distancing_signal_at || null,
    },
  };
}

function toEmotionPayload(state) {
  if (!state) return null;
  const cur = resolveEmotion(state.mood_emotion || "neutral");
  const suppressed = state.suppressed_emotion
    ? {
        id: state.suppressed_emotion,
        zh: resolveEmotion(state.suppressed_emotion).zh,
        en: resolveEmotion(state.suppressed_emotion).en,
        intensity: round3(state.suppressed_emotion_intensity || 0),
        updatedAt: state.suppressed_emotion_updated_at || null,
      }
    : null;
  return {
    current: {
      id: state.mood_emotion || "neutral",
      zh: cur.zh,
      en: cur.en,
      intensity: round3(state.mood_intensity ?? 0),
      valence: round3(state.mood_valence ?? 0),
      arousal: round3(state.mood_arousal ?? 0),
      updatedAt: state.mood_updated_at || null,
    },
    suppressed,
    unresolvedTopic: state.unresolved_emotion_topic || null,
    trend24h: round3(state.mood_trend_24h ?? 0),
  };
}

function round3(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return v;
  return Math.round(v * 1000) / 1000;
}

module.exports = {
  buildCharacterContext,
  // 暴露给测试 / 调试
  buildSystemSegment,
  buildUserMonologue,
  pickDynamicsAnomalies,
  renderMoodFragment,
  renderRoleDirective,
  renderVoiceAnchor,
  // 常量
  SYSTEM_BUDGET_CHARS,
  USER_PREFIX_BUDGET_CHARS,
  MAX_FRAGMENT_LEN_CHARS,
  ROLE_DIRECTIVE,
  VOICE_ANCHOR,
};
