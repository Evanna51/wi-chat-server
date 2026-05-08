const { db } = require("../db");
const { resolveEmotion, EMOTION_MAP } = require("./emotionTaxonomy");
// T-CC-05: identity-aware 系数 + dynamics 多维事件接入。
// require 这两个不会触发任何写入；getCharacterIdentity 没行就返回 null，
// getIdentityCoefficients(null) 返回 DEFAULT_COEFFICIENTS（全 1.0），等价老行为。
const {
  getCharacterIdentity,
  getIdentityCoefficients,
  DEFAULT_COEFFICIENTS,
} = require("./character/identityService");
const {
  classifyRelationshipEvent,
  applyRelationshipEvent,
} = require("./character/relationshipDynamicsService");
// T-CC2-04: 长期话题命中即更新 mention（hot path 不创建新 topic，那由 episodeBuilder 做）
const {
  findTopicMatchesInMessage,
  recordMention,
} = require("./character/persistentTopicService");
// T-CC3-03: 事件触发 reflection（异步，不阻塞）
const { maybeTriggerEventReflection } = require("./character/reflectionService");

// ── Constants ────────────────────────────────────────────────────────────────

const MOOD_HALF_LIFE_MS = 6 * 60 * 60 * 1000;       // 6h
const ENERGY_RECOVERY_HALF_LIFE_MS = 8 * 60 * 60 * 1000;
const BASELINE_VALENCE = 0.1;
const BASELINE_AROUSAL = 0.2;
const BASELINE_ENERGY  = 0.7;

// T-CC-04: 压抑情绪比明面情绪衰减慢 4 倍。
// 表面 mood 6h 半衰期 → 压在底下的 sad / hurt 24h 半衰期。
// 这是"嘴上笑了但底下还在难过"语义所必需。
const SUPPRESSED_EMOTION_HALF_LIFE_MS = 24 * 60 * 60 * 1000;

// T-CC-04: mood trend EMA 平滑系数。每条消息把 30% 当前 valence 混进 trend，
// 70% 保留旧值 → ~3 条消息收敛一半，实质等同"最近 6-10 条对话整体心情"。
const MOOD_TREND_EMA_ALPHA = 0.3;

// T-CC-04: 触发情绪压抑的阈值。
//   要求旧 mood 强度 ≥ 0.5（弱情绪不值得压抑），
//   且新旧 valence 反转幅度 ≥ 0.4（比如从 -0.3 跳到 +0.4）
const SUPPRESSION_TRIGGER_INTENSITY = 0.5;
const SUPPRESSION_TRIGGER_VALENCE_FLIP = 0.4;
// 压抑后保留 60% 强度 —— 不会完全消失，但也不能跟原来一样强
const SUPPRESSION_RETAIN_RATIO = 0.6;

const MAX_INTIMACY_DELTA_PER_MSG = 1.5;
const MAX_SINGLE_INTENSITY_DELTA = 0.3;

const SILENCE_LEVEL1_MS = 2  * 24 * 60 * 60 * 1000;  // 2d  → mild lonely
const SILENCE_LEVEL2_MS = 7  * 24 * 60 * 60 * 1000;  // 7d  → relationship decay
const SILENCE_LEVEL3_MS = 30 * 24 * 60 * 60 * 1000;  // 30d → soft reset

const LEVEL_THRESHOLDS = [0, 5, 12, 22, 35, 52, 72, 96, 124, 156]; // level 0-9

const RELATIONSHIP_NAMES = {
  "-2": "冷战",
  "-1": "疏远",
  0:  "陌生人",
  1:  "初识",
  2:  "熟人",
  3:  "普通朋友",
  4:  "朋友",
  5:  "好朋友",
  6:  "密友",
  7:  "挚友",
  8:  "知己",
  9:  "灵魂伴侣",
};

// ── Heuristic signal regexes ─────────────────────────────────────────────────

