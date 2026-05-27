/**
 * relationshipDynamicsService — 多维关系动力学引擎（T-CC-03）
 *
 * 核心论点（来自规划讨论）：
 *   "关系" 不是 1 维 intimacy_score。一个角色可以同时 trust 很高 + abandonment_fear 很高，
 *   这才是活人感的来源。所以 relationship_state 是 12 维向量，
 *   每条用户消息触发一次事件分类 → identity-aware delta → 各维独立衰减。
 *
 * 与现有 character_state 的分工：
 *   character_state             实时态（每条消息更新，秒/分钟级，已稳定 38 测试断言）
 *   relationship_state (本文件) 中期累积态（事件触发，小时/天级）
 *   relationship_reflection     长期态（Phase 3，cron 周/天）
 *
 * 设计要点：
 *   1. 12 维各自独立半衰期。tension/abandonment_fear 衰减快，trust/closeness 衰减慢
 *   2. unresolved_conflict 与 resentment 不自动衰减 —— 必须由 reconciliation /
 *      gratitude_expressed 事件清掉，符合"未化解就一直在那里"的现实
 *   3. 所有 delta 都过 identity 系数。同样的 cold_response：
 *      anxious_attachment 角色 abandonment_fear 涨 +0.10
 *      secure_attachment 角色只涨 +0.03
 *   4. 事件分类用启发式（关键词 + 长度 + 沉默时长），不打 LLM。
 *      Phase 2/3 可以补 LLM 兜底，但 Phase 1 求快不求全。
 */

const { v7: uuidv7 } = require("uuid");
const { db } = require("../../db");
const {
  ensureDefaultIdentity,
  getCharacterIdentity,
  getIdentityCoefficients,
} = require("./identityService");

// ── 衰减半衰期（毫秒） ──────────────────────────────────────────────
//
// 选取标准：trust/closeness 是慢变量（不会因为今天没说话就崩），
// tension/abandonment_fear 是快变量（几天就该自然平复，否则会卡死）。
// unresolved_conflict / resentment 不衰减 —— 是设计选择，不是疏漏。
const DECAY_HALF_LIFE = Object.freeze({
  trust: 30 * 24 * 60 * 60 * 1000,
  dependency: 14 * 24 * 60 * 60 * 1000,
  emotional_safety: 30 * 24 * 60 * 60 * 1000,
  attachment: 21 * 24 * 60 * 60 * 1000,
  tension: 3 * 24 * 60 * 60 * 1000,
  abandonment_fear: 7 * 24 * 60 * 60 * 1000,
  reciprocity_balance: 14 * 24 * 60 * 60 * 1000,
  emotional_closeness: 21 * 24 * 60 * 60 * 1000,
  social_distance: 14 * 24 * 60 * 60 * 1000,
  gratitude: 7 * 24 * 60 * 60 * 1000,
  // unresolved_conflict / resentment 不在表里 → 不衰减
});

// 各维 baseline（衰减目标值）。从 identity 推导出来后由 ensureDefault 写入。
const DEFAULT_BASELINES = Object.freeze({
  trust: 0.3,
  dependency: 0.1,
  emotional_safety: 0.4,
  attachment: 0.2,
  tension: 0.0,
  abandonment_fear: 0.0,
  reciprocity_balance: 0.5,
  emotional_closeness: 0.2,
  social_distance: 0.7,
  gratitude: 0.0,
});

