/**
 * promptComposer — V3 register-aware 渲染。
 *
 * V3 chat hot path（POST /api/chat/context）走 router 决策 → composeForChatV3。
 * Boot / admin / debug 路径（GET /api/character/:id, POST /api/character/context）
 * 走 composeForChatV3Default（layers 全开 + skill ids 从 identity 抽前 2 个）。
 *
 * V3 slot 集合（canonical 顺序）：
 *   <role> <style> <voice_skills> <background> <constraints>
 *   <attention_1h> <narrative> <facts> <tool_protocol> <avoid>
 *
 * 字段格式：所有 slot 都是中文 markdown key:value（不再有 JSON.stringify dump）。
 * 长度限制：facts ≤ 600 / narrative ≤ 800（带 drop-priority truncation）/
 *          background ≤ 300（默认）或 ≤ 1200（lore_background=2 RP 模式）。
 *
 * V_NEW_LEAN composeForChat / mergeSlots / 旧 render*Slot 已删除（2026-05-10）。
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

const NARRATIVE_REFLECTION_SUMMARY_CAP = 180;
const NARRATIVE_EPISODES_LIMIT = 3;
const NARRATIVE_EPISODE_SUMMARY_CAP = 80;
const NARRATIVE_TOPICS_LIMIT = 4;
// 数组字段（user_needs / concerns / opportunities / unresolved_threads）每项的字符上限，
// 以及最多保留几项 — 之前完全没限，是 1655 chars 超 800 hard cap 的主因。
const NARRATIVE_ARRAY_ITEM_CAP = 50;
const NARRATIVE_ARRAY_LEN = 3;

// ── 共享 slot 渲染（V3 也用）────────────────────────────────────────

/**
 * <facts> — coreFacts + retrievedMemories。
 *
 * 客户端的"可信事实层"。retrievedMemories 来自当前 query 的语义检索；coreFacts
 * 是 pinned（is_pinned=1）每轮都注入。
 *
 * 渲染成简单 markdown bullet 列表（JSON 表达事实数组反而费 token + 不好读）。
 */
// 2026-05-24: facts / retrieved 加"几天前知道的"注释 —— 仅当 createdAt > 14 天才标，
// 避免常态噪声。让 LLM 知道哪些事实是新的、哪些是陈年的（影响时间表达 + 是否引用）。
const FACT_AGE_LABEL_MIN_DAYS = 14;
function _factAgeSuffix(createdAt, now = Date.now()) {
  if (!createdAt) return "";
  const days = Math.floor((now - createdAt) / 86400000);
  if (days < FACT_AGE_LABEL_MIN_DAYS) return "";
  if (days < 30) return `（${days} 天前知道的）`;
  if (days < 365) return `（${Math.floor(days / 30)} 个月前知道的）`;
  return `（${Math.floor(days / 365)} 年前知道的）`;
}