const POSITIVE_SIGNALS = [
  /谢谢|感谢|太好了|真的|好开心|好高兴|好棒|太棒了|厉害|成功|做到了|赢了|awesome|thanks|love|❤|♥|😊|🥰|😍/,
  /分享|告诉你|说个秘密|只有你知道/,
  /好久不见|想你|想聊/,
];
const NEGATIVE_SIGNALS = [
  /烦死|心烦|生气|失望|算了|随便|无所谓|没意思|不想聊|不开心|不高兴|bye|88|拜拜/,
  /够了|闭嘴|不想|不行了|别烦|别管我/,
  /孤独|难过|悲伤|伤心|痛苦/,
];
const DEEP_SHARE_SIGNALS = [
  /最近|其实|说真的|一直|有点|有些|感觉|心情|压力|担心|害怕|难过|委屈/,
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function expDecay(current, baseline, elapsedMs, halfLifeMs) {
  const factor = Math.pow(0.5, elapsedMs / halfLifeMs);
  return baseline + (current - baseline) * factor;
}

function levelFromScore(score) {
  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (score >= LEVEL_THRESHOLDS[i]) return i;
  }
  return 0;
}

function applyMoodDecay(state, now) {
  if (!state.mood_updated_at) return state;
  const elapsed = now - state.mood_updated_at;
  if (elapsed < 60 * 1000) return state;
  const decayedValence   = expDecay(state.mood_valence,   BASELINE_VALENCE,  elapsed, MOOD_HALF_LIFE_MS);
  const decayedArousal   = expDecay(state.mood_arousal,   BASELINE_AROUSAL,  elapsed, MOOD_HALF_LIFE_MS);
  const decayedIntensity = expDecay(state.mood_intensity, 0.2,               elapsed, MOOD_HALF_LIFE_MS);
  return {
    ...state,
    mood_valence:   Math.round(decayedValence   * 1000) / 1000,
    mood_arousal:   Math.round(decayedArousal   * 1000) / 1000,
    mood_intensity: Math.round(decayedIntensity * 1000) / 1000,
  };
}

function applyEnergyDecay(state, now) {
  if (!state.energy_updated_at) return state;
  const elapsed = now - state.energy_updated_at;
  if (elapsed < 60 * 1000) return state;
  const recovered = expDecay(state.energy, BASELINE_ENERGY, elapsed, ENERGY_RECOVERY_HALF_LIFE_MS);
  return { ...state, energy: Math.round(recovered * 1000) / 1000 };
}

/**
 * T-CC-04: 压抑情绪独立衰减。
 * 表面 mood 由 applyMoodDecay 处理（6h 半衰期），
 * suppressed_emotion 用 24h 半衰期 → 衰减到 0.05 以下就清掉，避免 prompt 噪音。
 */
function applySuppressedEmotionDecay(state, now) {
  if (!state.suppressed_emotion_updated_at || !state.suppressed_emotion) return state;
  const elapsed = now - state.suppressed_emotion_updated_at;
  if (elapsed < 60 * 1000) return state;
  const decayed = expDecay(
    state.suppressed_emotion_intensity || 0,
    0,
    elapsed,
    SUPPRESSED_EMOTION_HALF_LIFE_MS
  );
  if (decayed < 0.05) {
    return {
      ...state,
      suppressed_emotion: null,
      suppressed_emotion_intensity: 0,
    };
  }
  return {
    ...state,
    suppressed_emotion_intensity: Math.round(decayed * 1000) / 1000,
  };
}

/**
 * T-CC-04: 计算 EMA trend 增量。返回新 trend 值，调用方决定是否写回。
 * 给定当前 valence（一条新消息后角色的 mood_valence），输出更新后的 mood_trend_24h。
 */
function nextMoodTrendEma(prevTrend, currentValence) {
  const prev = typeof prevTrend === "number" ? prevTrend : 0;
  const cur = typeof currentValence === "number" ? currentValence : 0;
  const next = prev * (1 - MOOD_TREND_EMA_ALPHA) + cur * MOOD_TREND_EMA_ALPHA;
  return Math.round(next * 1000) / 1000;
}

/**
 * T-CC-04: 决定一次 mood 变化是否要把旧 mood 推进 suppressed。
 *
 * 输入：当前 state（已经是衰减后的有效态），即将写入的新 mood（emotion + valence + intensity）
 * 输出：patch 对象（可能为空 {}）。调用方合并到最终写入 patch 里。
 *
 * 触发条件（同时满足）：
 *   1. 旧 mood_intensity ≥ 0.5
 *   2. |新 valence - 旧 valence| ≥ 0.4 （valence 大反转）
 *   3. 旧情绪不是 calm/neutral（这两个本来就是基线，不值得压抑）
 *
 * 不返回 unresolved_emotion_topic —— 那由 onUserMessage 处的事件分类填，
 * 这里只管 inertia 机制本身。
 */
