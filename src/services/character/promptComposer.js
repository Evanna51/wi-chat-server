/**
 * promptComposer — Phase 1a 落地：chat family 的结构化 prompt slot 渲染。
 *
 * 目的：把 V_NEW_LEAN（XML envelope + 内层 JSON）渲染成 8 个 slot，给客户端按
 * canonical 顺序拼接成最终 system prompt。客户端在 <narrative> 后、<tool_protocol>
 * 前插入自己的 <client> slot（当前时间 / locale / 用户自定义）。
 *
 * 与旧 `buildSystemSegment`（prose 描述堆叠）的区别：
 *   1. 字段精简：删 4 心理深度（insecurities/core_wounds/desires/tensions）+ 3 数值
 *      （emotional_sensitivity/empathy_level/expressiveness）。这些 deep 字段已通过
 *      server introspection 链路 → reflection.summary → <narrative> slot 间接传递。
 *   2. JSON 化：<character> / <constraints> / <tool_protocol> / <narrative> 内部用
 *      JSON，让大模型按字段解析，不当 prose 扫读。
 *   3. 加 <facts> slot：之前完全没拼，导致 LLM 凭印象答（详见 [docs/api-redesign-plan.md]）。
 *   4. 加 <narrative> slot：reflection / episodes / topics 完整数据下放到客户端 LLM，
 *      不再压缩成 1 行独白片段后丢失全部上下文。
 *
 * 不含的字段（chat 不需要）：dynamics 数值、socialMode 选择、attention_window_1h（TODO-2）。
 *
 * Phase 1b 会新增 `composeForIntrospection` 给 server 内部 6 个 service（reflection /
 * episode / catchup / proactive / classify / decision）共用同一套 building blocks，
 * 但走 markdown 风格、保留全字段。本文件目前只实现 composeForChat。
 *
 * 见 docs/api-redesign-plan.md §2.5 / §3.8。
 */

const { parsePronouns } = require("./identityVocab");

// ── inline helpers（避免与 characterContextBuilder 循环依赖） ─────────
//
// 与 characterContextBuilder.js 里的同名函数行为一致。Phase 1b 时如果
// composeForIntrospection 也用，再考虑抽到独立 helpers 文件。
const SUBJECT_CONTRACTIONS = { she: "She's", he: "He's", they: "They're" };

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderRoleDirective(pronouns) {
  const obj = pronouns.object;
  return `You are ${obj}. Speak as ${obj}, not about ${obj}.`;
}

function renderVoiceAnchor(pronouns) {
  const { subject, possessive } = pronouns;
  const subjContr = SUBJECT_CONTRACTIONS[subject] || `${capitalize(subject)} is`;
  return (
    `${subjContr} mid-conversation, not on stage. Fragments, silences, and contradictions are natural.\n` +
    `Use ${possessive} skills the way ${subject} would.`
  );
}

// ── 限额 ─────────────────────────────────────────────────────────────
//
// Chat family 在 token 预算约束下：单个 slot 软上限避免 LLM 注意力被淹。
// background 是 lore prose 占大头，给最多预算；其它字段都是结构化短数据。
const SLOT_SOFT_LIMITS = Object.freeze({
  background: 1500,         // lore prose
  facts: 600,
  narrative: 800,
  // 其它 slot 字段固定，不会爆
});

const NARRATIVE_REFLECTION_SUMMARY_CAP = 200;
const NARRATIVE_EPISODES_LIMIT = 3;
const NARRATIVE_EPISODE_SUMMARY_CAP = 100;
const NARRATIVE_TOPICS_LIMIT = 5;

// ── 主入口 ───────────────────────────────────────────────────────────

