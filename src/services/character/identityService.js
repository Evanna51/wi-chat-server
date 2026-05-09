/**
 * identityService — character_identity 的 read 入口 + identity → 系数表派生
 *
 * 这一版只做 read + ensureDefault。完整 CRUD 在 T-CC-07 加。
 * 单独抽出来是因为 relationshipDynamicsService / characterStateService /
 * socialModes 都要消费 identity 系数，不能让它们各自直接读 DB 解析 JSON。
 *
 * 关键导出：
 *   getCharacterIdentity(assistantId)       → 解析后的 identity 对象 或 null
 *   ensureDefaultIdentity(assistantId)      → 没有时插入最小默认（向后兼容旧 assistant）
 *   getIdentityCoefficients(identity)       → 把 identity 转成下游服务用的系数表
 *                                              （sensitivity_multiplier 等纯数）
 *   buildIdentityPromptFragment(identity)   → 给 prompt 注入用的自然语言段落
 */

const { v7: uuidv7 } = require("uuid");
const { db } = require("../../db");

// ── DB 读取 ──────────────────────────────────────────────────────────

function parseJson(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_e) {
    return fallback;
  }
}

/**
 * 读 identity，并把 *_json 列就地解析。返回扁平对象，调用方不需要再 JSON.parse。
 * @returns {object|null}
 */