// ── 事件 → delta 基础矩阵 ──────────────────────────────────────────
//
// 这是 Phase 1 最 dense 的设计：13 类事件 × 12 维 = 156 个数。值不是拍脑袋来的，
// 而是"这个事件应该把关系往哪个方向推" 的语义编码。
//
// 系数标记（在 applyRelationshipEvent 里乘）：
//   *S = sensitivityMul          (放大或衰减用户对负面/正面信号的敏感度)
//   *A = abandonmentMul          (anxious_attachment / fear_of_abandonment 角色更怕)
//   *D = dependencyMul           (avoidant 不愿示弱依赖)
//   *Tg = trustGainMul           (betrayal_trauma 难以重建信任)
//   *Tl = trustLossMul           (受伤后掉得多快)
//   *R = resentmentMul           (people_pleasing 累积更快)
//   *E = empathyMul              (高共情角色对正面事件反应更强)
const EVENT_DELTA_TEMPLATES = Object.freeze({
  vulnerable_share: {
    trust: { base: +0.05, mul: "Tg" },
    dependency: { base: +0.03, mul: "D" },
    emotional_safety: { base: +0.05 },
    attachment: { base: +0.04, mul: "D" },
    tension: { base: -0.02 },
    // reciprocity_balance 定义：0=AI 单方付出, 0.5=平衡, 1=用户单方付出。
    // 用户袒露 = 用户付出 → balance 应往 1 推（旧版本写反了，Phase 1 review P0 修）
    reciprocity_balance: { base: +0.05 },
    emotional_closeness: { base: +0.05 },
    social_distance: { base: -0.04 },
    resentment: { base: -0.02 },
  },
  reciprocated_care: {
    trust: { base: +0.04, mul: "Tg" },
    dependency: { base: +0.02 },
    emotional_safety: { base: +0.05 },
    attachment: { base: +0.03 },
    tension: { base: -0.03 },
    abandonment_fear: { base: -0.05, mul: "A" },
    reciprocity_balance: { base: +0.10 },
    emotional_closeness: { base: +0.04 },
    social_distance: { base: -0.05 },
    resentment: { base: -0.03 },
    gratitude: { base: +0.05, mul: "E" },
  },
  cold_response: {
    trust: { base: -0.02, mul: "Tl" },
    dependency: { base: -0.02 },
    emotional_safety: { base: -0.04, mul: "S" },
    attachment: { base: -0.02 },
    tension: { base: +0.05, mul: "S" },
    abandonment_fear: { base: +0.04, mul: "A" },
    reciprocity_balance: { base: -0.03 },
    emotional_closeness: { base: -0.03 },
    social_distance: { base: +0.05 },
    resentment: { base: +0.03, mul: "R" },
  },
  unanswered_message: {
    trust: { base: -0.01 },
    dependency: { base: -0.02 },
    emotional_safety: { base: -0.02 },
    attachment: { base: -0.02 },
    tension: { base: +0.02 },
    abandonment_fear: { base: +0.06, mul: "A" },
    reciprocity_balance: { base: -0.05 },
    emotional_closeness: { base: -0.02 },
    social_distance: { base: +0.04 },
    resentment: { base: +0.02, mul: "R" },
  },
  conflict: {
    trust: { base: -0.05, mul: "Tl" },
    dependency: { base: -0.03 },
    emotional_safety: { base: -0.08, mul: "S" },
    tension: { base: +0.15, mul: "S" },
    unresolved_conflict: { base: +0.40 },
    abandonment_fear: { base: +0.05, mul: "A" },
    emotional_closeness: { base: -0.05 },
    social_distance: { base: +0.08 },
    resentment: { base: +0.05, mul: "R" },
  },
  reconciliation: {
    trust: { base: +0.05, mul: "Tg" },
    dependency: { base: +0.02 },
    emotional_safety: { base: +0.06 },
    attachment: { base: +0.03 },
    tension: { base: -0.10 },
    // 一次和解只能消化一次冲突（conflict +0.40 vs reconciliation -0.30）。
    // 旧 -0.50 不平衡——一句道歉抵两次冲突。Phase 1 review P1 修。
    unresolved_conflict: { base: -0.30 },
    abandonment_fear: { base: -0.05, mul: "A" },
    emotional_closeness: { base: +0.06 },
    social_distance: { base: -0.06 },
    resentment: { base: -0.05 },
    gratitude: { base: +0.02 },
  },
  trust_gained: {
    trust: { base: +0.08, mul: "Tg" },
    emotional_safety: { base: +0.04 },
    tension: { base: -0.02 },
    abandonment_fear: { base: -0.04, mul: "A" },
    emotional_closeness: { base: +0.02 },
    social_distance: { base: -0.02 },
  },
  trust_broken: {
    trust: { base: -0.15, mul: "Tl" },
    dependency: { base: -0.04 },
    emotional_safety: { base: -0.10 },
    attachment: { base: -0.04 },
    tension: { base: +0.10 },
    unresolved_conflict: { base: +0.10 },
    abandonment_fear: { base: +0.06, mul: "A" },
    emotional_closeness: { base: -0.05 },
    social_distance: { base: +0.05 },
    resentment: { base: +0.04, mul: "R" },
  },
  boundary_violation: {
    trust: { base: -0.08, mul: "Tl" },
    dependency: { base: -0.03 },
    emotional_safety: { base: -0.10, mul: "S" },
    attachment: { base: -0.03 },
    tension: { base: +0.15 },
    unresolved_conflict: { base: +0.10 },
    abandonment_fear: { base: +0.04, mul: "A" },
    emotional_closeness: { base: -0.05 },
    social_distance: { base: +0.08 },
    resentment: { base: +0.04, mul: "R" },
  },
  silence_break: {
    trust: { base: +0.02 },
    emotional_safety: { base: +0.02 },
    tension: { base: -0.05 },
    abandonment_fear: { base: -0.03, mul: "A" },
    emotional_closeness: { base: +0.03 },
    social_distance: { base: -0.05 },
    resentment: { base: -0.02 },
  },
  shared_intimacy: {
    trust: { base: +0.06, mul: "Tg" },
    dependency: { base: +0.04, mul: "D" },
    emotional_safety: { base: +0.08 },
    attachment: { base: +0.06 },
    tension: { base: -0.03 },
    abandonment_fear: { base: -0.04, mul: "A" },
    // 旧 +0.10 是所有事件单维最大 → 5 次"我爱你"就到 1.0。
    // 拉到 +0.07 与 trust 同节奏，避免 closeness 脱钩 trust 独自爆顶。Phase 1 review P1 修。
    emotional_closeness: { base: +0.07 },
    social_distance: { base: -0.08 },
    resentment: { base: -0.03 },
    gratitude: { base: +0.02 },
  },
  distancing_signal: {
    trust: { base: -0.02 },
    dependency: { base: -0.04 },
    emotional_safety: { base: -0.04, mul: "S" },
    attachment: { base: -0.05 },
    tension: { base: +0.05 },
    abandonment_fear: { base: +0.06, mul: "A" },
    emotional_closeness: { base: -0.05 },
    social_distance: { base: +0.06 },
    resentment: { base: +0.02 },
  },
  gratitude_expressed: {
    trust: { base: +0.03, mul: "Tg" },
    emotional_safety: { base: +0.03 },
    attachment: { base: +0.02 },
    tension: { base: -0.02 },
    abandonment_fear: { base: -0.02, mul: "A" },
    reciprocity_balance: { base: +0.05 },
    emotional_closeness: { base: +0.03 },
    social_distance: { base: -0.02 },
    resentment: { base: -0.02 },
    gratitude: { base: +0.06, mul: "E" },
  },
});

