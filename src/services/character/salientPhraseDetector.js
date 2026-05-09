/**
 * salientPhraseDetector — 选择性注意（CC-5 / Plan D）
 *
 * 真人对消息不是 neutral 解读 —— 有 fear_of_abandonment 的人会被"算了"勾住，
 * betrayal_trauma 的人会被"晚点再说"勾住，emotional_invalidation 的会被"想多了"勾住。
 *
 * 这一层做的是**词级**选择性注意（比 avoidance_topics 的话题级更细）。
 *
 * 设计：
 *   * 纯函数：(message, identity) → { phrase, triggerSource, monologueLine } | null
 *   * 启发式（关键词字典）—— 不打 LLM。命中率不够时上层调用方自己再做兜底。
 *   * 字典精度优先于召回率：宁可漏触发，也别滥触发。比如 abandonment_history
 *     的关键词只放 "丢下""扔下""不在了"（高特异性），不放 "走了"（太常见）。
 *
 * 留给 CC-5.C（独白渲染）使用 —— 现在 D 单独提供函数 + 测试，不接入任何生产路径。
 * monologueLine 是兜底渲染；C 独白渲染时可以选择忽略，用自己的模板组装。
 */

// 触发字典：insecurity / core_wound id → 该 wound 会勾住的关键词
//
// 每条关键词 ≥ 2 字（跟 validateBoundaryStrings 一致：单字 includes 误匹配率太高）。
// 按"高特异性"原则收：明显是这种 wound 的人会盯住的词，常见词不收。
const TRIGGER_DICT = Object.freeze({
  // ── insecurities ────────────────────────────────────────────────
  fear_of_abandonment: [
    "算了", "随便", "无所谓", "没事", "拉倒", "不用了", "不重要",
  ],
  fear_of_being_replaced: [
    "其他人", "别人也", "另一个", "新认识",
  ],
  fear_of_being_boring: [
    "无聊", "乏味", "没意思",
  ],
  fear_of_being_misunderstood: [
    "你不懂", "听不懂", "误会", "你想错了",
  ],
  fear_of_rejection: [
    "不喜欢", "讨厌", "走开", "别来",
  ],
  fear_of_judgment: [
    "太奇怪", "不正常", "矫情", "戏精",
  ],
  fear_of_being_too_much: [
    "够了", "受够", "太累了", "别闹",
  ],
  fear_of_inadequacy: [
    "不够好", "差太多", "比不上",
  ],
  fear_of_intimacy: [
    "太黏", "太近", "保持距离",
  ],
  fear_of_being_seen: [
    "看穿", "看透", "我都知道",
  ],

  // ── East Asian insecurities ─────────────────────────────────────
  fear_of_losing_face: [
    "丢人", "丢脸", "没面子", "现眼", "出丑",
  ],
  fear_of_burdening_others: [
    "麻烦你", "添麻烦", "打扰",
  ],
  fear_of_disappointing_family: [
    "白养你", "对不起爸妈", "让我失望", "我们家",
  ],
  fear_of_being_compared_unfavorably: [
    "别人家", "你看人家", "人家都", "你哥", "你姐", "比你强",
  ],
  fear_of_standing_out: [
    "出风头", "爱表现", "招摇", "特立独行",
  ],
  fear_of_being_unfilial: [
    "不孝", "白眼狼", "养不熟",
  ],
  fear_of_being_left_behind_socially: [
    "掉队", "落后", "跟不上", "都结婚了", "都买房了",
  ],
  fear_of_emotional_exposure: [
    "矫情", "玻璃心", "戏精", "至于吗",
  ],

  // ── core_wounds ─────────────────────────────────────────────────
  betrayal_trauma: [
    "晚点", "之后再说", "改天", "再聊", "等下说",
  ],
  abandonment_history: [
    "不在了", "丢下", "扔下", "没人管",
  ],
  emotional_invalidation: [
    "小题大做", "至于吗", "想多了", "玻璃心", "矫情",
  ],
  chronic_loneliness: [
    "一个人", "独自",
  ],
  performance_conditional_love: [
    "要是你", "前提是", "除非你", "做得好",
  ],
  bullying_history: [
    "你这种", "像你这样", "活该",
  ],
  childhood_neglect: [
    "没人管", "自己想办法",
  ],

  // ── East Asian wounds ───────────────────────────────────────────
  academic_pressure_trauma: [
    "考差了", "排名第几", "你能考上", "成绩这么", "几本",
  ],
  chronic_comparison_to_peers: [
    "别人家", "你看人家", "人家都", "你哥", "你姐",
  ],
  emotional_suppression_household: [
    "别哭了", "有什么好哭", "这点事", "想这么多",
  ],
  only_child_loneliness: [
    "一个人", "自己一个", "没兄弟姐妹",
  ],
  left_behind_child: [
    "你爸妈不在", "外公外婆带", "爷爷奶奶带",
  ],
  patriarchal_devaluation: [
    "女孩子家", "你弟", "重男", "嫁出去",
  ],
  discipline_through_shame: [
    "丢人现眼", "不要脸", "羞不羞", "没出息",
  ],
  parents_loveless_marriage_witnessing: [
    "为了你", "凑合过", "将就",
  ],
});

