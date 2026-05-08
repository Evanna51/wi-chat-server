/**
 * identityVocab — character_identity 字段的受控词表 + 校验规则
 *
 * 为什么放在代码里、不放 DB：
 *   - vocab 的演进比数据更快（增加新人格类型不该走 migration）
 *   - 同一个枚举要被前端/admin/seed script 共享，单一 JS 模块比 DB lookup 干净
 *   - identity_id 字段都是 JSON，service 层 read 时拿这里的常量做白名单校验
 *
 * 用户提示："我给你的 mode 只是举例，不是完整的"
 *   → 下面的清单做了实质扩展（35 traits / 12 social modes / 8 tensions / 5 care languages
 *     等），覆盖到 Phase 2-4 的服务都能消费的程度。继续扩可以直接加项。
 */

// ── personality_traits ──────────────────────────────────────────────
//
// 35 个人格维度，覆盖：依恋、情绪调节、敏感度、社交、共情、嫉妒、自我向度、
// 浪漫向度、表达向度、控制欲。多选（一个角色可以同时是 high_sensitivity + avoidant_attachment）。
const PERSONALITY_TRAITS = Object.freeze([
  // 依恋向度
  "secure_attachment",
  "anxious_attachment",
  "avoidant_attachment",
  "disorganized_attachment",

  // 情绪调节
  "rational_suppressive",        // 用理性压制情绪
  "emotionally_expressive",      // 情绪外放
  "melancholic",                 // 易陷入低落
  "even_keeled",                 // 情绪平稳
  "volatile",                    // 起伏剧烈

  // 敏感度
  "high_sensitivity",
  "low_sensitivity",
  "thin_skinned",                // 易受伤
  "thick_skinned",               // 不易受伤

  // 社交策略
  "people_pleasing",             // 讨好
  "defensive_aloof",             // 防御性疏离
  "controlling",                 // 控制欲
  "submissive",                  // 顺从
  "playful_teasing",             // 戏谑
  "withdrawn",                   // 退缩

  // 共情向度
  "high_empathy",
  "low_empathy",
  "selective_empathy",           // 只对特定对象共情

  // 嫉妒/占有
  "easily_jealous",
  "possessive",
  "non_possessive",

  // 自我向度
  "perfectionist",
  "self_critical",
  "self_accepting",
  "self_aggrandizing",

  // 浪漫向度
  "romantic_idealist",
  "cynical_realist",
  "intellectually_romantic",     // 通过头脑沟通建立浪漫

  // 表达向度
  "verbose",                     // 话多
  "taciturn",                    // 寡言
  "eloquent",                    // 善表达
]);

const PERSONALITY_TRAITS_SET = new Set(PERSONALITY_TRAITS);

// ── attachment_style ────────────────────────────────────────────────
const ATTACHMENT_STYLES = Object.freeze([
  "secure",
  "anxious",
  "avoidant",
  "disorganized",
]);
const ATTACHMENT_STYLES_SET = new Set(ATTACHMENT_STYLES);

// ── social_strategies / SocialModes ─────────────────────────────────
//
// 12 个社交模式。Identity 层选 1 作为 default；运行时 chooseSocialMode(T-CC-09)
// 会基于 identity + relationship + emotion 实时打分挑当前主导 mode。
//
// 用户原始 8: casual / defensive / intimate / philosophical / depressive
//             / teasing / detached / caretaker
// 扩展 4: inquisitive / ritualistic / confessional / reassuring
const SOCIAL_STRATEGIES = Object.freeze([
  "casual",          // 日常闲聊基底
  "defensive",       // 触碰边界后的自我保护
  "intimate",        // 亲密袒露
  "philosophical",   // 深度抽象讨论
  "depressive",      // 自身陷入低谷
  "teasing",         // 戏谑、嬉闹
  "detached",        // 主动拉远距离
  "caretaker",       // 照顾对方为先
  "inquisitive",     // 好奇追问
  "ritualistic",     // 固定开场/告别等仪式感
  "confessional",    // 主动告白式倾诉
  "reassuring",      // 安抚、给对方安全感
]);
const SOCIAL_STRATEGIES_SET = new Set(SOCIAL_STRATEGIES);

// ── care_languages ──────────────────────────────────────────────────
//
// 5 love languages 中性化版本（虚拟陪伴里 physical_touch → physical_proximity）。
// 区分 "give" / "receive"：角色用什么方式表达关心、又最容易被什么方式打动，
// 二者通常不同（例如 "高功能照料者" give=acts_of_service, receive=verbal_affirmation）。
const CARE_LANGUAGES = Object.freeze([
  "verbal_affirmation",      // 语言上的肯定/赞美/情话
  "quality_time",            // 长聊、共度
  "acts_of_service",         // 帮做事、提建议、解决问题
  "gifts",                   // 给/收 emoji、小心意、虚拟礼物
  "physical_proximity",      // "靠在你肩上""贴贴" 类描述（虚拟亲近）
]);
const CARE_LANGUAGES_SET = new Set(CARE_LANGUAGES);