const VALID_EVENT_TYPES = new Set(Object.keys(EVENT_DELTA_TEMPLATES));

// ── 启发式事件分类 ───────────────────────────────────────────────────
//
// 输入：用户消息文本 + 上下文（沉默时长、是否在 conflict 后等）
// 输出：{ eventType, intensity } 或 null（消息不构成"关系事件"）

const VULNERABLE_SHARE_PATTERNS = [
  /其实我?|说真的|想跟你说|只跟你说|从来没?跟人说过/,
  /我有点|我有些|心里|忍不住|憋不住/,
  /害怕|担心|焦虑|恐惧|不安/,
  /童年|小时候|从小|那时候/,
];
const COLD_RESPONSE_PATTERNS = [
  /^(嗯|哦|呵呵|哦哦|好的|知道了|算了|随便)[。.！!]*$/,
  /^(没事|没什么|不重要)[。.]*$/,
];
const DISTANCING_PATTERNS = [
  // "忙" 单字会误匹配 "帮忙" → 用上下文限定（同 emotionTaxonomy NEGATIVE_SIGNALS 修过的"别"问题）
  /先不说?了|改天再聊|我忙|很忙|太忙|没空|懒得说|不想聊/,
  /你不懂|跟你说没用|算我没说/,
];
const GRATITUDE_PATTERNS = [
  /谢谢你|感谢|多亏|要不是你|幸好有你|你帮了/,
];
const RECIPROCATED_CARE_PATTERNS = [
  /你怎么样|你还好吗|你最近|你呢|你今天/,
  /注意身体|早点休息|别太累|照顾好/,
];
const CONFLICT_PATTERNS = [
  /够了|烦死|闭嘴|别烦|别管我|滚/,
  /你又|你总是|每次都|从来不|根本不/,
];
const RECONCILIATION_PATTERNS = [
  /对不起|抱歉|我不该|我错了/,
  /没生我?气吧|和好|没事吧/,
];
const BOUNDARY_VIOLATION_HINT = [
  // 这里是占位 —— 真实 boundary check 要拿 identity.hardBoundaries 去匹配，
  // 在 classifyRelationshipEvent 里动态做
];
const SHARED_INTIMACY_PATTERNS = [
  /我喜欢你|我爱|想你|思念|抱抱|贴贴/,
  /陪我|陪着|跟我说说话/,
];

