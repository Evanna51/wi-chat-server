/**
 * relationshipStateView — 把 character_state 行打平成对外 JSON。
 *
 * 给 /api/tool/memory-context（在 response 里夹带）
 * 和 GET /api/relationship/state（独立查询）共用，避免 schema drift。
 *
 * 字段一律 camelCase，按维度分组（mood / relationship / energy / focus），
 * 客户端 Android 侧 RelationshipStateStore.upsertFromServerJson 直接消费。
 */

const {
  getEffectiveState,
  RELATIONSHIP_NAMES,
} = require("./characterStateService");
const { resolveEmotion } = require("./emotionTaxonomy");

/**
 * 构造对外 relationshipState payload。
 *
 * @param {string} assistantId
 * @param {object} [opts]
 * @param {number} [opts.now] - 用于衰减计算的"当前时刻"，默认 Date.now()
 * @returns {object|null} payload 或 null（state 不存在时）
 */
function buildRelationshipStatePayload(assistantId, opts = {}) {
  const now = opts.now || Date.now();
  const state = getEffectiveState(assistantId, now);
  if (!state) return null;

  const emotion = resolveEmotion(state.mood_emotion || "neutral");
  const level = state.relationship_level ?? 0;

  return {
    assistantId,
    mood: {
      emotion: state.mood_emotion || "calm",
      emotionZh: emotion.zh,
      emotionEn: emotion.en,
      intensity: round3(state.mood_intensity ?? 0.3),
      valence: round3(state.mood_valence ?? 0.1),
      arousal: round3(state.mood_arousal ?? 0.2),
      updatedAt: state.mood_updated_at || null,
    },
    relationship: {
      level,
      levelName: RELATIONSHIP_NAMES[String(level)] || "朋友",
      intimacyScore: round3(state.intimacy_score ?? 0),
      totalTurns: state.total_turns || 0,
    },
    energy: {
      value: round3(state.energy ?? 0.7),
      updatedAt: state.energy_updated_at || null,
    },
    focus: state.focus_topic
      ? {
          topic: state.focus_topic,
          depth: state.focus_depth || 0,
        }
      : null,
    lastUserMessageAt: state.last_user_message_at || null,
    lastProactiveAt: state.last_proactive_at || null,
    updatedAt: state.updated_at || null,
  };
}

function round3(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return v;
  return Math.round(v * 1000) / 1000;
}

module.exports = { buildRelationshipStatePayload };