// ── personality_tensions ───────────────────────────────────────────
//
// 8 个内在张力维度。值 0-1：靠近 1 偏向左项，靠近 0 偏向右项，0.5 = 平衡。
// 下游服务 (Phase 3 reflection / Phase 4 behavior) 会读这些值决定行为：
// 例如 attachment_vs_fear=0.8 + 长 silence → 触发 abandonment_fear 升高。
const TENSIONS = Object.freeze([
  "intimacy_vs_independence",      // 亲密 vs 独立
  "rationality_vs_emotion",        // 理性 vs 情感
  "sincerity_vs_self_protection",  // 真诚 vs 自我保护
  "attachment_vs_fear",            // 依附 vs 恐惧（"想靠近但又怕受伤"）
  "stability_vs_novelty",          // 稳定 vs 新鲜
  "control_vs_surrender",          // 掌控 vs 交付
  "idealism_vs_pragmatism",        // 理想 vs 现实
  "vulnerability_vs_pride",        // 示弱 vs 自尊
]);
const TENSIONS_SET = new Set(TENSIONS);

// ── 常见 insecurities / core_wounds（建议清单，不强制） ──────────────
//
// 这两个字段是自由文本数组，但提供建议清单方便 admin UI / seed script 选择。
// service 不做白名单校验（自由度更高），仅 vocab 提供推荐。
const COMMON_INSECURITIES = Object.freeze([
  "fear_of_abandonment",
  "fear_of_being_boring",
  "fear_of_being_replaced",
  "fear_of_intimacy",
  "fear_of_judgment",
  "fear_of_inadequacy",
  "fear_of_losing_independence",
  "fear_of_being_misunderstood",
]);

const COMMON_CORE_WOUNDS = Object.freeze([
  "childhood_neglect",
  "betrayal_trauma",
  "performance_conditional_love",  // 你做得好才被爱
  "abandonment_history",
  "emotional_invalidation",        // 情绪不被允许
  "loss_of_caregiver",
  "chronic_loneliness",
]);

const COMMON_DESIRES = Object.freeze([
  "to_be_understood",
  "to_be_chosen",
  "long_term_companionship",
  "intellectual_partnership",
  "playful_connection",
  "safe_to_be_weak",
  "to_matter_to_someone",
  "freedom_to_be_oneself",
]);

// ── 校验函数 ─────────────────────────────────────────────────────────

function validateTraits(arr) {
  if (!Array.isArray(arr)) return { ok: false, error: "personality_traits must be array" };
  const invalid = arr.filter((t) => !PERSONALITY_TRAITS_SET.has(t));
  if (invalid.length) return { ok: false, error: `unknown traits: ${invalid.join(",")}` };
  return { ok: true };
}

function validateAttachmentStyle(v) {
  if (v === null || v === undefined) return { ok: true };
  if (!ATTACHMENT_STYLES_SET.has(v)) {
    return { ok: false, error: `attachment_style must be one of ${ATTACHMENT_STYLES.join("|")}` };
  }
  return { ok: true };
}

function validateSocialStrategy(v) {
  if (v === null || v === undefined) return { ok: true };
  if (!SOCIAL_STRATEGIES_SET.has(v)) {
    return { ok: false, error: `social_strategy must be one of ${SOCIAL_STRATEGIES.join("|")}` };
  }
  return { ok: true };
}

function validateCareLanguagesPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, error: "care_languages must be object {give:[],receive:[]}" };
  }
  for (const side of ["give", "receive"]) {
    const arr = payload[side];
    if (arr === undefined) continue;
    if (!Array.isArray(arr)) return { ok: false, error: `care_languages.${side} must be array` };
    const invalid = arr.filter((t) => !CARE_LANGUAGES_SET.has(t));
    if (invalid.length) return { ok: false, error: `unknown care_languages.${side}: ${invalid.join(",")}` };
  }
  return { ok: true };
}

function validateTensions(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { ok: false, error: "tensions must be object" };
  }
  for (const [k, v] of Object.entries(obj)) {
    if (!TENSIONS_SET.has(k)) return { ok: false, error: `unknown tension: ${k}` };
    if (typeof v !== "number" || v < 0 || v > 1) {
      return { ok: false, error: `tension ${k} must be number in [0,1]` };
    }
  }
  return { ok: true };
}

function validateUnitInterval(name, v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
    return { ok: false, error: `${name} must be number in [0,1]` };
  }
  return { ok: true };
}

/**
 * boundary / topic 字符串数组校验。
 * 防误报：长度太短的字符串（"不"、"没"）会被 String.includes 误匹配几乎任何消息。
 * Phase 1 review (P0): "我不想了" 命中 "不" 就误触发 boundary_violation。
 */
function validateBoundaryStrings(arr, fieldName = "boundaries") {
  if (!Array.isArray(arr)) return { ok: false, error: `${fieldName} must be array` };
  for (const item of arr) {
    if (typeof item !== "string") return { ok: false, error: `${fieldName} items must be strings` };
    const trimmed = item.trim();
    if (!trimmed) return { ok: false, error: `${fieldName} items must not be empty` };
    if (trimmed.length < 2) return { ok: false, error: `${fieldName} items too short ("${trimmed}") — at least 2 chars to avoid false matches` };
  }
  return { ok: true };
}

module.exports = {
  PERSONALITY_TRAITS,
  ATTACHMENT_STYLES,
  SOCIAL_STRATEGIES,
  CARE_LANGUAGES,
  TENSIONS,
  COMMON_INSECURITIES,
  COMMON_CORE_WOUNDS,
  COMMON_DESIRES,
  validateTraits,
  validateAttachmentStyle,
  validateSocialStrategy,
  validateCareLanguagesPayload,
  validateTensions,
  validateUnitInterval,
  validateBoundaryStrings,
};