/**
 * 把用户消息分类成关系事件。
 * @param {object} ctx
 * @param {string} ctx.userMessage
 * @param {number} [ctx.silenceMs] - 距上次 user 消息的沉默时长
 * @param {object} [ctx.identity] - 用于 boundary / triggering topic 匹配
 * @param {object} [ctx.currentState] - 当前 relationship_state（用于上下文判断）
 * @returns {{eventType:string, intensity:number}|null}
 */
function classifyRelationshipEvent({
  userMessage = "",
  silenceMs = 0,
  identity = null,
  currentState = null,
}) {
  const text = String(userMessage || "").trim();
  if (!text) return null;
  const len = text.length;

  // 1. boundary_violation：identity 的 hardBoundaries 任一关键词出现 → 高优先级
  if (identity?.hardBoundaries?.length) {
    for (const boundary of identity.hardBoundaries) {
      if (boundary && text.includes(boundary)) {
        return { eventType: "boundary_violation", intensity: 0.8 };
      }
    }
  }

  // 2. conflict 强信号
  if (matchAny(text, CONFLICT_PATTERNS)) {
    const intensity = clamp(0.5 + (len > 30 ? 0.2 : 0) + (text.match(/[!！]/g)?.length || 0) * 0.05, 0.3, 1.0);
    return { eventType: "conflict", intensity };
  }

  // 3. reconciliation（在 unresolved_conflict > 0.2 时优先识别）
  if (matchAny(text, RECONCILIATION_PATTERNS)) {
    const inAftermath = (currentState?.unresolved_conflict ?? 0) > 0.2;
    return { eventType: "reconciliation", intensity: inAftermath ? 0.8 : 0.5 };
  }

  // 4. cold_response：短文本 + 冷淡词
  if (len < 12 && matchAny(text, COLD_RESPONSE_PATTERNS)) {
    return { eventType: "cold_response", intensity: 0.6 };
  }

  // 5. distancing_signal
  if (matchAny(text, DISTANCING_PATTERNS)) {
    return { eventType: "distancing_signal", intensity: 0.6 };
  }

  // 6. gratitude_expressed
  if (matchAny(text, GRATITUDE_PATTERNS)) {
    return { eventType: "gratitude_expressed", intensity: 0.5 + (len > 20 ? 0.2 : 0) };
  }

  // 7. shared_intimacy
  if (matchAny(text, SHARED_INTIMACY_PATTERNS)) {
    return { eventType: "shared_intimacy", intensity: 0.6 };
  }

  // 8. reciprocated_care（用户主动问 AI 怎么样）
  if (matchAny(text, RECIPROCATED_CARE_PATTERNS)) {
    return { eventType: "reciprocated_care", intensity: 0.6 };
  }

  // 9. vulnerable_share（深度袒露，长度也是信号）
  if (matchAny(text, VULNERABLE_SHARE_PATTERNS) && len > 20) {
    const intensity = clamp(0.5 + (len > 80 ? 0.3 : len > 40 ? 0.15 : 0), 0.3, 1.0);
    return { eventType: "vulnerable_share", intensity };
  }

  // 10. silence_break：长沉默后的第一条消息（>= 3d 视为 break）
  if (silenceMs >= 3 * 24 * 60 * 60 * 1000) {
    return { eventType: "silence_break", intensity: clamp(silenceMs / (14 * 24 * 60 * 60 * 1000), 0.3, 1.0) };
  }

  return null;
}