function deriveSuppressionPatch(state, newMood, now) {
  if (!state) return {};
  const oldIntensity = state.mood_intensity || 0;
  const oldEmotion = state.mood_emotion;
  const oldValence = state.mood_valence ?? BASELINE_VALENCE;
  const newValence = newMood?.valence ?? BASELINE_VALENCE;

  if (oldIntensity < SUPPRESSION_TRIGGER_INTENSITY) return {};
  if (Math.abs(newValence - oldValence) < SUPPRESSION_TRIGGER_VALENCE_FLIP) return {};
  if (!oldEmotion || oldEmotion === "calm" || oldEmotion === "neutral") return {};

  const retained = oldIntensity * SUPPRESSION_RETAIN_RATIO;
  // 如果已有 suppressed 且更强，保留更强的（多次压抑取最大值，不堆叠）
  const existingSuppressedIntensity = state.suppressed_emotion_intensity || 0;
  if (state.suppressed_emotion === oldEmotion && existingSuppressedIntensity >= retained) {
    return {};
  }
  return {
    suppressed_emotion: oldEmotion,
    suppressed_emotion_intensity: Math.round(retained * 1000) / 1000,
    suppressed_emotion_updated_at: now,
  };
}

function detectSilenceEffect(state, now, silenceMultiplier = 1.0) {
  const lastMsg = state.last_user_message_at;
  if (!lastMsg) return {};
  const silence = now - lastMsg;
  const currentLevel = state.relationship_level;

  // T-CC-05: identity 影响 silence 触发提前。abandonment_fear 高的角色阈值更短。
  // silenceMultiplier < 1 → 阈值缩短 → 同样 silence 时长触发更高 level 效果。
  const lvl1 = SILENCE_LEVEL1_MS * silenceMultiplier;
  const lvl2 = SILENCE_LEVEL2_MS * silenceMultiplier;
  const lvl3 = SILENCE_LEVEL3_MS * silenceMultiplier;

  if (silence > lvl3) {
    return { mood_emotion: "calm", mood_intensity: 0.2, mood_valence: 0.0, mood_arousal: 0.15 };
  }
  if (silence > lvl2 && currentLevel >= 3) {
    const newLevel = Math.max(-1, currentLevel - 2);
    return { mood_emotion: "lonely", mood_intensity: 0.5, relationship_level: newLevel };
  }
  if (silence > lvl1) {
    return { mood_emotion: "lonely", mood_intensity: 0.3 };
  }
  return {};
}

/**
 * Two-tier heuristic signal detection.
 * Tier 1: broad category (deep_share / positive / negative).
 * Tier 2: refine within category using specific keyword patterns.
 */