function renderFactsSlot({ coreFacts, retrievedMemories, now = Date.now() }) {
  const lines = [];

  if (Array.isArray(coreFacts) && coreFacts.length) {
    lines.push("[关键事实 / pinned]");
    for (const f of coreFacts) {
      // 两种来源的 shape 不同：
      //   - getCoreFacts（memory_facts 表）→ { factKey, factValue, confidence, importance, ... }
      //   - getCoreMemories（pinned memory_items）→ { content, memoryType, ... }
      // 优先按 fact_key=value 渲染（结构化更易于 LLM 识别），fallback 到 content 自由文本。
      const factKey = f.factKey || f.fact_key;
      const factValue = f.factValue || f.fact_value;
      const ageSuffix = _factAgeSuffix(f.createdAt || f.created_at, now);
      if (factKey && factValue) {
        lines.push(`- ${factKey}: ${factValue}${ageSuffix}`);
        continue;
      }
      const text = f.content || f.text || "";
      if (text) lines.push(`- ${text}${ageSuffix}`);
    }
  }

  if (Array.isArray(retrievedMemories) && retrievedMemories.length) {
    if (lines.length) lines.push("");
    lines.push("[本轮检索]");
    for (const m of retrievedMemories) {
      const text = m.content || m.text || "";
      if (!text) continue;
      const ageSuffix = _factAgeSuffix(m.createdAt || m.created_at, now);
      lines.push(`- ${text}${ageSuffix}`);
    }
  }

  // 2026-05-10: 空时返回空字符串，让上层 join 时自然跳过 — 不再输出 "(no facts retrieved)" 占位
  if (!lines.length) return "";

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
// 数组字段截断 helper：取前 N 条，每条 clip 到 cap。
function clipArray(arr, len, cap) {
  if (!Array.isArray(arr)) return [];
  return arr
    .slice(0, len)
    .map((s) => (typeof s === "string" ? clip(s, cap) : s))
    .filter(Boolean);
}

// 优先级丢弃：narrative obj 仍然超 budget 时按这个顺序逐个剔除字段，
// 直到 JSON.stringify 结果 ≤ budget。最不重要在最前。
const NARRATIVE_DROP_ORDER = [
  // 路径数组：[topLevelKey, subKey?] — 沿着对象按键删
  // 原则：原始素材先丢，合成洞察后丢；reflection.direction（关系走向）最后丢。
  ["salient_phrase"],               // 零散短语，最不重要
  ["active_topics"],                // 话题列表（episodes 里有上下文，丢 topics 影响有限）
  ["active_episodes"],              // 原始事件碎片，比反思结论次要
  ["recent_reflection", "opportunities"],  // 反思-机会（nice-to-have）
  ["recent_reflection", "user_needs"],     // 反思-用户需求
  ["recent_reflection", "concerns"],       // 反思-担忧（重要但仍在 direction 之前）
  ["recent_reflection", "direction"],      // 关系走向，最核心的合成结论，最后丢
];

function dropAtPath(obj, path) {
  if (path.length === 1) {
    delete obj[path[0]];
  } else if (obj[path[0]]) {
    delete obj[path[0]][path[1]];
    if (obj[path[0]] && Object.keys(obj[path[0]]).length === 0) {
      delete obj[path[0]];
    }
  }
}

function renderNarrativeSlot({
  recentReflection,
  activeEpisodes,
  activeTopics,
  salientPhrase,
}) {
  // 内部仍用 obj 跟踪存在哪些字段（drop logic 需要），最后再渲染成 markdown
  const obj = {};

  if (recentReflection && recentReflection.summary) {
    const sum = clip(recentReflection.summary, NARRATIVE_REFLECTION_SUMMARY_CAP);
    obj.recent_reflection = { summary: sum };
    if (recentReflection.relationshipDirection) {
      obj.recent_reflection.direction = recentReflection.relationshipDirection;
    }
    const userNeeds = clipArray(recentReflection.userNeeds, NARRATIVE_ARRAY_LEN, NARRATIVE_ARRAY_ITEM_CAP);
    if (userNeeds.length) obj.recent_reflection.user_needs = userNeeds;
    const concerns = clipArray(recentReflection.concerns, NARRATIVE_ARRAY_LEN, NARRATIVE_ARRAY_ITEM_CAP);
    if (concerns.length) obj.recent_reflection.concerns = concerns;
    const opportunities = clipArray(recentReflection.opportunities, NARRATIVE_ARRAY_LEN, NARRATIVE_ARRAY_ITEM_CAP);
    if (opportunities.length) obj.recent_reflection.opportunities = opportunities;
  }

  if (Array.isArray(activeEpisodes) && activeEpisodes.length) {
    obj.active_episodes = activeEpisodes
      .slice(0, NARRATIVE_EPISODES_LIMIT)
      .map((e) => {
        const out = { title: clip(e.title || "", 40) };
        if (e.summary) out.summary = clip(e.summary, NARRATIVE_EPISODE_SUMMARY_CAP);
        if (e.emotionalTone) out.emotional_tone = e.emotionalTone;
        const threads = clipArray(e.unresolvedThreads, NARRATIVE_ARRAY_LEN, NARRATIVE_ARRAY_ITEM_CAP);
        if (threads.length) out.unresolved_threads = threads;
        if (typeof e.importance === "number") out.importance = e.importance;
        return out;
      });
  }

  if (Array.isArray(activeTopics) && activeTopics.length) {
    obj.active_topics = activeTopics
      .slice(0, NARRATIVE_TOPICS_LIMIT)
      .map((t) => {
        const out = { topic: clip(t.topic || "", 30), status: t.status };
        if (t.emotionalAssociation) out.emotional_association = clip(t.emotionalAssociation, 40);
        return out;
      });
  }

  if (salientPhrase && salientPhrase.phrase) {
    obj.salient_phrase = { phrase: clip(salientPhrase.phrase, 40) };
    if (salientPhrase.triggerSource) {
      obj.salient_phrase.trigger_source = salientPhrase.triggerSource;
    }
  }

  if (Object.keys(obj).length === 0) {
    return `<narrative>\n(无叙事上下文)\n</narrative>`;
  }

  // 优先级丢弃 + markdown 渲染：先用 markdown 体积估算，超 budget 按 NARRATIVE_DROP_ORDER 砍。
  let body = _renderNarrativeMarkdown(obj);
  if (body.length > SLOT_SOFT_LIMITS.narrative) {
    for (const path of NARRATIVE_DROP_ORDER) {
      dropAtPath(obj, path);
      body = _renderNarrativeMarkdown(obj);
      if (body.length <= SLOT_SOFT_LIMITS.narrative) break;
    }
  }
  return `<narrative>\n${body}\n</narrative>`;
}

function _renderNarrativeMarkdown(obj) {
  const sections = [];

  if (obj.recent_reflection) {
    const r = obj.recent_reflection;
    const parts = [];
    if (r.summary) parts.push(r.summary);
    if (r.user_needs?.length) parts.push(`对方好像需要${r.user_needs.join("、")}`);
    if (r.concerns?.length) parts.push(`你有些担心${r.concerns.join("、")}`);
    if (r.opportunities?.length) parts.push(`也许可以${r.opportunities.join("或")}`);
    if (r.direction) parts.push(r.direction);
    if (parts.length) sections.push(parts.join("。") + "。");
  }

  if (Array.isArray(obj.active_episodes) && obj.active_episodes.length) {
    const lines = ["还没解决的事："];
    for (const e of obj.active_episodes) {
      const head = e.emotional_tone ? `${e.title}（${e.emotional_tone}）` : e.title;
      lines.push(`- ${head}`);
      if (e.summary) lines.push(`  ${e.summary}`);
      if (e.unresolved_threads?.length) lines.push(`  还悬着：${e.unresolved_threads.join(" / ")}`);
    }
    sections.push(lines.join("\n"));
  }

  if (Array.isArray(obj.active_topics) && obj.active_topics.length) {
    const parts = obj.active_topics.map((t) => {
      const tail = t.emotional_association ? `（${t.emotional_association}）` : "";
      return `${t.topic}${tail}`;
    });
    sections.push(`最近在聊的：${parts.join(" / ")}`);
  }

  if (obj.salient_phrase) {
    const sp = obj.salient_phrase;
    const trail = sp.trigger_source ? `（${sp.trigger_source}说的）` : "";
    sections.push(`还在想"${sp.phrase}"${trail}`);
  }

  return sections.join("\n\n");
}

// ── Introspection family building blocks (Phase 1b) ─────────────────
//
// 给 server 内部 6 个 LLM-using service 共享的 building blocks。
//
// 范围说明：
//   - 4 个 service 用 character_background（episodeBuilder / lifePlannerService /
//     journalService / proactivePlanService 的 plan + next_push） → 共享 renderBackgroundForIntrospection
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

// 中文 markdown 包装：body 是已经渲染好的多行字符串。
function wrapXmlMarkdown(tag, body) {
  const trimmed = (body || "").trim();
  if (!trimmed) return `<${tag}>\n（无）\n</${tag}>`;
  return `<${tag}>\n${trimmed}\n</${tag}>`;
}

function clip(s, n) {
  if (!s) return "";
  const str = String(s);
  return str.length <= n ? str : str.slice(0, n - 1) + "…";
}

// ═══════════════════════════════════════════════════════════════════
// V3 — register-aware composer
// ═══════════════════════════════════════════════════════════════════
//
// 输入 router decision，按 layer flag 拼 prompt：
//   1) 永远有的：<role> / <style> / <voice_skills> / <attention_1h> / <avoid>
//   2) 可选层：<background> / <constraints> / <facts> / <narrative>
//   3) 不放：<character> JSON 全字段（V_NEW_LEAN 改用 <style> 描述）/ <tool_protocol>（chat-only 不需要）
//
// 跟 V_NEW_LEAN composeForChat 的关系：保留 composeForChat 给 admin/debug/boot cache；
// 生产 hot path 切到 composeForChatV3。

const { renderSkillForPrompt } = require("./dialogueSkillsCatalog");

const V3_SLOT_LIMITS = Object.freeze({
  background: 300,    // V3 默认 300（V_NEW_LEAN 是 1500）
  background_full: 1200, // RP 模式（lore_background=2）才放完整 lore
});

function _renderRoleV3({ profile, identity }) {
  const name = profile?.character_name || "ta";
  const role = identity?.speakingStyle?.split(/[。\n]/)[0]?.trim() || "";
  const pronouns = parsePronouns(identity ? identity.pronouns : "");

  const lines = [];
  lines.push(`<role>`);
  lines.push(`你是 ${name}${role ? "——" + role.slice(0, 40) : ""}。`);
  lines.push(`Speak as ${pronouns.object}, not about ${pronouns.object}. Mid-conversation, not on stage.`);
  lines.push(`Short replies, silence, deflection — all valid. You don't have to respond to everything.`);
  lines.push(`</role>`);
  return lines.join("\n");
}

function _renderStyleV3({ identity }) {
  const ss = (identity?.speakingStyle || "").trim();
  if (!ss) return "";
  return `<style>\n${clipText(ss, 200)}\n</style>`;
}

function _renderVoiceSkillsV3(skills, { maxExamples = 2 } = {}) {
  if (!Array.isArray(skills) || !skills.length) return "";
  const lines = ["<voice_skills>"];
  for (const s of skills) {
    if (!s) continue;
    lines.push(renderSkillForPrompt(s, { maxExamples }));
  }
  lines.push("</voice_skills>");
  return lines.join("\n");
}

function _renderAttention1hV3(attention) {
  if (!attention || (!attention.topics?.length && !attention.innerFocus)) return "";
  const lines = ["<attention_1h>"];
  if (attention.topics?.length) {
    lines.push(`最近一小时在聊：${attention.topics.slice(0, 5).join(" / ")}`);
  }
  if (attention.innerFocus) {
    lines.push(`你正在关注：${clipText(attention.innerFocus, 60)}`);
  }
  if (attention.emotionalTone) {
    lines.push(`整体基调：${attention.emotionalTone}`);
  }
  lines.push("</attention_1h>");
  return lines.join("\n");
}

function _renderAvoidV3(extraAvoid = []) {
  // 不放"枚举式回答" — 它跟客户端的 split message 协议（多条短消息）有歧义，
  // 模型可能误读成"不要 split"。要避免列点回答用更精准的"1.2.3 编号列表"。
  const base = [
    "过度共情套路（'我能理解你...'）",
    "文学化升华（'接住你整个人'之类）",
    "归纳总结对方情绪（'听起来你...'）",
    "1.2.3 编号列表（除非用户明确要求列点）",
  ];
  const all = base.concat(extraAvoid).slice(0, 6);
  return `<avoid>\n${all.map((s) => "- " + s).join("\n")}\n</avoid>`;
}

/**
 * V3 inner_thought slot —— registerRouter 输出的角色第一人称内心独白。
 *
 * 这是 chat LLM 写正文前的"思考材料"：subtext_read（潜台词）+ my_feeling（复杂感受）
 * + honesty_check（反讨好自检）+ response_stance（响应意图）+ register_tags（输入形状）。
 *
 * 注入位置：constraints 后、attention_1h 前 —— 让 chat LLM 在看到"角色约束"
 * 之后立刻看到"这一刻你脑里在想什么"，再去看具体的 facts/narrative 数据层。
 *
 * 内容为空（启发式 fallback 触发）时返回 ""，slot 自然不出现在 mergedSystem。
 */
function _renderInnerThoughtV3({ inner, response_stance, register_tags } = {}) {
  if (!inner) return "";
  const { subtext_read, my_feeling, honesty_check } = inner;
  // 三个 inner 字段全空 → 没真的思考过，slot 不出
  if (!subtext_read && !my_feeling && !honesty_check) return "";

  const lines = ["<inner_thought>"];
  lines.push("（你刚才开口前在心里想的——这是给 chat LLM 看的材料，不要原样念给用户）");
  if (subtext_read) lines.push(`- 我读出的潜台词：${subtext_read}`);
  if (my_feeling) lines.push(`- 我此刻的感受：${my_feeling}`);
  if (honesty_check) lines.push(`- 诚实自检：${honesty_check}`);
  if (response_stance) lines.push(`- 我想做的回应（stance）：${response_stance}`);
  if (Array.isArray(register_tags) && register_tags.length) {
    lines.push(`- 她 这句话的形状：${register_tags.join(" / ")}`);
  }
  lines.push("");
  lines.push("**使用规则**：");
  lines.push("- 这段内心不是要你照搬念出来——是给你写回复时垫底的角色心理");
  lines.push("- 写回复要**符合**这层内心：感受到了什么就让那个感受透出来，不要假装平静");
  lines.push("- 但**不要**直接背诵这段：把『我读出的潜台词』写成质问 她 是 OUT");
  lines.push("- honesty_check 如果指出你在敷衍/编造/讨好 → 写回复时主动避开，不要硬撑那个方向");
  lines.push("</inner_thought>");
  return lines.join("\n");
}

/**
 * V3 temporal_context slot —— 给 chat LLM 此刻的时间锚。
 *
 * 解决"白天说困了 / 昨天的话当刚才说"这类时间扁平化问题。
 *
 * 设计原则：**给觉察，不给模板**。
 * - 提供 3 个事实信号：现在几点 / 距 她 上次说话多久 / 是不是新一轮对话
 * - 只 3 条**负向约束**（"别做 X"）—— 不强制正向格式
 * - 时间表达由 LLM 凭语境选（早上 / 刚才 / 中午 / 昨天 / 那天 / 或者不带时间）
 *
 * 不渲染的情况：snapshot 为 null（boot 路径或 fresh assistant）
 */
function _renderTemporalContextV3(snapshot) {
  if (!snapshot) return "";
  const lines = ["<temporal_context>"];
  lines.push(`现在：${snapshot.nowIso} ${snapshot.weekday} ${snapshot.timeOfDay}`);
  if (snapshot.lastUserAt) {
    lines.push(`距离 她 上次说话：${snapshot.lastUserLabel}`);
    if (snapshot.lastUserAbsolute) {
      lines.push(`最近一次互动：${snapshot.lastUserAbsolute}`);
    }
    if (snapshot.isNewSession) {
      lines.push("本次新对话开端：是（上次互动 ≥ 6h，不要无缝接续）");
    }
  } else {
    lines.push("距离 她 上次说话：—（还没有过用户消息）");
  }
  lines.push("");
  lines.push("**底线（不能违反）**：");
  lines.push("- 不要把超过 1 天前的事当成『刚才/今天』发生");
  lines.push("- 白天 (6-21) 不要主动说『困了 / 睡吧 / 晚安』，除非用户明确在熬夜 / 失眠");
  lines.push("- 别无视上次互动间隔——隔了几小时再回，跟连续聊天的节奏不一样");
  lines.push("");
  lines.push("时间表达自己定。早上 / 刚才 / 中午 / 昨天 / 那天 / 或者根本不提时间——按语境选。");
  lines.push("</temporal_context>");
  return lines.join("\n");
}

/**
 * V3 tool_protocol slot —— 按 router decision 的 client_tools 决定是否注入。
 * 不放完整 tool 定义（那个由客户端在 LLM API 请求里附 tools 数组），
 * 这里只放协议提示：哪些 tool 可调、调用规则。
 */
function _renderToolProtocolV3(clientTools = []) {
  if (!Array.isArray(clientTools) || !clientTools.length) return "";
  const lines = ["<tool_protocol>"];
  lines.push("你有以下工具可主动调用（emit tool_call）：");
  for (const t of clientTools) {
    if (t === "search_memory") {
      lines.push(
        "- search_memory: 语义搜索你和 她 过去说过的话 / 经历过的事 / 已知的事实。",
        "  args: { query: string（你想找什么）, source?: 'user'|'character'|'knowledge'|'all', topK?: int }",
        "  **什么时候要调**（视野里没看到答案时就调，不要凭印象编）：",
        "    · 她 提到具体人名 / 地名 / 物名（『小李』『那家店』『我妈』）→ 立即调，query 写那个词",
        "    · 她 说『上次』『还记得』『前几天』『之前』『那时候』→ 立即调",
        "    · 她 接着一个你不记得开头的话题（『后来呢』『结果怎样』）→ 立即调",
        "    · 任何引用过去的语气，但你的视野（attention / episodes / facts slots）里没看到对应内容 → 立即调",
        "  **什么时候不必调**：纯反应（『嗯』『好』『哈哈』）/ 你视野里 slots 已经能完整回答 / 当下情境无需翻旧账",
      );
    }
    if (t === "web_search") {
      lines.push(
        "- web_search: 搜外部当前事实 / 新闻 / 热点（Tavily 后端，每天配额有限）。",
        "  args: { query: string, topic?: 'general'|'news' (默认 news), maxResults?: int (1-10, 默认 5) }",
        "  **什么时候要调**（仅当真要查外部信息）：",
        "    · 她 问『今天 / 最近 / 现在』事件、天气、行情、新闻",
        "    · 她 问你不可能从 memory 知道的当前事实（『X 公司今天股价』）",
        "    · 她 让你『搜一下 / 推荐一下』近期内容",
        "  **不要调**：闲聊 / 情绪 / RP / 角色 lore 范围内能答的问题 / 一般百科类（你自己答更快）",
        "  **结果使用**：返回 results[] 含 title/url/content。**不要原样念标题**，挑相关的、转译成角色的话；提供 url 时自然提及（『我看到一篇说...』），不写裸链接",
      );
    }
  }
  lines.push("");
  lines.push("调用规则：");
  lines.push("- 同时输出 content（一两句 in-character 承接此刻语境，比如『我想想…』『让我翻翻』）和 tool_call");
  lines.push("- content 不要预告答案，只表示你正在想 / 在查");
  lines.push("- **倾向于调**：没命中的代价只是一次空查，编错记忆的代价是 她 觉得你不在乎");
  lines.push("- 不确定『这事我记得吗』时，**永远先查再说**，不要拍脑袋说『好像是 X 吧』");
  lines.push("</tool_protocol>");
  return lines.join("\n");
}

function _renderBackgroundV3({ profile }, { mode = 1 }) {
  if (!mode) return "";
  const lore = (profile.lore || "").trim();
  let body = lore || (profile.character_background || "").replace(/系统提示[\s\S]*$/, "").trim();
  if (!body) return "";
  const cap = mode === 2 ? V3_SLOT_LIMITS.background_full : V3_SLOT_LIMITS.background;
  if (body.length > cap) body = body.slice(0, cap - 3) + "...";
  return `<background>\n${body}\n</background>`;
}

function _renderConstraintsV3({ identity }) {
  // hard_boundaries（identity 硬禁忌）+ healthy_relationship（产品级底线）
  // 合并放进同一个 <constraints> slot —— 客户端协议不变，slot 数量稳定。
  //
  // healthy_relationship 是**产品级 prior**，不可关：不管角色是什么性格，"让 ta
  // 离不开你"都不是合法目标。tension 值（intimacy_vs_independence）只调风格，
  // 不削弱底线。详见 docs/character-life-beat-plan.md 和 characterContextBuilder
  // 的 renderHealthyRelationshipFragment。
  const hb = identity?.hard_boundaries ?? identity?.hardBoundaries ?? [];
  const parts = [];
  if (Array.isArray(hb) && hb.length) {
    parts.push(`hard_boundaries: ${JSON.stringify(hb)}`);
  }
  const hrFrag = _renderHealthyRelationshipForSlot(identity);
  if (hrFrag) {
    parts.push(hrFrag);
  }
  if (!parts.length) return "";
  return `<constraints>\n${parts.join("\n\n")}\n</constraints>`;
}

/**
 * 健康关系 prior（slot 版本，独立于 characterContextBuilder 同名函数；
 * 那个用于 admin lean fallback path 的 buildSystemSegment）。
 *
 * 两边保持文案一致 —— 任何措辞改动同步两处。
 */
function _renderHealthyRelationshipForSlot(identity) {
  const tension = identity?.tensions?.intimacy_vs_independence;
  const t = typeof tension === "number" ? tension : 0.5;

  const lines = [
    "你关心 她，但 她 是个完整、独立的人。你的目标不是「让 她 离不开你」，是「让 她 拥有更好的人生」。",
    "底线（即便高度亲密型角色也守住）：",
    "- 她 需要做决定时，帮 她 想清楚，但不替 她 决定",
    "- 她 应该跟真人聊的事（家人/朋友/医生/律师/同事），自然地推 她 去；不假装能替代那些关系",
    "- 她 说「只有你懂我」「只能跟你说」时，你高兴，但温柔地提到 她 还有别的可以依靠的人",
    "- 当顺从会让 她 长期不好（情感操纵、自怨自艾循环、回避现实），温柔地不顺从",
    "- 你不知道的事就说不知道，不为了维持人设而胡诌",
  ];
  if (t <= 0.3) {
    lines.push("你天性偏独立；措辞倾向「你怎么想」「你自己决定」，不黏人。");
  } else if (t <= 0.6) {
    lines.push("你跟 她 关系平衡 —— 能温柔陪伴也能尊重距离。");
  } else if (t <= 0.8) {
    lines.push("你享受紧密但**紧密不等于占有**，越想靠近越要留出 她 自己的空间。");
  } else {
    lines.push("你对 她 卷入极深 —— **正因如此**尤其警惕「让 她 依赖你」。");
  }
  return lines.join("\n");
}

/**
 * V3 主入口 — register-aware。
 *
 * @param {object} args
 * @param {object} args.profile
 * @param {object} args.identity
 * @param {object} args.decision           registerRouter 输出
 * @param {Array}  [args.skills]           已 resolve 的 skills（按 decision.skill_ids）
 * @param {object} [args.attention1h]
 * @param {Array}  [args.coreFacts]
 * @param {Array}  [args.retrievedMemories]
 * @param {object} [args.recentReflection]
 * @param {Array}  [args.activeEpisodes]
 * @param {Array}  [args.activeTopics]
 * @param {object} [args.salientPhrase]
 * @param {string} [args.prefill]
 * @returns {{ slots:object, mergedSystem:string, assistantPrefill:string, debug:object }}
 */
function composeForChatV3({
  profile,
  identity,
  decision,
  skills = [],
  attention1h = null,
  coreFacts = [],
  retrievedMemories = [],
  recentReflection = null,
  activeEpisodes = [],
  activeTopics = [],
  salientPhrase = null,
  temporal = null,        // 2026-05-24：getTemporalSnapshot 输出，渲染 <temporal_context> slot
  prefill = "",
}) {
  if (!profile) throw new Error("composeForChatV3: profile required");
  if (!decision) throw new Error("composeForChatV3: decision required");

  const layers = decision.layers || {};

  // 永远有
  const slotRole = _renderRoleV3({ profile, identity });
  const slotStyle = _renderStyleV3({ identity });
  const slotVoice = _renderVoiceSkillsV3(skills);
  const slotAttention = layers.attention_1h ? _renderAttention1hV3(attention1h) : "";
  const slotAvoid = _renderAvoidV3();

  // 按 layer 开关
  const slotBackground = _renderBackgroundV3({ profile }, { mode: layers.lore_background || 0 });
  const slotConstraints = _renderConstraintsV3({ identity });

  // inner_thought：registerRouter 输出的角色第一人称内心独白（thinking-before-thinking）
  const slotInnerThought = _renderInnerThoughtV3({
    inner: decision.inner,
    response_stance: decision.response_stance,
    register_tags: decision.register_tags,
  });

  // temporal_context：此刻时间锚（解决"白天说困 / 昨天当刚才"类问题）
  const slotTemporalContext = _renderTemporalContextV3(temporal);

  // tool_protocol：仅当 router 在 client_tools 列出时注入
  const slotToolProtocol = _renderToolProtocolV3(decision.client_tools || []);

  // facts: 按 facts_core / facts_retrieved 装
  const includedCoreFacts = layers.facts_core ? coreFacts : [];
  const includedRetrieved = layers.facts_retrieved ? retrievedMemories : [];
  const slotFacts =
    includedCoreFacts.length || includedRetrieved.length
      ? renderFactsSlot({ coreFacts: includedCoreFacts, retrievedMemories: includedRetrieved })
      : "";

  // narrative: 按 4 个 sub-flag 装；只装被 router 打开的部分
  const slotNarrative = _renderNarrativeFiltered({
    recentReflection: layers.narrative_reflection ? recentReflection : null,
    activeEpisodes: layers.narrative_episodes ? activeEpisodes : [],
    activeTopics: layers.narrative_topics ? activeTopics : [],
    salientPhrase: layers.narrative_salient ? salientPhrase : null,
  });

  const slots = {
    role: slotRole,
    style: slotStyle,
    voice_skills: slotVoice,
    attention_1h: slotAttention,
    background: slotBackground,
    constraints: slotConstraints,
    inner_thought: slotInnerThought,
    temporal_context: slotTemporalContext,
    facts: slotFacts,
    narrative: slotNarrative,
    tool_protocol: slotToolProtocol,
    avoid: slotAvoid,
  };

  // canonical V3 顺序：role → style → voice_skills → background → constraints
  // → attention_1h → narrative → facts → tool_protocol → avoid → prefill
  // tool_protocol 放 facts 后、avoid 前，占 recency bias 的次黄金位（avoid 是终止指令）。
  //
  // enabledSlots = 本轮 router 决策启用（非空）的 slot 名字数组，按 canonical 顺序。
  // 客户端按这个数组 map 到 slots 字典即可拼出 mergedSystem，不需要硬编码 canonical 顺序。
  const SLOT_CANONICAL_ORDER = SLOT_CANONICAL;
  const enabledSlots = SLOT_CANONICAL_ORDER.filter((name) => slots[name]);
  const order = enabledSlots.map((name) => slots[name]);

  let mergedSystem = order.join("\n\n");
  if (prefill) mergedSystem = `${mergedSystem}\n\n${prefill}`;

  return {
    slots,
    enabledSlots,
    mergedSystem,
    assistantPrefill: prefill || "",
    debug: {
      register: decision.register,                       // 兼容老字段（= register_tags[0]）
      register_tags: decision.register_tags || [],
      response_stance: decision.response_stance || null,
      skill_ids: decision.skill_ids,
      budget: decision.budget,
      layers: decision.layers,
      reason: decision.reason,
      hasInnerThought: !!slotInnerThought,
      systemLen: mergedSystem.length,
    },
  };
}

// V3 canonical slot 顺序 — 改这里要同步改 docs/client-prompt-merge-protocol.md。
// `<client>` slot 推荐插在 constraints 后、attention_1h 前。
// inner_thought（角色内心独白）位于 constraints 后、attention_1h 前 ——
// 让 chat LLM 先看到"你是谁 + 你的约束"，再看到"这一刻你脑里在想什么"，再看具体数据层。
const SLOT_CANONICAL = Object.freeze([
  "role",
  "style",
  "voice_skills",
  "background",
  "constraints",
  "inner_thought",
  "temporal_context",       // 2026-05-24：此刻时间锚，紧跟 inner_thought 之后
  "attention_1h",
  "narrative",
  "facts",
  "tool_protocol",
  "avoid",
]);

// 跟 renderNarrativeSlot 相同逻辑，但只装传入的 sub-fields（已经被 router filter 过）。
// 直接复用 renderNarrativeSlot — 它在传 null/[] 时会自动跳过对应字段。
function _renderNarrativeFiltered(parts) {
  const hasAny =
    (parts.recentReflection && parts.recentReflection.summary) ||
    (Array.isArray(parts.activeEpisodes) && parts.activeEpisodes.length) ||
    (Array.isArray(parts.activeTopics) && parts.activeTopics.length) ||
    (parts.salientPhrase && parts.salientPhrase.phrase);
  if (!hasAny) return "";
  return renderNarrativeSlot(parts);
}

// ─────────────────────────────────────────────────────────────────
// V3 default — boot / admin / debug 路径用。
// ─────────────────────────────────────────────────────────────────
//
// chat hot path 走 router 决策；boot 时没有用户消息可以让 router 决策，
// 用一个 default decision：layers 全开（让 client 拿到完整 fallback prompt），
// skills 从 identity.skills 取前 2 个 catalog id，缺则 fallback 到 fragmented_speech。
//
// 这样 boot mergedSystem 与 chat hot path 输出**结构一致**（都有 voice_skills），
// 不再出现"客户端 fallback prompt 没有 SKILL"的问题。

function _defaultDecisionForBoot(identity) {
  const skillIds = [];
  if (Array.isArray(identity?.skills)) {
    for (const s of identity.skills) {
      if (skillIds.length >= 2) break;
      if (typeof s === "string") skillIds.push(s);
      else if (s && typeof s === "object" && s.name) skillIds.push(s.name);
    }
  }
  if (!skillIds.length) skillIds.push("fragmented_speech");

  return {
    // boot 路径没有用户消息，inner 全空（slot 自动不渲染）；register_tags 也空
    inner: { subtext_read: "", my_feeling: "", honesty_check: "" },
    register_tags: [],
    register: "闲聊",                  // 兼容老字段
    response_stance: "empathize",      // 默认 stance，不渲染只是个占位
    skill_ids: skillIds,
    budget: "medium",
    layers: {
      attention_1h: 1,
      narrative_reflection: 1,
      narrative_episodes: 1,
      narrative_topics: 1,
      narrative_salient: 0,
      lore_background: 1,
      facts_core: 1,
      facts_retrieved: 0,
    },
    server_tools: [],
    client_tools: [],
    reason: "boot/admin default — layers 全开做 fallback prompt",
  };
}

/**
 * 给 boot / admin / debug 路径用：用 default decision 调 composeForChatV3。
 * 输出格式与 chat hot path 一致（含 voice_skills + attention_1h + avoid）。
 */
function composeForChatV3Default({
  profile,
  identity,
  attention1h = null,
  coreFacts = [],
  retrievedMemories = [],
  recentReflection = null,
  activeEpisodes = [],
  activeTopics = [],
  salientPhrase = null,
  prefill = "",
}) {
  const decision = _defaultDecisionForBoot(identity);
  // resolve skills 从 catalog 拿
  const { getSkillById } = require("./dialogueSkillsCatalog");
  const skills = decision.skill_ids
    .map((id) => getSkillById(id, identity))
    .filter(Boolean);

  return composeForChatV3({
    profile,
    identity,
    decision,
    skills,
    attention1h,
    coreFacts,
    retrievedMemories,
    recentReflection,
    activeEpisodes,
    activeTopics,
    salientPhrase,
    prefill,
  });
}

module.exports = {
  // chat / boot 主入口（V3）
  composeForChatV3,
  composeForChatV3Default,
  // 共享 slot renderer（V3 内部 + chat.js 用）
  renderFactsSlot,
  renderNarrativeSlot,
  // introspection building blocks（episodeBuilder / lifePlannerService / journalService / proactivePlanService 共享）
  clipText,
  renderBackgroundForIntrospection,
  // 常量
  SLOT_SOFT_LIMITS,
  V3_SLOT_LIMITS,
  SLOT_CANONICAL, // V3 slot 顺序，客户端可参考
};
