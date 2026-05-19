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
// 43 个人格维度，覆盖：依恋、情绪调节、敏感度、社交、共情、嫉妒、自我向度、
// 浪漫向度、表达向度、控制欲、自尊向度、记仇/羞耻。多选。
//
// CC-5：补 8 个（prideful / dry_witted / blunt / stoic / vindictive / brooding /
// shame_prone / theatrical）—— 让 LLM 能从 trait 直接派生 sarcasm/cold/silence/
// grudge/dramatic 等表达，而不需要单独的 expression-style 层。
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
  "stoic",                       // 坚忍：受伤不显，比 rational_suppressive 更广（情绪上忍）

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
  "blunt",                       // 直率：不绕弯子，反话率低
  "dry_witted",                  // 反讽倾向：sarcasm 是默认 register

  // 共情向度
  "high_empathy",
  "low_empathy",
  "selective_empathy",           // 只对特定对象共情

  // 嫉妒/占有
  "easily_jealous",
  "possessive",
  "non_possessive",
  "vindictive",                  // 记仇：受伤后冷战，resentment 涨快退慢

  // 自我向度
  "perfectionist",
  "self_critical",
  "self_accepting",
  "self_aggrandizing",
  "prideful",                    // 高自尊：低头难、不接受同情、cold_correct 倾向
  "shame_prone",                 // 羞耻倾向：被看到时想消失，self_critical 的内化形态
  "brooding",                    // 反复想：固化成执念的倾向（fixation 接口）

  // 浪漫向度
  "romantic_idealist",
  "cynical_realist",
  "intellectually_romantic",     // 通过头脑沟通建立浪漫

  // 表达向度
  "verbose",                     // 话多
  "taciturn",                    // 寡言
  "eloquent",                    // 善表达
  "theatrical",                  // 戏剧化：表达放大倍数
]);

const PERSONALITY_TRAITS_SET = new Set(PERSONALITY_TRAITS);

// ── pronouns ────────────────────────────────────────────────────────
//
// 角色英文人称代词（驱动 voice anchor 渲染）。preset 三个常见组合，
// 也接受自由文本（如 "xe/xem" 或 "ze/hir"）。空字符串 → fallback "they/them"。
//
// 与 gender_expression 的区别：gender_expression 是性别表达自由文本
// （"feminine" / "masculine" / 等等），跟英文人称代词独立。
const PRONOUN_PRESETS = Object.freeze([
  "she/her",
  "he/him",
  "they/them",
]);

/**
 * 把 pronouns 字符串解析成 voice anchor 渲染需要的细分形态。
 * 输入：raw 字符串如 "she/her" / "he/him" / "they/them" / "" / 自定义
 * 输出：{ subject, object, possessive, zhSubject, zhObject }
 *
 * - subject: 主格（she / he / they）—— 用在 "she would" "they would"
 * - object: 宾格（her / him / them）—— 用在 "Speak as her"
 * - possessive: 物主（her / his / their）—— 用在 "Use her skills"
 * - zhSubject / zhObject: 中文（"她" / "他" / "ta"）—— 内部独白可能用
 *
 * 空 / 不识别 → 默认 they/them/their/ta（gender-neutral 安全默认）。
 */
function parsePronouns(raw) {
  if (!raw || typeof raw !== "string") {
    return { subject: "they", object: "them", possessive: "their", zhSubject: "ta", zhObject: "ta" };
  }
  const norm = raw.toLowerCase().trim();
  if (!norm) {
    return { subject: "they", object: "them", possessive: "their", zhSubject: "ta", zhObject: "ta" };
  }
  // 三个 preset 优先（最稳）
  if (norm === "she/her" || norm.startsWith("she/")) {
    return { subject: "she", object: "her", possessive: "her", zhSubject: "她", zhObject: "她" };
  }
  if (norm === "he/him" || norm.startsWith("he/")) {
    return { subject: "he", object: "him", possessive: "his", zhSubject: "他", zhObject: "他" };
  }
  if (norm === "they/them" || norm.startsWith("they/")) {
    return { subject: "they", object: "them", possessive: "their", zhSubject: "ta", zhObject: "ta" };
  }
  // 自定义代词（"xe/xem/xyr" 这种）—— split 取前三段
  const parts = norm.split("/").map((s) => s.trim()).filter(Boolean);
  return {
    subject: parts[0] || "they",
    object: parts[1] || parts[0] || "them",
    possessive: parts[2] || parts[1] || parts[0] || "their",
    zhSubject: "ta",
    zhObject: "ta",
  };
}