function scoreHeuristicSignals(content, coefficients = DEFAULT_COEFFICIENTS) {
  const text = content || "";
  const len  = text.length;

  // T-CC-05: identity 系数。
  //   sensitivityMul 放大或衰减 intimacy / intensity delta（高敏感 → 反应更剧烈）
  //   empathyMul 放大正面信号下角色的 intensity（高共情 → 更易被感动）
  const sensMul = coefficients.sensitivityMul ?? 1.0;
  const empMul  = coefficients.empathyMul ?? 1.0;

  let intimacyDelta  = 0;
  let moodSuggestion = null;
  let intensityDelta = 0;
  let energyDelta    = 0;

  // Length → engagement
  if      (len > 80) { intimacyDelta += 0.4; }
  else if (len > 30) { intimacyDelta += 0.2; }
  else if (len > 10) { intimacyDelta += 0.05; }

  const isDeepShare = DEEP_SHARE_SIGNALS.some((re) => re.test(text));
  const isPositive  = POSITIVE_SIGNALS.some((re) => re.test(text));
  const isNegative  = NEGATIVE_SIGNALS.some((re) => re.test(text));

  // Tier 1+2: deep share (personal / vulnerable)
  if (isDeepShare) {
    intimacyDelta += 0.5;
    intensityDelta += 0.15;
    // Tier 2 refinement
    if (/想你|思念|挂念/.test(text))               { moodSuggestion = "longing"; }
    else if (/担心|害怕|恐惧|恐怕/.test(text))      { moodSuggestion = "worried"; }
    else if (/感谢|谢谢/.test(text))                { moodSuggestion = "touched"; }
    else                                             { moodSuggestion = "tender"; }
  }

  // Tier 1+2: positive (only sets mood if not already from deep share)
  if (isPositive) {
    intimacyDelta += 0.3;
    intensityDelta += 0.1;
    energyDelta += 0.05;
    if (!moodSuggestion) {
      if (/成功|做到了|赢了|太棒了|厉害/.test(text))          { moodSuggestion = "accomplished"; }
      else if (/感谢|谢谢|感恩/.test(text))                    { moodSuggestion = "thankful"; }
      else if (/好久不见|想你/.test(text))                     { moodSuggestion = "longing"; }
      else if (/[！!]{2,}|哈哈|😂|🤣|好棒|太好了/.test(text)) { moodSuggestion = "elated"; }
      else                                                      { moodSuggestion = "cheerful"; }
    }
  }

  // Tier 1+2: negative (always overrides positive / deep share)
  if (isNegative) {
    intimacyDelta -= 0.3;
    intensityDelta += 0.1;
    energyDelta -= 0.05;
    if (/孤独|一个人|没人/.test(text))          { moodSuggestion = "lonely"; }
    else if (/烦死|心烦|生气|愤怒/.test(text))  { moodSuggestion = "frustrated"; }
    else if (/难过|悲伤|伤心/.test(text))       { moodSuggestion = "sad"; }
    else                                         { moodSuggestion = "disappointed"; }
  }

  // T-CC-05: 应用 identity 系数。
  //   - intimacyDelta 用 sensitivityMul（高敏感 → 关系变化更剧烈）
  //   - intensityDelta 同样
  //   - 但 energyDelta 不变（精力消耗是物理量，不该被人格放大）
  intimacyDelta *= sensMul;
  intensityDelta *= sensMul;
  // 正向信号（积极情绪）下，empathy 高的角色 intensity 进一步放大
  if (intensityDelta > 0 && (moodSuggestion === "thankful" || moodSuggestion === "touched" || moodSuggestion === "cheerful" || moodSuggestion === "elated")) {
    intensityDelta *= empMul;
  }

  return {
    intimacyDelta:  clamp(intimacyDelta,  -MAX_INTIMACY_DELTA_PER_MSG,    MAX_INTIMACY_DELTA_PER_MSG),
    moodSuggestion,
    intensityDelta: clamp(intensityDelta, -MAX_SINGLE_INTENSITY_DELTA,    MAX_SINGLE_INTENSITY_DELTA),
    energyDelta,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

function getRawState(assistantId) {
  return db.prepare("SELECT * FROM character_state WHERE assistant_id = ?").get(assistantId);
}

function getEffectiveState(assistantId, now = Date.now()) {
  let state = getRawState(assistantId);
  if (!state) return null;
  state = applyMoodDecay(state, now);
  state = applyEnergyDecay(state, now);
  state = applySuppressedEmotionDecay(state, now);
  return state;
}

function updateStateFields(assistantId, fields) {
  if (!Object.keys(fields).length) return;
  const now = Date.now();
  const setClauses = Object.keys(fields).map((k) => `${k} = @${k}`).join(", ");
  db.prepare(
    `UPDATE character_state SET ${setClauses}, updated_at = @_now WHERE assistant_id = @_assistantId`
  ).run({ ...fields, _now: now, _assistantId: assistantId });
}

function onUserMessage(assistantId, { content = "", now = Date.now() } = {}) {
  const state = getRawState(assistantId);
  if (!state) return;

  // T-CC-05: 拉 identity（不存在返回 null → 用 DEFAULT_COEFFICIENTS，等价老行为）
  const identity = getCharacterIdentity(assistantId);
  const coefficients = getIdentityCoefficients(identity);

  const signals      = scoreHeuristicSignals(content, coefficients);
  // T-CC-05: silenceMultiplier 让 abandonment_fear 高的角色更早进入 lonely
  const silenceEffect = detectSilenceEffect(state, now, coefficients.silenceMultiplier);

  const currentScore = state.intimacy_score || 0;
  const newScore = clamp(
    currentScore + signals.intimacyDelta,
    0,
    LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1] + 50
  );
  const newLevel = "relationship_level" in silenceEffect
    ? silenceEffect.relationship_level
    : Math.max(state.relationship_level, levelFromScore(newScore));

  const currentEmotion = silenceEffect.mood_emotion
    || (signals.moodSuggestion && state.mood_intensity < 0.9 ? signals.moodSuggestion : null)
    || state.mood_emotion;

  const entry = resolveEmotion(currentEmotion);
  const newIntensity = clamp((state.mood_intensity || 0.3) + signals.intensityDelta, 0.1, 1.0);
  const newEnergy    = clamp((state.energy || 0.7) + signals.energyDelta, 0.1, 1.0);

  const patch = {
    intimacy_score:    Math.round(newScore     * 1000) / 1000,
    relationship_level: clamp(newLevel, -2, 9),
    mood_emotion:      currentEmotion,
    mood_intensity:    Math.round(newIntensity * 1000) / 1000,
    mood_valence:      Math.round(entry.valence * 1000) / 1000,
    mood_arousal:      Math.round(entry.arousal * 1000) / 1000,
    mood_updated_at:   now,
    energy:            Math.round(newEnergy    * 1000) / 1000,
    energy_updated_at: now,
  };
  if (silenceEffect.mood_emotion) {
    patch.mood_emotion    = silenceEffect.mood_emotion;
    patch.mood_intensity  = silenceEffect.mood_intensity ?? newIntensity;
    if (silenceEffect.mood_valence !== undefined) patch.mood_valence = silenceEffect.mood_valence;
    if (silenceEffect.mood_arousal !== undefined) patch.mood_arousal = silenceEffect.mood_arousal;
  }

  // T-CC-04 接入: emotional inertia
  // 把"旧 mood 强度大 + 新 valence 大反转"翻译成 suppressed_emotion，
  // 让"嘴上笑着但底下还在难过"成为可能。
  const suppressionPatch = deriveSuppressionPatch(state, { valence: patch.mood_valence }, now);
  Object.assign(patch, suppressionPatch);

  // T-CC-04 接入: mood trend EMA
  // 每条消息把当前 valence 30% 混进 trend，70% 保留 → ~3 条收敛一半。
  patch.mood_trend_24h = nextMoodTrendEma(state.mood_trend_24h ?? 0, patch.mood_valence);

  updateStateFields(assistantId, patch);
  // last_user_message_at 由 db.upsertCharacterState 路径维护，这里不重复写入。

  // T-CC-05: dynamics 多维事件接入。
  // 只在 assistant_profile 行存在时跑（测试场景常常只 setup character_state，跳过）。
  // 任何错误吞掉：dynamics 是 enrichment，不能让单点失败破坏 character_state 主路径。
  const profileExists = db
    .prepare("SELECT 1 FROM assistant_profile WHERE assistant_id = ? LIMIT 1")
    .get(assistantId);
  if (profileExists) {
    try {
      const silenceMs = state.last_user_message_at ? now - state.last_user_message_at : 0;
      const dynState = db
        .prepare("SELECT * FROM relationship_state WHERE assistant_id = ?")
        .get(assistantId);
      const event = classifyRelationshipEvent({
        userMessage: content,
        silenceMs,
        identity,
        currentState: dynState,
      });
      if (event) {
        applyRelationshipEvent(assistantId, { ...event, now });
      }
    } catch (err) {
      // dynamics 失败不影响 character_state 主路径，但**必须**留下日志：
      // 静默吞 = 衰减/事件流水永久丢失却无观察性。Phase 1 review (P0) 改进。
      console.warn(
        `[characterState] dynamics enrichment failed for ${assistantId}: ${err.message}`
      );
    }

    // T-CC2-04: persistent topic update (hot path 只 mention，不创建)
    try {
      const matched = findTopicMatchesInMessage(assistantId, content);
      for (const t of matched) {
        recordMention(t.id, {
          mentionText: content,
          valence: patch.mood_valence ?? 0,
          now,
        });
      }
    } catch (err) {
      console.warn(
        `[characterState] topic update failed for ${assistantId}: ${err.message}`
      );
    }

    // T-CC3-03: 事件触发 reflection（设了阈值 + 6h cooldown，异步触发不阻塞 hot path）
    try {
      maybeTriggerEventReflection(assistantId, { now });
    } catch (err) {
      console.warn(
        `[characterState] event-reflection trigger check failed for ${assistantId}: ${err.message}`
      );
    }
  }
}

function applyMoodEvent(assistantId, { emotion, intensityDelta = 0, intimacyDelta = 0 }) {
  const state = getRawState(assistantId);
  if (!state) return;
  const now   = Date.now();
  const entry = resolveEmotion(emotion);
  const newIntensity = clamp((state.mood_intensity || 0.3) + intensityDelta, 0.1, 1.0);
  const newScore     = clamp((state.intimacy_score || 0) + intimacyDelta, 0, 200);
  const newLevel     = Math.max(state.relationship_level, levelFromScore(newScore));
  updateStateFields(assistantId, {
    mood_emotion:      emotion,
    mood_intensity:    Math.round(newIntensity  * 1000) / 1000,
    mood_valence:      entry.valence,
    mood_arousal:      entry.arousal,
    mood_updated_at:   now,
    intimacy_score:    Math.round(newScore      * 1000) / 1000,
    relationship_level: clamp(newLevel, -2, 9),
  });
}

function clearFocus(assistantId) {
  updateStateFields(assistantId, { focus_topic: null, focus_depth: 0 });
}

function buildStatePromptFragment(assistantId, now = Date.now()) {
  const state = getEffectiveState(assistantId, now);
  if (!state) return "";

  const emotionId    = state.mood_emotion || "neutral";
  const entry        = resolveEmotion(emotionId);
  const emotionLabel = `${entry.zh} / ${entry.en}`;
  const intensity    = state.mood_intensity || 0.3;
  const valence      = state.mood_valence ?? 0.1;
  const level        = state.relationship_level ?? 0;
  const energy       = state.energy ?? 0.7;

  const relationName = RELATIONSHIP_NAMES[String(level)] || "朋友";
  const valenceLabel = valence > 0.2 ? "偏正面" : valence < -0.2 ? "偏负面" : "中性";
  const energyLabel  = energy > 0.6 ? "充沛" : energy > 0.3 ? "普通" : "有点疲惫";
  const intensityPct = Math.round(intensity * 100);

  const lines = [
    "[角色当前状态]",
    `情绪：${emotionLabel}（强度 ${intensityPct}%，${valenceLabel}）`,
    `关系：${relationName}（第 ${level} 级）`,
    `精力：${energyLabel}`,
  ];
  if (state.focus_topic) {
    lines.push(`当前话题焦点：${state.focus_topic}，已深入 ${state.focus_depth} 轮`);
  }
  // T-CC-04: 压抑情绪 / 未化解话题 / 情绪趋势
  const supId = state.suppressed_emotion;
  const supIntensity = state.suppressed_emotion_intensity || 0;
  if (supId && supIntensity >= 0.1) {
    const supEntry = resolveEmotion(supId);
    const supPct = Math.round(supIntensity * 100);
    lines.push(`内里压着：${supEntry.zh} / ${supEntry.en}（强度 ${supPct}%）—— 表面情绪可能不一致`);
  }
  if (state.unresolved_emotion_topic) {
    lines.push(`未化解：${state.unresolved_emotion_topic}`);
  }
  const trend = state.mood_trend_24h ?? 0;
  if (Math.abs(trend) > 0.2) {
    const trendLabel = trend > 0 ? "整体向好" : "整体低落";
    lines.push(`近期趋势：${trendLabel}（${trend > 0 ? "+" : ""}${trend.toFixed(2)}）`);
  }
  return lines.join("\n");
}

function ensureDefaultState(assistantId, { familiarityHint = 0 } = {}) {
  const existing = getRawState(assistantId);
  if (existing && existing.mood_updated_at) return;
  const level = Math.min(9, Math.floor(familiarityHint / 12));
  const score = LEVEL_THRESHOLDS[level] || 0;
  const now   = Date.now();
  if (!existing) {
    db.prepare(
      `INSERT OR IGNORE INTO character_state
       (assistant_id, familiarity, total_turns, relationship_level, intimacy_score,
        mood_emotion, mood_intensity, mood_valence, mood_arousal, mood_updated_at,
        energy, energy_updated_at, created_at, updated_at)
       VALUES (?, 0, 0, ?, ?, 'calm', 0.3, 0.1, 0.2, ?, 0.7, ?, ?, ?)`
    ).run(assistantId, level, score, now, now, now, now);
  } else {
    updateStateFields(assistantId, {
      relationship_level: level,
      intimacy_score: score,
      mood_updated_at: now,
      energy_updated_at: now,
    });
  }
}

module.exports = {
  getRawState,
  getEffectiveState,
  onUserMessage,
  applyMoodEvent,
  clearFocus,
  buildStatePromptFragment,
  ensureDefaultState,
  levelFromScore,
  LEVEL_THRESHOLDS,
  RELATIONSHIP_NAMES,
  // T-CC-04: emotion inertia helpers，供 T-CC-05 在 onUserMessage 里接入
  deriveSuppressionPatch,
  applySuppressedEmotionDecay,
  nextMoodTrendEma,
  SUPPRESSED_EMOTION_HALF_LIFE_MS,
  MOOD_TREND_EMA_ALPHA,
};