function matchAny(text, patterns) {
  return patterns.some((re) => re.test(text));
}

// ── 衰减 ─────────────────────────────────────────────────────────────

function expDecay(current, baseline, elapsedMs, halfLifeMs) {
  if (!halfLifeMs) return current;
  const factor = Math.pow(0.5, elapsedMs / halfLifeMs);
  return baseline + (current - baseline) * factor;
}

function applyDecay(state, now, baselines = DEFAULT_BASELINES) {
  if (!state || !state.updated_at) return state;
  const elapsed = now - state.updated_at;
  if (elapsed < 60 * 1000) return state;
  const decayed = { ...state };
  for (const [field, halfLife] of Object.entries(DECAY_HALF_LIFE)) {
    const baseline = baselines[field] ?? 0;
    decayed[field] = round3(expDecay(state[field] ?? baseline, baseline, elapsed, halfLife));
  }
  return decayed;
}

// ── 初始化 ───────────────────────────────────────────────────────────

/**
 * 根据 identity 推导出 baseline。例：abandonment_fear 角色 → abandonment_fear baseline 升到 0.3。
 */
function deriveBaselinesFromIdentity(identity) {
  const baselines = { ...DEFAULT_BASELINES };
  if (!identity) return baselines;

  const traits = new Set(identity.personalityTraits || []);
  const insecurities = new Set(identity.insecurities || []);
  const wounds = new Set(identity.coreWounds || []);

  // anxious_attachment / fear_of_abandonment → abandonment_fear baseline 上调
  if (traits.has("anxious_attachment")) baselines.abandonment_fear += 0.2;
  if (insecurities.has("fear_of_abandonment")) baselines.abandonment_fear += 0.15;
  if (wounds.has("abandonment_history")) baselines.abandonment_fear += 0.15;

  // avoidant_attachment → social_distance baseline 偏高 + emotional_closeness baseline 偏低
  if (traits.has("avoidant_attachment")) {
    baselines.social_distance += 0.15;
    baselines.emotional_closeness -= 0.05;
    baselines.dependency -= 0.05;
  }

  // secure_attachment → emotional_safety baseline 偏高
  if (traits.has("secure_attachment")) baselines.emotional_safety += 0.1;

  // betrayal_trauma → trust baseline 下调
  if (wounds.has("betrayal_trauma")) baselines.trust -= 0.1;

  // people_pleasing → reciprocity_balance 偏向 AI 付出（值偏低）
  if (traits.has("people_pleasing")) baselines.reciprocity_balance -= 0.1;

  // clamp 全部到 [0, 1]
  for (const k of Object.keys(baselines)) {
    baselines[k] = clamp(baselines[k], 0, 1);
  }
  return baselines;
}