function getCharacterIdentity(assistantId) {
  const row = db
    .prepare("SELECT * FROM character_identity WHERE assistant_id = ?")
    .get(assistantId);
  if (!row) return null;
  return {
    identityId: row.identity_id,
    assistantId: row.assistant_id,
    identityVersion: row.identity_version,
    ageYears: row.age_years,
    genderExpression: row.gender_expression,
    speakingStyle: row.speaking_style || "",
    worldview: row.worldview || "",
    personalityTraits: parseJson(row.personality_traits_json, []),
    attachmentStyle: row.attachment_style || null,
    emotionalSensitivity: row.emotional_sensitivity ?? 0.5,
    empathyLevel: row.empathy_level ?? 0.5,
    expressiveness: row.expressiveness ?? 0.5,
    socialStrategyDefault: row.social_strategy_default || null,
    values: parseJson(row.values_json, []),
    hardBoundaries: parseJson(row.hard_boundaries_json, []),
    softBoundaries: parseJson(row.soft_boundaries_json, []),
    avoidanceTopics: parseJson(row.avoidance_topics_json, []),
    triggeringTopics: parseJson(row.triggering_topics_json, []),
    insecurities: parseJson(row.insecurities_json, []),
    coreWounds: parseJson(row.core_wounds_json, []),
    desires: parseJson(row.desires_json, []),
    careLanguages: parseJson(row.care_languages_json, { give: [], receive: [] }),
    tensions: parseJson(row.tensions_json, {}),
    skills: parseJson(row.skills_json, []),
    pronouns: row.pronouns || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 没 identity 时插入一个最小 secure 默认值，并把 assistant_profile.identity_id 同步指过去。
 * 幂等：已经有 identity 时直接返回现有的。
 *
 * 用途：所有依赖 identity 的服务（dynamics / state / mode）启动时调一次，
 * 保证旧 assistant 不会因为没 identity 报 null pointer。
 */
function ensureDefaultIdentity(assistantId) {
  const existing = getCharacterIdentity(assistantId);
  if (existing) return existing;

  const now = Date.now();
  const identityId = uuidv7();
  db.prepare(
    `INSERT INTO character_identity (
      identity_id, assistant_id, identity_version,
      speaking_style, worldview,
      personality_traits_json, attachment_style,
      emotional_sensitivity, empathy_level, expressiveness,
      social_strategy_default,
      values_json, hard_boundaries_json, soft_boundaries_json,
      avoidance_topics_json, triggering_topics_json,
      insecurities_json, core_wounds_json, desires_json,
      care_languages_json, tensions_json, skills_json, pronouns,
      created_at, updated_at
    ) VALUES (
      @identity_id, @assistant_id, 1,
      '', '',
      '[]', 'secure',
      0.5, 0.5, 0.5,
      'casual',
      '[]', '[]', '[]',
      '[]', '[]',
      '[]', '[]', '[]',
      '{"give":[],"receive":[]}', '{}', '[]', '',
      @now, @now
    )`
  ).run({ identity_id: identityId, assistant_id: assistantId, now });

  // 同步 assistant_profile.identity_id（如果 profile 行存在）
  db.prepare(
    `UPDATE assistant_profile SET identity_id = ?, updated_at = ? WHERE assistant_id = ?`
  ).run(identityId, now, assistantId);

  return getCharacterIdentity(assistantId);
}

// ── 系数派生 ─────────────────────────────────────────────────────────
//
// 这是 Phase 1 的关键耦合点：identity 决定下游所有 dynamics / state / mode 的系数。
// 一个角色"为什么 abandonment_fear 涨得快"就因为这里把 insecurities 翻译成了系数。

/**
 * 把 identity 转成下游服务用的系数表。所有系数都是纯数，方便 hot path 计算。
 *
 * @param {object|null} identity
 * @returns {object} 系数表
 */
function getIdentityCoefficients(identity) {
  if (!identity) return DEFAULT_COEFFICIENTS;

  const traits = new Set(identity.personalityTraits || []);
  const insecurities = new Set(identity.insecurities || []);
  const wounds = new Set(identity.coreWounds || []);
  const tensions = identity.tensions || {};

  // 敏感度放大器：直接被 identity.emotional_sensitivity 控制，
  //   但 high_sensitivity / thin_skinned trait 进一步放大
  let sensitivityMul = 0.5 + identity.emotionalSensitivity; // 0-1 → 0.5-1.5
  if (traits.has("high_sensitivity")) sensitivityMul += 0.2;
  if (traits.has("thin_skinned")) sensitivityMul += 0.15;
  if (traits.has("low_sensitivity")) sensitivityMul -= 0.15;
  if (traits.has("thick_skinned")) sensitivityMul -= 0.1;
  sensitivityMul = clamp(sensitivityMul, 0.3, 2.0);

  // 共情放大器：决定关心型行为的频率与对用户负面情绪的反射强度
  const empathyMul = clamp(0.5 + identity.empathyLevel, 0.3, 1.8);

  // abandonment_fear 涨幅倍数：
  //   anxious_attachment / fear_of_abandonment / abandonment_history 都会显著推高
  let abandonmentMul = 1.0;
  if (traits.has("anxious_attachment")) abandonmentMul += 0.5;
  if (insecurities.has("fear_of_abandonment")) abandonmentMul += 0.4;
  if (wounds.has("abandonment_history")) abandonmentMul += 0.4;
  if (wounds.has("childhood_neglect")) abandonmentMul += 0.2;
  if (traits.has("avoidant_attachment")) abandonmentMul -= 0.2;
  if (traits.has("secure_attachment")) abandonmentMul -= 0.3;
  abandonmentMul = clamp(abandonmentMul, 0.3, 2.5);

  // dependency 涨幅倍数：avoidant 涨得慢，anxious 涨得快
  let dependencyMul = 1.0;
  if (traits.has("avoidant_attachment")) dependencyMul -= 0.4;
  if (traits.has("anxious_attachment")) dependencyMul += 0.3;
  if (traits.has("controlling")) dependencyMul -= 0.2; // 不愿示弱依赖
  dependencyMul = clamp(dependencyMul, 0.2, 2.0);

  // trust 涨幅倍数：betrayal_trauma / cynical_realist 涨得慢
  let trustGainMul = 1.0;
  if (wounds.has("betrayal_trauma")) trustGainMul -= 0.4;
  if (traits.has("cynical_realist")) trustGainMul -= 0.2;
  if (traits.has("romantic_idealist")) trustGainMul += 0.15;
  if (traits.has("secure_attachment")) trustGainMul += 0.1;
  trustGainMul = clamp(trustGainMul, 0.3, 1.8);

  // trust 损失倍数（受伤后掉得多快）：thin_skinned / betrayal_trauma 掉得多
  let trustLossMul = 1.0;
  if (traits.has("thin_skinned")) trustLossMul += 0.3;
  if (wounds.has("betrayal_trauma")) trustLossMul += 0.5;
  if (traits.has("thick_skinned")) trustLossMul -= 0.3;
  trustLossMul = clamp(trustLossMul, 0.3, 2.5);

  // resentment 累积倍数：people_pleasing 不善表达 → resentment 累积更快
  let resentmentMul = 1.0;
  if (traits.has("people_pleasing")) resentmentMul += 0.4;
  if (traits.has("rational_suppressive")) resentmentMul += 0.3;
  if (traits.has("submissive")) resentmentMul += 0.2;
  if (traits.has("emotionally_expressive")) resentmentMul -= 0.3;
  resentmentMul = clamp(resentmentMul, 0.3, 2.0);

  // tension 阈值：vulnerability_vs_pride 偏 pride → tension 阈值更低（更易紧绷）
  const tensionThreshold = clamp(
    0.5 + (1 - (tensions.vulnerability_vs_pride ?? 0.5)) * 0.3,
    0.2,
    0.9
  );

  // silence 触发提前：abandonment_fear 高 → 2d 阈值降到 1d 等
  const silenceMultiplier = clamp(2.0 - abandonmentMul * 0.5, 0.5, 2.0);

  return {
    sensitivityMul,
    empathyMul,
    abandonmentMul,
    dependencyMul,
    trustGainMul,
    trustLossMul,
    resentmentMul,
    tensionThreshold,
    silenceMultiplier,
  };
}

const DEFAULT_COEFFICIENTS = Object.freeze({
  sensitivityMul: 1.0,
  empathyMul: 1.0,
  abandonmentMul: 1.0,
  dependencyMul: 1.0,
  trustGainMul: 1.0,
  trustLossMul: 1.0,
  resentmentMul: 1.0,
  tensionThreshold: 0.6,
  silenceMultiplier: 1.0,
});

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ── prompt 片段 ──────────────────────────────────────────────────────

/**
 * 把 identity 渲染成 system prompt 片段。
 * 留白原则：只输出"非默认值"，避免 prompt 被默认配置填满。
 */
function buildIdentityPromptFragment(identity) {
  if (!identity) return "";
  const lines = [];
  lines.push("[角色人格]");
  if (identity.speakingStyle) lines.push(`说话风格：${identity.speakingStyle}`);
  if (identity.worldview) lines.push(`世界观：${identity.worldview}`);

  const traits = identity.personalityTraits || [];
  if (traits.length) lines.push(`人格特质：${traits.join("、")}`);
  if (identity.attachmentStyle && identity.attachmentStyle !== "secure") {
    lines.push(`依恋类型：${identity.attachmentStyle}`);
  }

  const values = identity.values || [];
  if (values.length) lines.push(`核心价值：${values.join("、")}`);

  const hardBoundaries = identity.hardBoundaries || [];
  if (hardBoundaries.length) lines.push(`绝对边界（不可触碰）：${hardBoundaries.join("；")}`);

  const avoidance = identity.avoidanceTopics || [];
  if (avoidance.length) lines.push(`回避话题：${avoidance.join("、")}`);

  const insecurities = identity.insecurities || [];
  if (insecurities.length) lines.push(`内在不安：${insecurities.join("、")}`);

  // CC-5.C audit: core_wounds 之前漏渲染。这是"为什么是这样"的根，比 insecurities 更深。
  const coreWounds = identity.coreWounds || [];
  if (coreWounds.length) lines.push(`核心创伤：${coreWounds.join("、")}`);

  const desires = identity.desires || [];
  if (desires.length) lines.push(`深层渴望：${desires.join("、")}`);

  const give = identity.careLanguages?.give || [];
  const receive = identity.careLanguages?.receive || [];
  if (give.length) lines.push(`习惯用以下方式表达关心：${give.join("、")}`);
  if (receive.length) lines.push(`容易被以下方式打动：${receive.join("、")}`);

  // CC-5: 表达"招式" —— skill 名 + 角色专属 example（如有）。
  // few-shot example 比抽象描述对 LLM voice 锚定强，所以 example 直接渲染原文。
  const skills = identity.skills || [];
  if (skills.length) {
    const skillNames = [];
    const skillExamples = [];
    for (const s of skills) {
      if (typeof s === "string") {
        skillNames.push(s);
      } else if (s && typeof s === "object" && s.name) {
        skillNames.push(s.name);
        if (Array.isArray(s.examples)) {
          for (const ex of s.examples) skillExamples.push(`「${ex}」（${s.name}）`);
        }
      }
    }
    if (skillNames.length) lines.push(`会用的表达招式：${skillNames.join("、")}`);
    if (skillExamples.length) lines.push(`例：${skillExamples.join("；")}`);
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

// ── CRUD：upsertIdentity (T-CC-07) ──────────────────────────────────
//
// 对外的 upsert 接口。fields 用 camelCase，service 内部映射到 snake_case 列。
// 校验通过 identityVocab.validate*；任何字段非法直接抛错（caller 决定怎么响应）。
//
// 行为：
//   - 没行就 INSERT（identity_version=1）
//   - 有行就 UPDATE（identity_version 自增）
//   - 永远把 assistant_profile.identity_id 同步到当前 identity_id
const {
  validateTraits,
  validateAttachmentStyle,
  validateSocialStrategy,
  validateCareLanguagesPayload,
  validateTensions,
  validateUnitInterval,
  validateBoundaryStrings,
  validateSkillsPayload,
  validatePronouns,
} = require("./identityVocab");

function upsertIdentity(assistantId, fields = {}) {
  if (!assistantId) throw new Error("assistantId required");

  // ── 校验 ─────────────────────────────────────────────────────────
  if (fields.personalityTraits !== undefined) {
    const r = validateTraits(fields.personalityTraits);
    if (!r.ok) throw new Error(`identity validation: ${r.error}`);
  }
  if (fields.attachmentStyle !== undefined) {
    const r = validateAttachmentStyle(fields.attachmentStyle);
    if (!r.ok) throw new Error(`identity validation: ${r.error}`);
  }
  if (fields.socialStrategyDefault !== undefined) {
    const r = validateSocialStrategy(fields.socialStrategyDefault);
    if (!r.ok) throw new Error(`identity validation: ${r.error}`);
  }
  if (fields.careLanguages !== undefined) {
    const r = validateCareLanguagesPayload(fields.careLanguages);
    if (!r.ok) throw new Error(`identity validation: ${r.error}`);
  }
  if (fields.tensions !== undefined) {
    const r = validateTensions(fields.tensions);
    if (!r.ok) throw new Error(`identity validation: ${r.error}`);
  }
  if (fields.skills !== undefined) {
    const r = validateSkillsPayload(fields.skills);
    if (!r.ok) throw new Error(`identity validation: ${r.error}`);
  }
  if (fields.pronouns !== undefined) {
    const r = validatePronouns(fields.pronouns);
    if (!r.ok) throw new Error(`identity validation: ${r.error}`);
  }
  // Phase 1 review fix (P0): hardBoundaries / triggeringTopics / avoidanceTopics 字符串
  // 长度太短会被 String.includes 误匹配（"我不想了" 命中 "不"）。
  for (const [name, key] of [
    ["hard_boundaries", "hardBoundaries"],
    ["soft_boundaries", "softBoundaries"],
    ["avoidance_topics", "avoidanceTopics"],
    ["triggering_topics", "triggeringTopics"],
  ]) {
    if (fields[key] !== undefined) {
      const r = validateBoundaryStrings(fields[key], name);
      if (!r.ok) throw new Error(`identity validation: ${r.error}`);
    }
  }
  for (const [name, key] of [["emotional_sensitivity", "emotionalSensitivity"], ["empathy_level", "empathyLevel"], ["expressiveness", "expressiveness"]]) {
    if (fields[key] !== undefined) {
      const r = validateUnitInterval(name, fields[key]);
      if (!r.ok) throw new Error(`identity validation: ${r.error}`);
    }
  }

  const existing = db
    .prepare("SELECT * FROM character_identity WHERE assistant_id = ?")
    .get(assistantId);
  const now = Date.now();

  // 把 camelCase 输入映射成 (column, value)
  const colMap = {
    ageYears: "age_years",
    genderExpression: "gender_expression",
    speakingStyle: "speaking_style",
    worldview: "worldview",
    personalityTraits: "personality_traits_json",
    attachmentStyle: "attachment_style",
    emotionalSensitivity: "emotional_sensitivity",
    empathyLevel: "empathy_level",
    expressiveness: "expressiveness",
    socialStrategyDefault: "social_strategy_default",
    values: "values_json",
    hardBoundaries: "hard_boundaries_json",
    softBoundaries: "soft_boundaries_json",
    avoidanceTopics: "avoidance_topics_json",
    triggeringTopics: "triggering_topics_json",
    insecurities: "insecurities_json",
    coreWounds: "core_wounds_json",
    desires: "desires_json",
    careLanguages: "care_languages_json",
    tensions: "tensions_json",
    skills: "skills_json",
    pronouns: "pronouns",
  };

  const setEntries = [];
  const params = { assistant_id: assistantId, now };
  for (const [key, col] of Object.entries(colMap)) {
    if (fields[key] === undefined) continue;
    const v = fields[key];
    const isJson =
      col.endsWith("_json") || (typeof v === "object" && v !== null && !Array.isArray(v));
    setEntries.push({ col, value: isJson ? JSON.stringify(v) : v });
  }

  if (existing) {
    if (!setEntries.length) return getCharacterIdentity(assistantId);
    const setSql = setEntries
      .map((e, i) => {
        params[`v${i}`] = e.value;
        return `${e.col} = @v${i}`;
      })
      .join(", ");
    db.prepare(
      `UPDATE character_identity SET
        ${setSql},
        identity_version = identity_version + 1,
        updated_at = @now
       WHERE assistant_id = @assistant_id`
    ).run(params);
    return getCharacterIdentity(assistantId);
  }

  // INSERT 路径：未给的字段走 column default
  const cols = ["identity_id", "assistant_id", "identity_version", "created_at", "updated_at"];
  const placeholders = ["@identity_id", "@assistant_id", "1", "@now", "@now"];
  const identityId = uuidv7();
  params.identity_id = identityId;
  for (const [i, e] of setEntries.entries()) {
    cols.push(e.col);
    placeholders.push(`@v${i}`);
    params[`v${i}`] = e.value;
  }
  db.prepare(
    `INSERT INTO character_identity (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`
  ).run(params);
  db.prepare(
    `UPDATE assistant_profile SET identity_id = ?, updated_at = ? WHERE assistant_id = ?`
  ).run(identityId, now, assistantId);

  return getCharacterIdentity(assistantId);
}

function listAllIdentities() {
  const rows = db.prepare("SELECT assistant_id FROM character_identity ORDER BY updated_at DESC").all();
  return rows.map((r) => getCharacterIdentity(r.assistant_id));
}

module.exports = {
  getCharacterIdentity,
  ensureDefaultIdentity,
  getIdentityCoefficients,
  buildIdentityPromptFragment,
  upsertIdentity,
  listAllIdentities,
  DEFAULT_COEFFICIENTS,
};