/**
 * 渲染 chat family 的 system prompt slot 集合。
 *
 * @param {object} args
 * @param {object} args.profile          assistant_profile row
 * @param {object} args.identity         character_identity（decoded camelCase）。可为 null
 * @param {Array}  [args.coreFacts]      pinned 关键事实 [{ content, importance, ... }]
 * @param {Array}  [args.retrievedMemories]  retrieved 记忆 [{ content, score, createdAt, ... }]
 * @param {object} [args.recentReflection]   fresh reflection（freshReflection 入参，14d 内）
 * @param {Array}  [args.activeEpisodes]     近期 unresolved episode（已 filter，最多 3 条）
 * @param {Array}  [args.activeTopics]       active topics（最多 5 条）
 * @param {object} [args.salientPhrase]      可选，UI 高亮 + 独白用
 * @param {string} [args.prefill]            assistantPrefill 现成段（buildUserMonologue 的输出）
 * @returns {{ slots: object, mergedSystem: string, assistantPrefill: string }}
 */
function composeForChat({
  profile,
  identity,
  coreFacts = [],
  retrievedMemories = [],
  recentReflection = null,
  activeEpisodes = [],
  activeTopics = [],
  salientPhrase = null,
  prefill = "",
} = {}) {
  if (!profile) {
    throw new Error("composeForChat: profile required");
  }

  const pronouns = parsePronouns(identity ? identity.pronouns : "");

  const slots = {
    role: renderRoleSlot({ pronouns }),
    character: renderCharacterSlot({ profile, identity, pronouns }),
    background: renderBackgroundSlot({ profile }),
    constraints: renderConstraintsSlot({ identity }),
    facts: renderFactsSlot({ coreFacts, retrievedMemories }),
    narrative: renderNarrativeSlot({
      recentReflection,
      activeEpisodes,
      activeTopics,
      salientPhrase,
    }),
    tool_protocol: renderToolProtocolSlot(),
  };

  // mergedSystem: server 端拼接好的完整 system prompt（不含 <client> slot —— 那是
  // 客户端在 <narrative> 后、<tool_protocol> 前自己插入）。给 server-internal caller
  // 或不需要 <client> slot 的客户端直接用。
  const mergedSystem = mergeSlots(slots, prefill);

  return {
    slots,
    mergedSystem,
    assistantPrefill: prefill || "",
  };
}

/**
 * 按 canonical 顺序拼接 server slots（不含 client slot）+ assistantPrefill。
 * 客户端实现 merge 协议时**必须**在 narrative 后、tool_protocol 前插 <client>。
 */
function mergeSlots(slots, prefill = "") {
  const order = [
    slots.role,
    slots.character,
    slots.background,
    slots.constraints,
    slots.facts,
    slots.narrative,
    slots.tool_protocol,
  ];
  const sys = order.filter(Boolean).join("\n\n");
  return prefill ? `${sys}\n\n${prefill}` : sys;
}

// ── slot 渲染 ────────────────────────────────────────────────────────

/**
 * <role> = role directive（立场） + voice anchor（语气锚定）。
 * 合并是因为 V_NEW 里没单独的 <voice> slot —— role 段同时承担"你是谁"+"怎么说话"。
 * 旧 buildSystemSegment 把 voice 单独放末尾 utilizes recency bias，但 V_NEW 把
 * <tool_protocol> 占了那个位置（产品决策：tool calling 决策更需要 recency 加权）。
 */
function renderRoleSlot({ pronouns }) {
  return [
    "<role>",
    renderRoleDirective(pronouns),
    renderVoiceAnchor(pronouns),
    "</role>",
  ].join("\n");
}

/**
 * <character> JSON — V_NEW_LEAN 字段集（精简版）。
 *
 * 包含：身份基线 + 表达层（speaking_style + skills）+ 价值观。
 * 删除：心理深度（insecurities/core_wounds/desires/tensions）→ 已通过 reflection 链路
 *       间接传递；数值字段 → LLM 不直接消费数值。
 */
