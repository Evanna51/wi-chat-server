/**
 * characterContextBuilder — 把 7 层认知态聚合成一个 payload + 一段 promptFragment。
 *
 * 这是 Phase 1 的"behavior layer 雏形"：之前 client-side 从 /tool/memory-context
 * 拿一堆零碎数据自己拼 system prompt。现在 server 端集中拼好，client 拿到就用。
 *
 * 拼装顺序（影响 LLM 注意力）：
 *   1. identity （角色"是什么样的人"）
 *   2. character_state（实时情绪 + 关系等级 + 精力 + 压抑情绪）
 *   3. relationship dynamics（多维关系动力学的自然语言体感）
 *
 * 结构化字段供未来需要 fine-grained 控制的 client 使用，
 * promptFragment 是一段拼好的文本，懒一点的 client 直接塞 system prompt。
 *
 * Token 预算：promptFragment 总长不超过 ~512 tokens（中文 ~800 字）。
 * 超出就 truncate 末尾的 dynamics narrative。
 */

const { getAssistantProfile } = require("../../db");
const {
  getCharacterIdentity,
  buildIdentityPromptFragment,
} = require("./identityService");
const {
  getEffectiveState,
  buildStatePromptFragment,
  ensureDefaultState,
} = require("../characterStateService");
const { buildRelationshipStatePayload } = require("../relationshipStateView");
const {
  getRelationshipState,
  buildRelationshipFragment,
} = require("./relationshipDynamicsService");
const { chooseSocialMode } = require("./socialModes");
// T-CC2-06: 注入长期话题 + 重要 episode
const {
  listActiveTopics,
  buildTopicsPromptFragment,
} = require("./persistentTopicService");
const { listEpisodes } = require("./episodeBuilder");
// T-CC3-04: 注入 reflection summary
const {
  getLatestReflection,
  buildReflectionPromptFragment,
} = require("./reflectionService");
const { resolveEmotion } = require("../emotionTaxonomy");

// T-CC3-04: reflection 段加进来后，预算 1200 → 1500。reflection summary 约 100-200 字。
const MAX_FRAGMENT_LEN_CHARS = 1500;
const RECENT_EPISODES_DAYS = 30;
const RECENT_EPISODES_LIMIT = 3;
const RECENT_EPISODES_MIN_IMPORTANCE = 0.5;
const ACTIVE_TOPICS_LIMIT = 5;
// reflection 7d 内的不算太陈旧；超过则不注入（避免老反思误导 LLM）
const REFLECTION_FRESHNESS_DAYS = 14;

/**
 * 主入口：返回完整的 character context payload。
 *
 * @param {string} assistantId
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {boolean} [opts.includePromptFragment] - 默认 true
 */
function buildCharacterContext(assistantId, { now = Date.now(), includePromptFragment = true } = {}) {
  // assistant_profile 必须存在；不存在直接返 null（caller 决定怎么处理）
  const profile = getAssistantProfile(assistantId);
  if (!profile) return null;

  // 自动 ensure character_state（保持和 /relationship/state 路径一致）
  ensureDefaultState(assistantId);

  const identity = getCharacterIdentity(assistantId); // 可能为 null，client 端处理
  const characterState = getEffectiveState(assistantId, now);
  const relationshipPayload = buildRelationshipStatePayload(assistantId, { now });
  const dynamicsState = getRelationshipState(assistantId, now);

  const identityPayload = identity ? toIdentityPayload(identity, profile) : profileFallback(profile);
  const dynamicsPayload = dynamicsState ? toDynamicsPayload(dynamicsState) : null;
  const emotionPayload = toEmotionPayload(characterState);

  // T-CC-09: 选当前社交姿态
  const socialMode = chooseSocialMode({
    identity,
    characterState,
    dynamics: dynamicsState,
    emotion: emotionPayload,
  });

  // T-CC2-06: 拉长期话题 + 重要 episode（30d 内 importance ≥ 0.5）
  const activeTopics = listActiveTopics(assistantId, { limit: ACTIVE_TOPICS_LIMIT });
  const recentEpisodes = listEpisodes(assistantId, {
    limit: RECENT_EPISODES_LIMIT,
    minImportance: RECENT_EPISODES_MIN_IMPORTANCE,
  }).filter((e) => e.timeRangeEnd >= now - RECENT_EPISODES_DAYS * 24 * 3600 * 1000);

  // T-CC3-04: 拉最新 reflection（14d 内才算新鲜，老的不注入）
  const latestReflection = getLatestReflection(assistantId);
  const freshReflection =
    latestReflection && now - latestReflection.createdAt < REFLECTION_FRESHNESS_DAYS * 24 * 3600 * 1000
      ? latestReflection
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
  };

  if (includePromptFragment) {
    result.promptFragment = buildPromptFragment({
      identity,
      profile,
      characterState,
      now,
      socialModeFragment: socialMode.promptFragment,
      topicsFragment: buildTopicsPromptFragment(assistantId, { limit: ACTIVE_TOPICS_LIMIT, now }),
      episodesFragment: buildEpisodesPromptFragment(recentEpisodes),
      reflectionFragment: freshReflection ? buildReflectionPromptFragment(assistantId) : "",
    });
  }

  return result;
}