function validatePronouns(v) {
  if (v === null || v === undefined || v === "") return { ok: true };
  if (typeof v !== "string") return { ok: false, error: "pronouns must be string" };
  if (v.length > 30) return { ok: false, error: "pronouns too long (max 30 chars)" };
  return { ok: true };
}

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

// ── skills ──────────────────────────────────────────────────────────
//
// CC-5：表达"招式" —— 角色**能**使用的表达技巧（disposition 之上的 capability）。
// 与 trait 的区别：trait 是想不想，skill 是会不会。同样 prideful + dry_witted 的
// 两个角色，skill=[literary_allusion] 的会引用文学，没有这个 skill 的就直接讽。
//
// 不强校验（自由文本数组，跟 desires / insecurities 一样）。下面只是建议清单。
//
// service 层 read 时把 skills_json 解出来，渲染 prompt 时直接把 skill 名 + 角色专属
// example（如有）拼进去。LLM 自己决定**这一刻**调用哪个 skill —— 我们不打分、不挑。
const COMMON_SKILLS = Object.freeze([
  // 智性表达
  "literary_allusion",         // 文学引用
  "philosophical_volley",      // 哲学辩
  "code_switching",            // 中英 / 方言切换
  "scientific_reference",      // 数据 / 科学引用

  // 玩闹
  "meme_literacy",             // 玩梗
  "verbal_sparring",           // 怼人 / 嘴硬
  "dark_humor",
  "self_deprecation_as_art",   // 自嘲艺术化

  // 情感
  "coquettish_baby_talk",      // 撒娇
  "wordless_affection",        // 无言示意（"嗯" / 表情 / 小动作）
  "indirect_love_letter",      // 借物喻情

  // 防御
  "topic_pivot",               // 主动转移话题
  "playing_dumb",              // 装糊涂
  "selective_silence",         // 战略性沉默

  // 节奏
  "fragmented_speech",         // 片段化表达
  "ritual_phrases",            // 固定开场 / 告别（"早""晚安"）
  "netspeak",                  // 网络流行语
  "particles_register",        // 语气词体系（"嘛""哟""鸭"）
]);
const COMMON_SKILLS_SET = new Set(COMMON_SKILLS);

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
//
// 文化框架说明：
//   原版 list（20 + 17 项）偏西方个体化 / attachment theory 框架。
//   CC-5 补 8 + 8 项 East Asian / 中文文化语境特有的不安全感与创伤源 ——
//   面子、家庭期望、横向比较、学业压力、留守、重男轻女、催婚、被羞辱式管教等。
//   两套并存：建模一个东亚角色用东亚 vocab，建模一个西方角色用原版 vocab。
const COMMON_INSECURITIES = Object.freeze([
  // 西方个体化框架
  "fear_of_abandonment",
  "fear_of_being_boring",
  "fear_of_being_replaced",
  "fear_of_intimacy",
  "fear_of_judgment",
  "fear_of_inadequacy",
  "fear_of_losing_independence",
  "fear_of_being_misunderstood",
  "fear_of_rejection",
  "fear_of_being_too_much",
  "fear_of_failure",
  "fear_of_being_used",
  "fear_of_loss",
  "fear_of_change",
  "fear_of_loneliness",
  "fear_of_being_seen",
  "fear_of_commitment",
  "fear_of_vulnerability",
  "fear_of_disappointing_others",
  "fear_of_aging",

  // East Asian / 中文文化语境
  "fear_of_losing_face",                // 怕丢人 / 没面子（连续不安全感，不是事件性 humiliation）
  "fear_of_burdening_others",           // 怕给人添麻烦 / 不想欠人情（≠ 怕亲密 / 怕依赖）
  "fear_of_disappointing_family",       // 怕让爸妈/家人失望（多代际压力，比 disappointing_others 更深）
  "fear_of_being_compared_unfavorably", // "别人家的孩子" 横向比较创伤
  "fear_of_standing_out",               // 怕出头 / 枪打出头鸟（与 fear_of_being_seen 反向）
  "fear_of_being_unfilial",             // 怕被说不孝 / 白眼狼
  "fear_of_being_left_behind_socially", // 怕掉队 / 落后（阶层 / 同龄人焦虑）
  "fear_of_emotional_exposure",         // 怕情绪外露被看见（"情绪管理" 文化压力）
]);