function renderCharacterSlot({ profile, identity, pronouns }) {
  const charObj = {
    name: profile.character_name || null,
  };

  if (identity) {
    if (identity.pronouns) charObj.pronouns = identity.pronouns;
    if (identity.age_years || identity.ageYears) {
      charObj.age = identity.age_years ?? identity.ageYears;
    }
    if (identity.gender_expression || identity.genderExpression) {
      charObj.gender_expression = identity.gender_expression ?? identity.genderExpression;
    }
    if (identity.speaking_style || identity.speakingStyle) {
      charObj.speaking_style = identity.speaking_style ?? identity.speakingStyle;
    }
    if (identity.worldview) charObj.worldview = identity.worldview;

    const traits = identity.personality_traits ?? identity.personalityTraits ?? [];
    if (Array.isArray(traits) && traits.length) {
      charObj.personality_traits = traits;
    }

    if (identity.attachment_style || identity.attachmentStyle) {
      charObj.attachment_style = identity.attachment_style ?? identity.attachmentStyle;
    }

    const values = identity.values ?? [];
    if (Array.isArray(values) && values.length) {
      charObj.values = values;
    }

    const careLangs = identity.care_languages ?? identity.careLanguages ?? null;
    if (careLangs && (careLangs.give?.length || careLangs.receive?.length)) {
      charObj.care_languages = careLangs;
    }

    // skills 单独处理 — 接受 string[] 或 [{name, examples}] 混合形态
    const skills = identity.skills ?? [];
    if (Array.isArray(skills) && skills.length) {
      charObj.skills = skills;
    }
  } else {
    // identity 缺失时，pronouns 至少给一个默认（让 voice anchor 不空）
    charObj.pronouns = "they/them";
  }

  return wrapXmlJson("character", charObj);
}

/**
 * <background> — lore prose（自由文本，不 JSON 化）。
 *
 * Phase 3：优先用 profile.lore（LLM 提炼后的净化叙事段，identity 字段已剥离），
 * fallback 到 character_background（提炼未跑完 / 失败时）。fallback 路径仍剥末尾
 * "系统提示"段（那是 rule，不是 lore）。
 */
function renderBackgroundSlot({ profile }) {
  const lore = (profile.lore || "").trim();
  let body;
  if (lore) {
    body = lore;
  } else {
    const bg = profile.character_background || "";
    body = bg.replace(/系统提示[\s\S]*$/, "").trim();
  }
  if (!body) {
    return `<background>\n(no background lore)\n</background>`;
  }
  if (body.length > SLOT_SOFT_LIMITS.background) {
    body = body.slice(0, SLOT_SOFT_LIMITS.background - 3) + "...";
  }
  return `<background>\n${body}\n</background>`;
}

/**
 * <constraints> JSON — 硬/软边界 + 回避/触发话题。
 */
function renderConstraintsSlot({ identity }) {
  const obj = {};
  if (identity) {
    const hb = identity.hard_boundaries ?? identity.hardBoundaries ?? [];
    const sb = identity.soft_boundaries ?? identity.softBoundaries ?? [];
    const av = identity.avoidance_topics ?? identity.avoidanceTopics ?? [];
    const tg = identity.triggering_topics ?? identity.triggeringTopics ?? [];
    if (hb.length) obj.hard_boundaries = hb;
    if (sb.length) obj.soft_boundaries = sb;
    if (av.length) obj.avoidance_topics = av;
    if (tg.length) obj.triggering_topics = tg;
  }
  return wrapXmlJson("constraints", obj);
}

/**
 * <facts> — coreFacts + retrievedMemories。
 *
 * 客户端的"可信事实层"。retrievedMemories 来自当前 query 的语义检索；coreFacts
 * 是 pinned（is_pinned=1）每轮都注入。
 *
 * 渲染成简单 markdown bullet 列表（JSON 表达事实数组反而费 token + 不好读）。
 */
function renderFactsSlot({ coreFacts, retrievedMemories }) {
  const lines = [];

  if (Array.isArray(coreFacts) && coreFacts.length) {
    lines.push("[关键事实 / pinned]");
    for (const f of coreFacts) {
      const text = f.content || f.text || "";
      if (text) lines.push(`- ${text}`);
    }
  }

  if (Array.isArray(retrievedMemories) && retrievedMemories.length) {
    if (lines.length) lines.push("");
    lines.push("[本轮检索]");
    for (const m of retrievedMemories) {
      const text = m.content || m.text || "";
      if (text) lines.push(`- ${text}`);
    }
  }

  if (!lines.length) {
    return `<facts>\n(no facts retrieved for this turn)\n</facts>`;
  }

  let body = lines.join("\n");
  if (body.length > SLOT_SOFT_LIMITS.facts) {
    body = body.slice(0, SLOT_SOFT_LIMITS.facts - 3) + "...";
  }
  return `<facts>\n${body}\n</facts>`;
}