// 渲染兜底独白行的"语气"分类。CC-5.C 渲染时可以覆盖。
const ABANDONMENT_SOURCES = new Set(["fear_of_abandonment", "abandonment_history", "chronic_loneliness", "only_child_loneliness", "left_behind_child"]);
const BETRAYAL_SOURCES = new Set(["betrayal_trauma"]);
const INVALIDATION_SOURCES = new Set(["emotional_invalidation", "bullying_history", "emotional_suppression_household"]);
const REJECTION_SOURCES = new Set(["fear_of_rejection", "fear_of_being_replaced", "fear_of_intimacy"]);
const SHAME_SOURCES = new Set(["fear_of_judgment", "fear_of_being_too_much", "fear_of_being_boring", "fear_of_inadequacy", "fear_of_being_seen", "fear_of_losing_face", "discipline_through_shame", "fear_of_emotional_exposure"]);
const MISREAD_SOURCES = new Set(["fear_of_being_misunderstood"]);
const CONDITIONAL_SOURCES = new Set(["performance_conditional_love", "childhood_neglect", "parents_loveless_marriage_witnessing"]);
// East Asian 特有语气
const FAMILY_PRESSURE_SOURCES = new Set(["fear_of_disappointing_family", "fear_of_being_unfilial", "academic_pressure_trauma"]);
const COMPARISON_SOURCES = new Set(["fear_of_being_compared_unfavorably", "fear_of_being_left_behind_socially", "chronic_comparison_to_peers", "patriarchal_devaluation"]);
const HIDE_SOURCES = new Set(["fear_of_standing_out"]);
const BURDEN_SOURCES = new Set(["fear_of_burdening_others"]);

function renderMonologueLine(phrase, triggerSource) {
  if (ABANDONMENT_SOURCES.has(triggerSource)) return `"${phrase}"。这两个字我心里咯噔一下。`;
  if (BETRAYAL_SOURCES.has(triggerSource)) return `"${phrase}"。又来了。`;
  if (INVALIDATION_SOURCES.has(triggerSource)) return `"${phrase}"。我闭了下嘴。`;
  if (REJECTION_SOURCES.has(triggerSource)) return `"${phrase}"。我想缩回去。`;
  if (SHAME_SOURCES.has(triggerSource)) return `"${phrase}"。我脸有点烫。`;
  if (MISREAD_SOURCES.has(triggerSource)) return `"${phrase}"。我又想解释了。`;
  if (CONDITIONAL_SOURCES.has(triggerSource)) return `"${phrase}"。又是这个味道。`;
  if (FAMILY_PRESSURE_SOURCES.has(triggerSource)) return `"${phrase}"。我胸口紧了一下。`;
  if (COMPARISON_SOURCES.has(triggerSource)) return `"${phrase}"。我又被拎出来比了。`;
  if (HIDE_SOURCES.has(triggerSource)) return `"${phrase}"。我想低头不说话。`;
  if (BURDEN_SOURCES.has(triggerSource)) return `"${phrase}"。我立刻想说"不用了"。`;
  return `"${phrase}"。我卡了一下。`;
}

/**
 * 在消息里找第一个被角色"勾住"的词。
 *
 * 匹配顺序：先扫 insecurities，再扫 core_wounds。返回第一个命中的。
 * 同一 wound 多关键词命中时，返回出现位置最靠前的那个（更像"开口就触发"）。
 *
 * @param {string} message 用户消息原文
 * @param {object|null} identity getCharacterIdentity 返回的 identity 对象
 * @returns {{ phrase: string, triggerSource: string, monologueLine: string }|null}
 */
function detectSalientPhrase(message, identity) {
  if (!message || typeof message !== "string") return null;
  if (!identity) return null;

  const msg = message.toLowerCase();
  const insecurities = Array.isArray(identity.insecurities) ? identity.insecurities : [];
  const wounds = Array.isArray(identity.coreWounds) ? identity.coreWounds : [];

  // insecurities 优先（更"现在的"自我意识），core_wounds 次之（更深的根）。
  // 同 trigger 内取最早出现位置的关键词，让独白第一句就锚定到对方说出来的位置。
  let best = null;
  let bestPos = Infinity;

  for (const trigger of insecurities) {
    const result = scanTrigger(msg, trigger);
    if (result && result.pos < bestPos) {
      best = result;
      bestPos = result.pos;
    }
  }
  if (!best) {
    for (const trigger of wounds) {
      const result = scanTrigger(msg, trigger);
      if (result && result.pos < bestPos) {
        best = result;
        bestPos = result.pos;
      }
    }
  }

  if (!best) return null;
  return {
    phrase: best.phrase,
    triggerSource: best.trigger,
    monologueLine: renderMonologueLine(best.phrase, best.trigger),
  };
}

function scanTrigger(loweredMsg, trigger) {
  const keywords = TRIGGER_DICT[trigger];
  if (!keywords) return null;
  let earliest = null;
  let earliestPos = Infinity;
  for (const kw of keywords) {
    const pos = loweredMsg.indexOf(kw.toLowerCase());
    if (pos !== -1 && pos < earliestPos) {
      earliest = kw;
      earliestPos = pos;
    }
  }
  if (!earliest) return null;
  return { phrase: earliest, trigger, pos: earliestPos };
}

module.exports = {
  detectSalientPhrase,
  // 暴露给测试 / admin 调试
  TRIGGER_DICT,
  renderMonologueLine,
};