const COMMON_CORE_WOUNDS = Object.freeze([
  // 西方个体化框架
  "childhood_neglect",
  "betrayal_trauma",
  "performance_conditional_love",  // 你做得好才被爱
  "abandonment_history",
  "emotional_invalidation",        // 情绪不被允许
  "loss_of_caregiver",
  "chronic_loneliness",
  "parental_enmeshment",           // 与父母过度纠缠
  "bullying_history",
  "body_shame",
  "chronic_invalidation",
  "divorce_of_parents",
  "early_loss",
  "caretaker_role_too_young",      // 过早承担照护者
  "emotional_incest",              // 情感越界
  "public_humiliation",
  "religious_or_cultural_trauma",

  // East Asian / 中文文化语境
  "academic_pressure_trauma",            // 升学 / 高考 / 成绩压力创伤
  "chronic_comparison_to_peers",         // 长期被比较（不只是 invalidation，是绩效层面的比较）
  "emotional_suppression_household",     // 家里不谈感受（比 emotional_invalidation 更广 —— 整个家庭文化）
  "only_child_loneliness",               // 独生子女孤独（中国一代特有）
  "left_behind_child",                   // 留守儿童（父母外出务工童年缺席）
  "patriarchal_devaluation",             // 重男轻女 / 性别贬值
  "discipline_through_shame",            // 用羞辱 / 比较 / "不要脸" 式管教
  "parents_loveless_marriage_witnessing", // 见证父母无爱婚姻（≠ divorce，"凑合过" 的代际创伤）
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
  "to_be_seen_fully",
  "to_be_held",                    // 被拥抱 / 物理安抚
  "to_belong",
  "creative_freedom",
  "adventure_and_growth",
  "domestic_intimacy",             // 日常生活中的亲密
  "to_be_someones_safe_person",
  "to_be_proud_of_oneself",
  "aesthetic_immersion",           // 沉浸式审美
  "mutual_growth",
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
 * skills 字段校验。支持两种格式：
 *   1. ["literary_allusion", "self_deprecation_as_art"]  —— 简单字符串数组
 *   2. [{ name: "literary_allusion", examples: ["..."] }] —— 带角色专属 voice 锚
 * 混用也允许：["topic_pivot", { name: "literary_allusion", examples: ["..."] }]
 *
 * 不在 COMMON_SKILLS 清单里的 skill 名也允许（自由文本，跟 desires/insecurities 一致）。
 * 但格式必须对：要么 string，要么 object 带 name(string)。
 */
function validateSkillsPayload(arr) {
  if (!Array.isArray(arr)) return { ok: false, error: "skills must be array" };
  for (const item of arr) {
    if (typeof item === "string") {
      if (!item.trim()) return { ok: false, error: "skill name must not be empty" };
      continue;
    }
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (typeof item.name !== "string" || !item.name.trim()) {
        return { ok: false, error: "skill object must have non-empty name" };
      }
      if (item.examples !== undefined) {
        if (!Array.isArray(item.examples)) {
          return { ok: false, error: `skill ${item.name}: examples must be array` };
        }
        for (const ex of item.examples) {
          if (typeof ex !== "string") {
            return { ok: false, error: `skill ${item.name}: examples must be strings` };
          }
        }
      }
      continue;
    }
    return { ok: false, error: "skill must be string or {name, examples?}" };
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
  COMMON_SKILLS,
  PRONOUN_PRESETS,
  validateTraits,
  validateAttachmentStyle,
  validateSocialStrategy,
  validateCareLanguagesPayload,
  validateTensions,
  validateUnitInterval,
  validateBoundaryStrings,
  validateSkillsPayload,
  validatePronouns,
  parsePronouns,
};