/**
 * <narrative> JSON — 角色主观叙事。
 *
 * 三类数据：reflection（最新 1 条 fresh） / episodes（top 3 unresolved） /
 * topics（top 5 active）。salient phrase 也放这里（不再单独段）。
 *
 * attention_window_1h 暂不实现，见 docs/api-redesign-plan.md 附录 B TODO-2。
 */
function renderNarrativeSlot({
  recentReflection,
  activeEpisodes,
  activeTopics,
  salientPhrase,
}) {
  const obj = {};

  if (recentReflection && recentReflection.summary) {
    const sum = clip(recentReflection.summary, NARRATIVE_REFLECTION_SUMMARY_CAP);
    obj.recent_reflection = {
      summary: sum,
    };
    if (recentReflection.relationshipDirection) {
      obj.recent_reflection.direction = recentReflection.relationshipDirection;
    }
    if (recentReflection.userNeeds?.length) {
      obj.recent_reflection.user_needs = recentReflection.userNeeds;
    }
    if (recentReflection.concerns?.length) {
      obj.recent_reflection.concerns = recentReflection.concerns;
    }
    if (recentReflection.opportunities?.length) {
      obj.recent_reflection.opportunities = recentReflection.opportunities;
    }
  }

  if (Array.isArray(activeEpisodes) && activeEpisodes.length) {
    obj.active_episodes = activeEpisodes
      .slice(0, NARRATIVE_EPISODES_LIMIT)
      .map((e) => {
        const out = { title: e.title };
        if (e.summary) out.summary = clip(e.summary, NARRATIVE_EPISODE_SUMMARY_CAP);
        if (e.emotionalTone) out.emotional_tone = e.emotionalTone;
        if (e.unresolvedThreads?.length) out.unresolved_threads = e.unresolvedThreads;
        if (typeof e.importance === "number") out.importance = e.importance;
        return out;
      });
  }

  if (Array.isArray(activeTopics) && activeTopics.length) {
    obj.active_topics = activeTopics
      .slice(0, NARRATIVE_TOPICS_LIMIT)
      .map((t) => {
        const out = { topic: t.topic, status: t.status };
        if (t.emotionalAssociation) out.emotional_association = t.emotionalAssociation;
        if (t.lastDiscussedAt) out.last_discussed_at = t.lastDiscussedAt;
        return out;
      });
  }

  if (salientPhrase && salientPhrase.phrase) {
    obj.salient_phrase = {
      phrase: salientPhrase.phrase,
    };
    if (salientPhrase.triggerSource) {
      obj.salient_phrase.trigger_source = salientPhrase.triggerSource;
    }
  }

  if (Object.keys(obj).length === 0) {
    return `<narrative>\n(no narrative context)\n</narrative>`;
  }

  let body = JSON.stringify(obj, null, 2);
  if (body.length > SLOT_SOFT_LIMITS.narrative) {
    // 不强切 JSON 结构（破坏会失败解析）；只 warn，让上游降低 limit 或 producer 收紧
    console.warn(
      `[promptComposer] narrative slot ${body.length} chars > soft limit ${SLOT_SOFT_LIMITS.narrative}. ` +
      `检查 episodes / topics 数量或 summary cap。`
    );
  }
  return `<narrative>\n${body}\n</narrative>`;
}

/**
 * <tool_protocol> JSON — 工具调用协议。
 *
 * 包含：
 *   - always_emit_content_with_tool_call: 提示模型不要 tool_call only（虽然不能 100% 强制，
 *     prompt 工程能让命中率从 19% → 37%；剩余靠客户端 SDK fallback UI 占位）
 *   - search_memory tool 的简要 hint（详细描述放在 tool definition 的 description 字段，
 *     由客户端 SDK 在调 LLM 时附 tools 数组）
 *
 * 见 ab-prompt-test 报告 + docs/api-redesign-plan.md §4。
 */