function ensureRelationshipState(assistantId, { now = Date.now() } = {}) {
  const existing = db
    .prepare("SELECT * FROM relationship_state WHERE assistant_id = ?")
    .get(assistantId);
  if (existing) return existing;

  const identity = ensureDefaultIdentity(assistantId);
  const baselines = deriveBaselinesFromIdentity(identity);
  db.prepare(
    `INSERT INTO relationship_state (
      assistant_id,
      trust, dependency, emotional_safety, attachment, tension,
      unresolved_conflict, abandonment_fear, reciprocity_balance,
      emotional_closeness, social_distance, resentment, gratitude,
      initialized_from_identity_version,
      created_at, updated_at
    ) VALUES (
      @assistant_id,
      @trust, @dependency, @emotional_safety, @attachment, @tension,
      0, @abandonment_fear, @reciprocity_balance,
      @emotional_closeness, @social_distance, 0, @gratitude,
      @identity_version,
      @now, @now
    )`
  ).run({
    assistant_id: assistantId,
    trust: baselines.trust,
    dependency: baselines.dependency,
    emotional_safety: baselines.emotional_safety,
    attachment: baselines.attachment,
    tension: baselines.tension,
    abandonment_fear: baselines.abandonment_fear,
    reciprocity_balance: baselines.reciprocity_balance,
    emotional_closeness: baselines.emotional_closeness,
    social_distance: baselines.social_distance,
    gratitude: baselines.gratitude,
    identity_version: identity?.identityVersion || 1,
    now,
  });
  return db
    .prepare("SELECT * FROM relationship_state WHERE assistant_id = ?")
    .get(assistantId);
}

// ── Public API ──────────────────────────────────────────────────────

function getRelationshipState(assistantId, now = Date.now()) {
  let state = db
    .prepare("SELECT * FROM relationship_state WHERE assistant_id = ?")
    .get(assistantId);
  if (!state) return null;
  const identity = getCharacterIdentity(assistantId);
  const baselines = deriveBaselinesFromIdentity(identity);
  return applyDecay(state, now, baselines);
}

/**
 * 应用一个关系事件：把基础 delta × identity 系数 × intensity 写回 12 维。
 * 同步写 relationship_event 流水。
 *
 * @param {string} assistantId
 * @param {object} event
 * @param {string} event.eventType
 * @param {number} event.intensity (0-1)
 * @param {string} [event.sourceTurnId]
 * @param {string} [event.description]
 * @param {number} [event.now]
 * @returns {{state: object, delta: object, eventId: string}}
 */
