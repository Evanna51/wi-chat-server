const { db } = require("../db");

// ── Constants ────────────────────────────────────────────────────────────────

const MOOD_HALF_LIFE_MS = 6 * 60 * 60 * 1000;       // 6h
const ENERGY_RECOVERY_HALF_LIFE_MS = 8 * 60 * 60 * 1000;
const BASELINE_VALENCE = 0.1;
const BASELINE_AROUSAL = 0.2;
const BASELINE_ENERGY  = 0.7;

// Maximum delta per single event (prevents sudden jumps)
const MAX_INTIMACY_DELTA_PER_MSG = 1.5;
const MAX_SINGLE_INTENSITY_DELTA = 0.3;

// Silence thresholds (ms)
const SILENCE_LEVEL1_MS = 2  * 24 * 60 * 60 * 1000;  // 2d  → mild lonely
const SILENCE_LEVEL2_MS = 7  * 24 * 60 * 60 * 1000;  // 7d  → relationship decay
const SILENCE_LEVEL3_MS = 30 * 24 * 60 * 60 * 1000;  // 30d → soft reset

// Relationship level thresholds (cumulative intimacy_score)
const LEVEL_THRESHOLDS = [0, 5, 12, 22, 35, 52, 72, 96, 124, 156]; // level 0-9
// Level -1 (疏远) and -2 (冷战) are handled via event logic, not score

// Emotion metadata: [valence, arousal]
const EMOTION_META = {
  happy:        [0.6, 0.6],
  excited:      [0.8, 0.9],
  calm:         [0.2, 0.2],
  loving:       [0.7, 0.4],
  nostalgic:    [0.3, 0.3],
  surprised:    [0.0, 0.8],
  anxious:      [-0.5, 0.7],
  sad:          [-0.6, 0.2],
  lonely:       [-0.5, 0.2],
  angry:        [-0.7, 0.8],
  disappointed: [-0.6, 0.3],
  disgusted:    [-0.8, 0.5],
};

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