function renderToolProtocolSlot() {
  const obj = {
    always_emit_content_with_tool_call: true,
    content_when_calling_tool:
      "1-2 short sentences in character voice; acknowledge the search action; do NOT preview the answer",
    tools: {
      search_memory: {
        purpose: "Retrieve user context from shared conversation history",
        trigger_must: {
          time_words: [
            "上次", "之前", "还记得", "那时", "前几天", "上周", "上周末",
            "最近", "以前", "曾经", "当时", "那次", "有次",
          ],
          recall_words: ["你记得吗", "还记得", "想起", "提过", "聊过", "说过", "告诉过"],
        },
        trigger_should: "user references a person/place/event by name that may have prior context",
        skip_when: ["greetings", "character_setting_questions", "hypothetical_future"],
        cost_model: "false_positive_cheap; false_negative_expensive; when_uncertain_call",
        default_source: "user",
      },
    },
  };
  return wrapXmlJson("tool_protocol", obj);
}

// ── Introspection family building blocks (Phase 1b) ─────────────────
//
// 给 server 内部 6 个 LLM-using service 共享的 building blocks。
//
// 范围说明：
//   - 4 个 service 用 character_background（episodeBuilder / catchupService /
//     proactivePlanService 的 plan + next_push） → 共享 renderBackgroundForIntrospection
//   - reflectionService 的 identitySummary 是 1 行紧凑独立形态，差异化大、风险
//     大于收益 → 保留 service-local，暂不收编
//   - memoryClassificationService / memoryDecisionService 不用角色字段（纯 NLP
//     task） → 不参与收编
//
// 见 docs/api-redesign-plan.md §3.8 + §6 Phase 1b。

/**
 * 与 4 个 service 内自定义 clipText 行为一致（strip whitespace + trim + ASCII "..."），
 * 暴露出来作为统一工具。各 service 后续可以逐步切换到这个版本，或保留自己的 inline
 * 定义都行 —— 行为一致，不影响 LLM 输出。
 */
function clipText(input, maxLen) {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

/**
 * Introspection 端的 character_background 渲染 building block。
 * 替代 4 个 service 里重复的 `clipText(characterBackground || "无", N)` 模式。
 *
 * 默认行为与现有 4 个 service 一致（不剥"系统提示"段、保留 LLM 输出 stability）。
 * 设 stripSystemHints=true 才剥（chat 端走这个；task C 完成后 introspection 也可切换）。
 *
 * @param {string} characterBackground  原始 background string
 * @param {number} maxChars             截断长度
 * @param {object} [opts]
 * @param {string} [opts.fallback="无"]
 * @param {boolean} [opts.stripSystemHints=false]
 */
function renderBackgroundForIntrospection(characterBackground, maxChars, opts = {}) {
  const { fallback = "无", stripSystemHints = false } = opts;
  let bg = String(characterBackground || "");
  if (stripSystemHints) {
    bg = bg.replace(/系统提示[\s\S]*$/, "").trim();
  }
  if (!bg.trim()) return fallback;
  return clipText(bg, maxChars);
}

// ── helpers ──────────────────────────────────────────────────────────

function wrapXmlJson(tag, obj) {
  if (!obj || (typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).length === 0)) {
    return `<${tag}>\n{}\n</${tag}>`;
  }
  return `<${tag}>\n${JSON.stringify(obj, null, 2)}\n</${tag}>`;
}

function clip(s, n) {
  if (!s) return "";
  const str = String(s);
  return str.length <= n ? str : str.slice(0, n - 1) + "…";
}

module.exports = {
  composeForChat,
  // chat building blocks
  renderRoleSlot,
  renderCharacterSlot,
  renderBackgroundSlot,
  renderConstraintsSlot,
  renderFactsSlot,
  renderNarrativeSlot,
  renderToolProtocolSlot,
  mergeSlots,
  // introspection building blocks (Phase 1b)
  clipText,
  renderBackgroundForIntrospection,
  // 常量
  SLOT_SOFT_LIMITS,
};