// T-CC2-06: episodes prompt fragment
function buildEpisodesPromptFragment(episodes) {
  if (!episodes || !episodes.length) return "";
  const lines = ["[最近的重要叙事]"];
  for (const e of episodes) {
    const summary = e.summary.length > 80 ? e.summary.slice(0, 78) + "…" : e.summary;
    lines.push(`- ${e.title}（${e.emotionalTone}）：${summary}`);
    if (e.unresolvedThreads && e.unresolvedThreads.length) {
      lines.push(`  尚未化解：${e.unresolvedThreads.slice(0, 2).join("；")}`);
    }
  }
  return lines.join("\n");
}

// ── payload 拍平 ─────────────────────────────────────────────────────

function toIdentityPayload(identity, profile) {
  return {
    characterName: profile.character_name,
    characterBackground: profile.character_background || "",
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
  };
}

/**
 * 没 identity 行的 fallback：用 assistant_profile 的裸字段拼一个最小 payload，
 * 保证 client 永远拿得到一致的 schema。
 */
function profileFallback(profile) {
  return {
    characterName: profile.character_name,
    characterBackground: profile.character_background || "",
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

// ── prompt 拼装 ─────────────────────────────────────────────────────

function buildPromptFragment({
  identity, profile, characterState, now,
  socialModeFragment, topicsFragment, episodesFragment, reflectionFragment,
}) {
  const parts = [];

  // 段排序按"被砍优先级倒序"：越靠后越早被丢。
  // header → identity（不变层，最稳定，最该保留）
  // → state（实时态）
  // → dynamics（中期叙事）
  // → episodes（长期叙事）  ← Phase 2 新加
  // → topics（长期话题）   ← Phase 2 新加
  // → socialMode（最易重算，超长时先丢）

  // Header
  const header = [];
  header.push(`你是角色"${profile.character_name}"。`);
  if (profile.character_background) {
    header.push(profile.character_background);
  }
  parts.push(header.join("\n"));

  if (identity) {
    const id = buildIdentityPromptFragment(identity);
    if (id) parts.push(id);
  }

  const stateFragment = buildStatePromptFragment(profile.assistant_id, now);
  if (stateFragment) parts.push(stateFragment);

  const dynFragment = buildRelationshipFragment(profile.assistant_id, now);
  if (dynFragment) parts.push(dynFragment);

  // T-CC3-04: reflection 段排在 dynamics 之后，长期叙事之前
  // —— reflection 是 AI 的"上层视角"，比具体 episode 更重要，但稳定度低于 identity/state
  if (reflectionFragment) parts.push(reflectionFragment);

  // T-CC2-06：长期叙事 + 长期话题
  if (episodesFragment) parts.push(episodesFragment);
  if (topicsFragment) parts.push(topicsFragment);

  // T-CC-09: 当前社交姿态（最易重算，最先被砍）
  if (socialModeFragment) parts.push(socialModeFragment);

  // Phase 1 review P1: 按段丢弃，不切中文/emoji 中间。
  // 段优先级（保留度从高到低）：header → identity → state → dynamics → socialMode
  // 超过预算时从尾部 pop（最易重算的先掉），仍超才做防御性 char-slice。
  let combined = parts.join("\n\n");
  while (combined.length > MAX_FRAGMENT_LEN_CHARS && parts.length > 1) {
    parts.pop();
    combined = parts.join("\n\n");
  }
  if (combined.length > MAX_FRAGMENT_LEN_CHARS) {
    // 仅 header 还超长（用户写了超长 character_background）—— 兜底硬切
    combined = combined.slice(0, MAX_FRAGMENT_LEN_CHARS - 3) + "...";
  }
  return combined;
}

// ── helpers ─────────────────────────────────────────────────────────

function round3(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return v;
  return Math.round(v * 1000) / 1000;
}

module.exports = {
  buildCharacterContext,
  MAX_FRAGMENT_LEN_CHARS,
};