// Simple keyword buckets for heuristic signal detection (no LLM call)
const POSITIVE_SIGNALS = [
  /谢谢|感谢|太好了|真的|好开心|好高兴|好棒|厉害|awesome|thanks|love|❤|♥|😊|🥰|😍/,
  /分享|告诉你|说个秘密|只有你知道/,
  /好久不见|想你|想聊/,
];
const NEGATIVE_SIGNALS = [
  /烦|生气|失望|算了|随便|无所谓|没意思|不想聊|bye|88|拜拜/,
  /不|别|停|够了|闭嘴/,
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
  if (elapsed < 60 * 1000) return state; // skip if less than 1 min
  const decayedValence  = expDecay(state.mood_valence,  BASELINE_VALENCE,  elapsed, MOOD_HALF_LIFE_MS);
  const decayedArousal  = expDecay(state.mood_arousal,  BASELINE_AROUSAL,  elapsed, MOOD_HALF_LIFE_MS);
  const decayedIntensity = expDecay(state.mood_intensity, 0.2, elapsed, MOOD_HALF_LIFE_MS);
  return {
    ...state,
    mood_valence:   Math.round(decayedValence  * 1000) / 1000,
    mood_arousal:   Math.round(decayedArousal  * 1000) / 1000,
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

function detectSilenceEffect(state, now) {
  const lastMsg = state.last_user_message_at;
  if (!lastMsg) return {};
  const silence = now - lastMsg;
  const currentLevel = state.relationship_level;

  if (silence > SILENCE_LEVEL3_MS) {
    // 30d+ → soft reset mood, relationship stays but score stops growing
    return { mood_emotion: "calm", mood_intensity: 0.2, mood_valence: 0.0, mood_arousal: 0.15 };
  }
  if (silence > SILENCE_LEVEL2_MS && currentLevel >= 3) {
    // 7d+ with some relationship depth → lonely, may drift to 疏远
    const newLevel = currentLevel >= 3 ? Math.max(-1, currentLevel - 2) : currentLevel;
    return { mood_emotion: "lonely", mood_intensity: 0.5, relationship_level: newLevel };
  }
  if (silence > SILENCE_LEVEL1_MS) {
    return { mood_emotion: "lonely", mood_intensity: 0.3 };
  }
  return {};
}

function scoreHeuristicSignals(content) {
  const text = content || "";
  const len = text.length;

  let intimacyDelta = 0;
  let moodSuggestion = null;
  let intensityDelta = 0;
  let energyDelta = 0;

  // Length signal: longer messages = more engagement
  if (len > 80)      { intimacyDelta += 0.4; }
  else if (len > 30) { intimacyDelta += 0.2; }
  else if (len > 10) { intimacyDelta += 0.05; }

  // Deep share: personal vulnerable content
  if (DEEP_SHARE_SIGNALS.some((re) => re.test(text))) {
    intimacyDelta += 0.5;
    moodSuggestion = "loving";
    intensityDelta += 0.15;
  }

  // Positive signals
  if (POSITIVE_SIGNALS.some((re) => re.test(text))) {
    intimacyDelta += 0.3;
    moodSuggestion = moodSuggestion || "happy";
    intensityDelta += 0.1;
    energyDelta += 0.05;
  }

  // Negative signals
  if (NEGATIVE_SIGNALS.some((re) => re.test(text))) {
    intimacyDelta -= 0.3;
    moodSuggestion = "disappointed";
    intensityDelta += 0.1;
    energyDelta -= 0.05;
  }

  return {
    intimacyDelta: clamp(intimacyDelta, -MAX_INTIMACY_DELTA_PER_MSG, MAX_INTIMACY_DELTA_PER_MSG),
    moodSuggestion,
    intensityDelta: clamp(intensityDelta, -MAX_SINGLE_INTENSITY_DELTA, MAX_SINGLE_INTENSITY_DELTA),
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

  const signals = scoreHeuristicSignals(content);
  const silenceEffect = detectSilenceEffect(state, now);

  const currentScore = state.intimacy_score || 0;
  const newScore = clamp(currentScore + signals.intimacyDelta, 0, LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1] + 50);
  const newLevel = "relationship_level" in silenceEffect
    ? silenceEffect.relationship_level
    : Math.max(
        "relationship_level" in silenceEffect ? silenceEffect.relationship_level : state.relationship_level,
        levelFromScore(newScore)
      );

  const currentEmotion = silenceEffect.mood_emotion || (signals.moodSuggestion && state.mood_intensity < 0.9 ? signals.moodSuggestion : null) || state.mood_emotion;
  const [targetValence, targetArousal] = EMOTION_META[currentEmotion] || EMOTION_META.calm;
  const newIntensity = clamp((state.mood_intensity || 0.3) + signals.intensityDelta, 0.1, 1.0);
  const newEnergy = clamp((state.energy || 0.7) + signals.energyDelta, 0.1, 1.0);

  const patch = {
    intimacy_score: Math.round(newScore * 1000) / 1000,
    relationship_level: clamp(newLevel, -2, 9),
    mood_emotion: currentEmotion,
    mood_intensity: Math.round(newIntensity * 1000) / 1000,
    mood_valence: Math.round(targetValence * 1000) / 1000,
    mood_arousal: Math.round(targetArousal * 1000) / 1000,
    mood_updated_at: now,
    energy: Math.round(newEnergy * 1000) / 1000,
    energy_updated_at: now,
  };
  if (silenceEffect.mood_emotion) {
    patch.mood_emotion = silenceEffect.mood_emotion;
    patch.mood_intensity = silenceEffect.mood_intensity ?? newIntensity;
    if (silenceEffect.mood_valence !== undefined) patch.mood_valence = silenceEffect.mood_valence;
    if (silenceEffect.mood_arousal !== undefined) patch.mood_arousal = silenceEffect.mood_arousal;
  }

  updateStateFields(assistantId, patch);
}

function applyMoodEvent(assistantId, { emotion, intensityDelta = 0, intimacyDelta = 0 }) {
  const state = getRawState(assistantId);
  if (!state) return;
  const now = Date.now();
  const [valence, arousal] = EMOTION_META[emotion] || EMOTION_META.calm;
  const newIntensity = clamp((state.mood_intensity || 0.3) + intensityDelta, 0.1, 1.0);
  const newScore = clamp((state.intimacy_score || 0) + intimacyDelta, 0, 200);
  const newLevel = Math.max(state.relationship_level, levelFromScore(newScore));
  updateStateFields(assistantId, {
    mood_emotion: emotion,
    mood_intensity: Math.round(newIntensity * 1000) / 1000,
    mood_valence: valence,
    mood_arousal: arousal,
    mood_updated_at: now,
    intimacy_score: Math.round(newScore * 1000) / 1000,
    relationship_level: clamp(newLevel, -2, 9),
  });
}

function clearFocus(assistantId) {
  updateStateFields(assistantId, { focus_topic: null, focus_depth: 0 });
}

function buildStatePromptFragment(assistantId, now = Date.now()) {
  const state = getEffectiveState(assistantId, now);
  if (!state) return "";

  const emotion = state.mood_emotion || "calm";
  const intensity = state.mood_intensity || 0.3;
  const valence = state.mood_valence ?? 0.1;
  const level = state.relationship_level ?? 0;
  const energy = state.energy ?? 0.7;

  const relationName = RELATIONSHIP_NAMES[String(level)] || "朋友";
  const valenceLabel = valence > 0.2 ? "偏正面" : valence < -0.2 ? "偏负面" : "中性";
  const energyLabel = energy > 0.6 ? "充沛" : energy > 0.3 ? "普通" : "有点疲惫";
  const intensityPct = Math.round(intensity * 100);

  const lines = [
    "[角色当前状态]",
    `情绪：${emotion}（强度 ${intensityPct}%，${valenceLabel}）`,
    `关系：${relationName}（第 ${level} 级）`,
    `精力：${energyLabel}`,
  ];
  if (state.focus_topic) {
    lines.push(`当前话题焦点：${state.focus_topic}，已深入 ${state.focus_depth} 轮`);
  }
  return lines.join("\n");
}

function ensureDefaultState(assistantId, { familiarityHint = 0 } = {}) {
  const existing = getRawState(assistantId);
  if (existing && existing.mood_updated_at) return;
  const level = Math.min(9, Math.floor(familiarityHint / 12));
  const score = LEVEL_THRESHOLDS[level] || 0;
  const now = Date.now();
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
  EMOTION_META,
};