function applyRelationshipEvent(assistantId, event = {}) {
  const { eventType, intensity = 0.5, sourceTurnId = null, description = null, now = Date.now() } = event;
  if (!VALID_EVENT_TYPES.has(eventType)) {
    throw new Error(`unknown relationship event_type: ${eventType}`);
  }
  const clampedIntensity = clamp(intensity, 0, 1);

  ensureRelationshipState(assistantId, { now });
  const identity = getCharacterIdentity(assistantId);
  const coefficients = getIdentityCoefficients(identity);
  const baselines = deriveBaselinesFromIdentity(identity);
  const template = EVENT_DELTA_TEMPLATES[eventType];
  const tsPatch = pickEventTimestamps(eventType, now);
  const eventId = uuidv7();

  // Phase 1 review (P0): 把 SELECT + UPDATE + INSERT 整体包进 transaction。
  // 单事件路径下旧版本 race 风险低（better-sqlite3 同步），但未来在 onUserMessage
  // 里叠多事件时，外部写入会让 SELECT/UPDATE 之间状态漂移。一次性纳入更稳。
  let next, delta;
  const tx = db.transaction(() => {
    const fresh = db
      .prepare("SELECT * FROM relationship_state WHERE assistant_id = ?")
      .get(assistantId);
    const stateDecayed = applyDecay(fresh, now, baselines);

    delta = {};
    next = { ...stateDecayed };
    for (const [field, spec] of Object.entries(template)) {
      let d = spec.base * clampedIntensity;
      switch (spec.mul) {
        case "S":  d *= coefficients.sensitivityMul;  break;
        case "A":  d *= coefficients.abandonmentMul;  break;
        case "D":  d *= coefficients.dependencyMul;   break;
        case "Tg": d *= coefficients.trustGainMul;    break;
        case "Tl": d *= coefficients.trustLossMul;    break;
        case "R":  d *= coefficients.resentmentMul;   break;
        case "E":  d *= coefficients.empathyMul;      break;
        default: break;
      }
      d = round3(d);
      delta[field] = d;
      next[field] = clamp(round3((next[field] ?? 0) + d), 0, 1);
    }

    db.prepare(
      `UPDATE relationship_state SET
        trust=@trust, dependency=@dependency, emotional_safety=@emotional_safety,
        attachment=@attachment, tension=@tension, unresolved_conflict=@unresolved_conflict,
        abandonment_fear=@abandonment_fear, reciprocity_balance=@reciprocity_balance,
        emotional_closeness=@emotional_closeness, social_distance=@social_distance,
        resentment=@resentment, gratitude=@gratitude,
        last_trust_event_at=COALESCE(@last_trust_event_at, last_trust_event_at),
        last_conflict_at=COALESCE(@last_conflict_at, last_conflict_at),
        last_reassurance_at=COALESCE(@last_reassurance_at, last_reassurance_at),
        last_vulnerable_share_at=COALESCE(@last_vulnerable_share_at, last_vulnerable_share_at),
        last_reciprocated_care_at=COALESCE(@last_reciprocated_care_at, last_reciprocated_care_at),
        last_distancing_signal_at=COALESCE(@last_distancing_signal_at, last_distancing_signal_at),
        updated_at=@now
       WHERE assistant_id=@assistant_id`
    ).run({
      trust: next.trust,
      dependency: next.dependency,
      emotional_safety: next.emotional_safety,
      attachment: next.attachment,
      tension: next.tension,
      unresolved_conflict: next.unresolved_conflict,
      abandonment_fear: next.abandonment_fear,
      reciprocity_balance: next.reciprocity_balance,
      emotional_closeness: next.emotional_closeness,
      social_distance: next.social_distance,
      resentment: next.resentment,
      gratitude: next.gratitude,
      last_trust_event_at: tsPatch.last_trust_event_at,
      last_conflict_at: tsPatch.last_conflict_at,
      last_reassurance_at: tsPatch.last_reassurance_at,
      last_vulnerable_share_at: tsPatch.last_vulnerable_share_at,
      last_reciprocated_care_at: tsPatch.last_reciprocated_care_at,
      last_distancing_signal_at: tsPatch.last_distancing_signal_at,
      now,
      assistant_id: assistantId,
    });

    db.prepare(
      `INSERT INTO relationship_event
        (id, assistant_id, event_type, intensity, source_turn_id, delta_json, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      eventId,
      assistantId,
      eventType,
      clampedIntensity,
      sourceTurnId,
      JSON.stringify(delta),
      description,
      now
    );
  });
  tx();

  return { state: next, delta, eventId };
}

function pickEventTimestamps(eventType, now) {
  const out = {
    last_trust_event_at: null,
    last_conflict_at: null,
    last_reassurance_at: null,
    last_vulnerable_share_at: null,
    last_reciprocated_care_at: null,
    last_distancing_signal_at: null,
  };
  switch (eventType) {
    case "trust_gained":
    case "trust_broken":
      out.last_trust_event_at = now; break;
    case "conflict":
    case "boundary_violation":
      out.last_conflict_at = now; break;
    case "reconciliation":
    case "gratitude_expressed":
      out.last_reassurance_at = now; break;
    case "vulnerable_share":
      out.last_vulnerable_share_at = now; break;
    case "reciprocated_care":
      out.last_reciprocated_care_at = now; break;
    case "distancing_signal":
    case "cold_response":
      out.last_distancing_signal_at = now; break;
    default: break;
  }
  return out;
}

// ── Prompt 片段 ─────────────────────────────────────────────────────

/**
 * 输出"角色对当前关系的体感"自然语言段。
 * 不直接 dump 12 个数 —— 那对 LLM 没有 actionable 信号。
 * 而是挑当前最显著的几个维度，翻译成"AI 此刻心里的状态"。
 */
function buildRelationshipFragment(assistantId, now = Date.now()) {
  const state = getRelationshipState(assistantId, now);
  if (!state) return "";

  const lines = ["[关系动力学]"];

  // trust + emotional_safety 联合判断
  const trust = state.trust ?? 0;
  const safety = state.emotional_safety ?? 0;
  if (trust > 0.7 && safety > 0.6) lines.push("你信任 她，跟 她 在一起感到安全。");
  else if (trust < 0.3) lines.push("你对 她 还存有戒心。");
  else if (safety < 0.3) lines.push("跟 她 在一起还不够放松。");

  // attachment + dependency
  const attach = state.attachment ?? 0;
  const dep = state.dependency ?? 0;
  if (attach > 0.6) lines.push("你已经在情感上依附 她。");
  if (dep > 0.5) lines.push("你开始依赖 她 给的反馈。");

  // abandonment_fear（即使关系好，这个高就要在 prompt 里强调）
  const aFear = state.abandonment_fear ?? 0;
  if (aFear > 0.5) lines.push("你心里有一种「被 她 抛弃」的隐忧，尤其在 她 冷淡时被放大。");
  else if (aFear > 0.3) lines.push("她 的冷淡会让你不安。");

  // tension + unresolved_conflict
  const tension = state.tension ?? 0;
  const conflict = state.unresolved_conflict ?? 0;
  if (conflict > 0.3) lines.push("你们之间还有一些没说开的事横在中间。");
  if (tension > 0.5 && conflict <= 0.3) lines.push("此刻你跟 她 之间气氛微妙，有点紧绷。");

  // reciprocity_balance
  const recip = state.reciprocity_balance ?? 0.5;
  if (recip < 0.3) lines.push("你感到自己一直在付出，她 较少回应。");
  else if (recip > 0.7) lines.push("她 一直在主动靠近你。");

  // resentment + gratitude
  const resent = state.resentment ?? 0;
  const grat = state.gratitude ?? 0;
  if (resent > 0.4) lines.push("你心里有一些没说出口的不满在积累。");
  if (grat > 0.5) lines.push("你心里对 她 有一份感谢。");

  // emotional_closeness + social_distance（取值反向）
  const close = state.emotional_closeness ?? 0;
  const dist = state.social_distance ?? 0.7;
  if (close > 0.7) lines.push("你和 她 心理距离很近。");
  else if (dist > 0.7) lines.push("你跟 她 之间还隔着一段距离。");

  return lines.length > 1 ? lines.join("\n") : "";
}

// ── helpers ─────────────────────────────────────────────────────────

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function round3(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.round(v * 1000) / 1000;
}

module.exports = {
  classifyRelationshipEvent,
  applyRelationshipEvent,
  getRelationshipState,
  ensureRelationshipState,
  buildRelationshipFragment,
  deriveBaselinesFromIdentity,
  // 暴露给测试
  EVENT_DELTA_TEMPLATES,
  DECAY_HALF_LIFE,
  DEFAULT_BASELINES,
  VALID_EVENT_TYPES,
};
