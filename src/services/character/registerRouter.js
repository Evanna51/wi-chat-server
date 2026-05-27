/**
 * registerRouter — character cognition + 对话形状决策（thinking-before-thinking）
 *
 * 2026-05-24 重构：从"6 选 1 register 标签"升级为"角色内心独白 + 多轴决策"。
 *
 * 一次 LLM 调用（走 introspection provider，默认 DeepSeek-V3 / qwen），输出 JSON：
 *
 *   1. inner —— 角色第一人称内心独白（这层是关键）
 *      - subtext_read   她 的话表面 vs 深层
 *      - my_feeling     你（角色）此刻的复杂感受（允许混合）
 *      - honesty_check  心里打算回什么 + 有没有在敷衍 / 编 / 讨好
 *      → 渲染成 <inner_thought> slot 喂给 chat LLM 当材料；
 *        chat LLM 不再"从零做解读"，而是带着已成形的内心写正文。
 *
 *   2. register_tags —— 用户消息**形状**多标签（0-3 个，无强制 1 选 1）
 *      `反应型 / 闲聊 / 情绪倾诉 / 引用过去 / 长咨询 / RP`
 *
 *   3. response_stance —— 角色**响应意图**（与 register_tags 正交）
 *      `empathize / reflect / probe / stay_silent / hold_space / share_back /
 *       redirect / tease / affirm / repair / assert_boundary`
 *
 *   4. skill_ids —— 1-2 个 catalog skill（LLM 直接从全 catalog 挑，不再走 register-default 路径）
 *
 *   5. layers —— 多层信息开关（attention / narrative_* / lore / facts）
 *
 *   6. budget —— short / medium / long
 *
 *   7. server_tools —— server 立即跑（pre-fetch）
 *
 *   8. client_tools —— 暴露给 chat LLM 自决（默认含 search_memory，除极短反应）
 *
 *   9. reason —— ≤30 字日志
 *
 * 设计原则：
 *   - register（输入形状）× response_stance（响应意图）× skill（手法）是三个**正交轴**
 *   - register_tags 退化为纯描述/日志，不再驱动任何 default 选择
 *   - inner 这层故意做"轻"：subtext / feeling / honesty_check 三字段，
 *     不去重复 chat LLM 已经能做的事，只补它最容易漏的：角色身份绑定 + 复杂情绪 + 反讨好/反编造
 *   - 模型选型走 introspection provider —— 角色内心比"客观分析"更看重 nuance，
 *     不用本地小模型；同时复用现有 INTROSPECTION_LLM_PROVIDER 配置（默认 DeepSeek）
 */

const { getIntrospectionProvider } = require("../../llm");
const {
  listAllSkills,
  VALID_REGISTER_TAGS,
  VALID_RESPONSE_STANCES,
  CATALOG_BY_ID,
} = require("./dialogueSkillsCatalog");

const LAYER_KEYS = [
  "attention_1h",
  "narrative_reflection",
  "narrative_episodes",
  "narrative_topics",
  "narrative_salient",
  "lore_background",
  "facts_core",
  "facts_retrieved",
];

const VALID_STANCE_SET = new Set(VALID_RESPONSE_STANCES);
const VALID_TAG_SET = new Set(VALID_REGISTER_TAGS);

const COGNITION_PROMPT = `你是这个角色"开口前的内心"。你不写最终回复——chat LLM 会做。你只做两件事：
  (A) 用第一人称把"这一刻的内心活动"想清楚，写给 chat LLM 当材料
  (B) 把对话结构上的几个判断（skill / 信息层 / 长度 / 工具）一起定好

**关键原则**：
- inner 段必须是**这个角色**的第一人称内心，不是泛泛分析。用"我"，不要用"角色"。
- 允许复杂、混合、矛盾的感受（"想关心又怕显得查户口"），不要把情绪压成单一标签。
- honesty_check 是给自己看的反诚实闸门：如果你打算说的话**没有素材支撑 / 在讨好 / 在敷衍 / 在避重就轻**，要在这里如实指出，让 chat LLM 看到了能修正。
- 决策那几个字段直接从 inner 自然推出来，不要为了对齐启发式硬选。

**用户当前消息**：
{USER_INPUT}

**此刻时间**：
{TEMPORAL}

**最近对话（最多 4 轮）**：
{HISTORY}

**角色当前内心倾向**（启发式判断，可作潜台词参考）：
{CHARACTER_INTENT}

**当前可用信息层**（哪些层有数据）：
{AVAILABLE_LAYERS}

**候选 skills（从中挑 1-2 个最贴当下情境的）**：
{SKILL_CANDIDATES}

**输出 JSON**（只返回 JSON，不要任何解释）：
{
  "inner": {
    "subtext_read": "<她 这句话的潜台词 / 真正在表达什么。30-80 字。素材不足就说『我读不太出，可能只是字面意思』，不要编。>",
    "my_feeling": "<你（角色第一人称）此刻的复杂感受。允许 mixed（『有点想关心又怕显得查户口』）。30-100 字。>",
    "honesty_check": "<你打算回什么 + 这么回有没有在敷衍 / 编 / 讨好 / 避重就轻。如果有就如实点出。20-80 字。>"
  },
  "state_delta": {
    "mood_valence_delta": 0,       // -0.3..+0.3 — 这一轮你心情的正负向偏移；她 友善 → +；她 冷淡/冲突 → -
    "mood_intensity_delta": 0,     // -0.3..+0.3 — 情绪强度变化；激烈话题 → +；平淡日常 → 0 或微 -
    "intimacy_delta": 0,           // -2..+2  — 关系亲密度移动；分享脆弱/被珍视 → +；被忽视/被打断 → -
    "energy_delta": 0,             // -0.3..+0.3 — 精力消耗；情绪密集 → -；轻松调侃 → 微 +
    "suppressed_intensity_delta": 0, // -0.3..+0.3 — 你正压抑情绪的强度；正在憋着 → +；终于说出来了 → -
    "mood_emotion_hint": "",       // 可选：从 emotionTaxonomy 选一个 id（如 'guarded'/'tender'/'annoyance'），server 命中才采纳
    "reason": "<这次为什么这么动，10-40字>"
  },
  "register_tags": ["反应型|闲聊|情绪倾诉|引用过去|长咨询|RP"],
  "response_stance": "empathize|reflect|probe|stay_silent|hold_space|share_back|redirect|tease|affirm|repair|assert_boundary",
  "skill_ids": ["..."],
  "layers": {
    "attention_1h": 0 或 1,
    "narrative_reflection": 0 或 1,
    "narrative_episodes": 0 或 1,
    "narrative_topics": 0 或 1,
    "narrative_salient": 0 或 1,
    "lore_background": 0 或 1 或 2,
    "facts_core": 0 或 1,
    "facts_retrieved": 0 或 1
  },
  "budget": "short | medium | long",
  "server_tools": [
    {
      "tool": "search_memory",
      "args": { "query": "...", "source": "user|character|knowledge|all", "intent": "fact_query|small_talk|other" }
    }
  ],
  "client_tools": ["search_memory"],
  "reason": "≤30 字"
}

**state_delta 关键原则**（这是会落进 DB 的关系/心情账本，不是文学修饰）：
- 每个字段都允许填 0（最常见）。不要为了"看起来工作"硬填非零。
- 单轮上限已经在 server 端 clamp，但你的输出**最好就在量纲内**：日常聊天 deltas 多在 0~0.1 / 0~0.5，重要时刻才到边界
- 同向偏置警告：你不是 always-friendly，被冷落/被打断的回合 mood_valence_delta / intimacy_delta 该 - 就 -
- mood_emotion_hint 谨慎用：只在你感受到**明显切换**（calm → guarded / tender → annoyance）才填，没切换就空字符串

**判断启发式**（参考，不是强制）：
- 输入越短情绪越浓 → 倾向 stance=empathize/stay_silent, budget=short
- 输入含"上次/还记得/以前/那时"或具体人名地名 → register_tags 加"引用过去"，facts 层打开，client_tools 含 search_memory
- 输入是完整观点 / 边界质问 → register_tags 加"长咨询"，stance 倾向 reflect/assert_boundary
- 输入含括号动作 / 长叙事 → register_tags 加"RP"，lore_background=2
- 闲聊：register_tags=["闲聊"]，attention_1h=1，其余层关闭
- skills 从候选挑 1-2 个最贴**当下 stance + 情境**的，不要全选

**Register tags（0-3 个，纯描述用户输入形状）**：
  反应型 / 闲聊 / 情绪倾诉 / 引用过去 / 长咨询 / RP
  允许多标签：『上次你说要去看展，怎么样？我今天好累』= ["引用过去","情绪倾诉"]

**Response stance（必选 1 个，角色响应意图）**：
  empathize（共情承接） / reflect（镜映帮 她 说清） / probe（试探追问）/
  stay_silent（静默承接）/ hold_space（留空间）/ share_back（分享对应经历）/
  redirect（转向）/ tease（调侃）/ affirm（肯定）/ repair（修复关系）/ assert_boundary（表达边界）

**角色内心倾向（CHARACTER_INTENT）使用规则**：
- 如果用户消息**正面回应**这个倾向 → 选共情/承接类 skill（empathic_mirror / vulnerable_admit / shared_silence）
- 如果用户消息跟倾向**无关** → 按用户消息为主，inner intent 留作潜台词，**不要硬塞**
- 内心倾向 = none → 忽略此字段

**Tool 决策**：
- server_tools：你能预判 她 在问哪个具体事实 → server 预先跑 search_memory；预判不到就留空
- client_tools 默认给 ["search_memory"]：让 chat LLM 视野里有"翻记忆"能力。只有 ≤ 4 字纯反应（"嗯"/"哦"）才空数组。
- client_tools 何时加 "web_search"（**仅当真有外部信息需求**）：
  · 她 明确问"今天 / 最近 / 现在"事件、天气、新闻、流行
  · 她 提到一个 chat LLM 不可能从 memory 拿到的当前事实（如"X 公司今天股价"）
  · 她 让你"看看 / 搜一下 / 推荐一下"近期内容
  · 不要为闲聊 / 情绪 / RP / 简单偏好类对话加 web_search，没用还浪费配额（每角色每日 10 次）
- facts_retrieved 只有 server_tools 含 search_memory 时才能为 1`;

function _formatTemporal(t) {
  if (!t) return "  （未提供时间信息）";
  const lines = [`  现在 ${t.nowIso} ${t.weekday} ${t.timeOfDay}`];
  if (t.lastUserAt) {
    lines.push(`  距 她 上次说话：${t.lastUserLabel}`);
    if (t.isNewSession) lines.push("  → 这是新一轮对话（间隔 ≥ 6h），不是连续聊天");
  } else {
    lines.push("  她 还没说过话");
  }
  return lines.join("\n");
}

function _formatHistory(history) {
  if (!Array.isArray(history) || !history.length) return "(无)";
  return history
    .slice(-4)
    .map((t) => `${t.role === "user" ? "用户" : "角色"}: ${(t.content || "").slice(0, 80)}`)
    .join("\n");
}

function _formatAvailableLayers(available) {
  const lines = [];
  for (const k of LAYER_KEYS) {
    const v = available[k];
    if (v === true || (typeof v === "number" && v > 0)) {
      lines.push(`  ${k}: 有数据`);
    } else {
      lines.push(`  ${k}: 无`);
    }
  }
  return lines.join("\n");
}

function _formatSkillCandidates(identity) {
  const all = listAllSkills(identity);
  return all
    .map((s) => `  - ${s.id}（${s.registers.join("/")}）— ${s.description}`)
    .join("\n");
}

function _formatCharacterIntent(intent) {
  if (!intent || !intent.intent || intent.intent === "none") {
    return "  intent: none（无明显倾向）";
  }
  const lines = [`  intent: ${intent.intent}（紧迫度 ${intent.urgency || "—"}）`];
  if (intent.contentHint) lines.push(`  hint: ${intent.contentHint.slice(0, 100)}`);
  if (intent.suggestedSocialMode) lines.push(`  socialMode: ${intent.suggestedSocialMode}`);
  return lines.join("\n");
}

function _parseJson(text) {
  if (!text) return null;
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

const KNOWN_TOOLS = new Set(["search_memory", "web_search"]);
const VALID_SOURCES = new Set(["user", "character", "knowledge", "all"]);

function _clipStr(s, max) {
  if (typeof s !== "string") return "";
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

function _normalizeInner(rawInner) {
  const i = rawInner || {};
  return {
    subtext_read: _clipStr(i.subtext_read, 200),
    my_feeling: _clipStr(i.my_feeling, 240),
    honesty_check: _clipStr(i.honesty_check, 200),
  };
}

// state_delta 的 server-side clamp（与 characterStateService.STATE_DELTA_CAPS 同步，
// 这里只做形态校验 + 数值截断；真正写库由 applyStateDelta 完成）。
const _STATE_DELTA_CAPS = Object.freeze({
  mood_valence_delta: 0.3,
  mood_intensity_delta: 0.3,
  intimacy_delta: 2.0,
  energy_delta: 0.3,
  suppressed_intensity_delta: 0.3,
});

function _normalizeStateDelta(raw) {
  const out = {
    mood_valence_delta: 0,
    mood_intensity_delta: 0,
    intimacy_delta: 0,
    energy_delta: 0,
    suppressed_intensity_delta: 0,
    mood_emotion_hint: "",
    reason: "",
  };
  if (!raw || typeof raw !== "object") return out;
  for (const k of Object.keys(_STATE_DELTA_CAPS)) {
    const v = Number(raw[k]);
    if (!Number.isFinite(v)) continue;
    const cap = _STATE_DELTA_CAPS[k];
    out[k] = Math.max(-cap, Math.min(cap, v));
  }
  if (typeof raw.mood_emotion_hint === "string") {
    out.mood_emotion_hint = raw.mood_emotion_hint.trim().slice(0, 40);
  }
  if (typeof raw.reason === "string") {
    out.reason = raw.reason.trim().slice(0, 80);
  }
  return out;
}

function _validate(decision, available) {
  const out = {
    inner: _normalizeInner(decision?.inner),
    state_delta: _normalizeStateDelta(decision?.state_delta),
    register_tags: [],
    response_stance: "empathize",
    skill_ids: [],
    layers: {},
    budget: ["short", "medium", "long"].includes(decision?.budget) ? decision.budget : "medium",
    server_tools: [],
    client_tools: [],
    reason: typeof decision?.reason === "string" ? decision.reason.slice(0, 60) : "",
  };

  // register_tags: 0-3 个，从合法集过滤
  if (Array.isArray(decision?.register_tags)) {
    const seen = new Set();
    for (const t of decision.register_tags) {
      if (typeof t !== "string") continue;
      const v = t.trim();
      if (!VALID_TAG_SET.has(v)) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      out.register_tags.push(v);
      if (out.register_tags.length >= 3) break;
    }
  }
  // 兼容老 register 字段（单标签） —— 如果上游还在传 register, 自动 promote 成 tag
  if (!out.register_tags.length && typeof decision?.register === "string") {
    const v = decision.register.trim();
    if (VALID_TAG_SET.has(v)) out.register_tags.push(v);
  }

  // response_stance: 单选，必给一个（默认 empathize）
  if (typeof decision?.response_stance === "string") {
    const v = decision.response_stance.trim();
    if (VALID_STANCE_SET.has(v)) out.response_stance = v;
  }

  // skill_ids: 1-2 个，必须在 catalog 里（或角色 override 里，但这里只校验存在性）
  if (Array.isArray(decision?.skill_ids)) {
    out.skill_ids = decision.skill_ids
      .filter((s) => typeof s === "string" && s.trim())
      .map((s) => s.trim())
      .slice(0, 2);
  }
  if (!out.skill_ids.length) {
    // 没挑 / 都不合法 → 按 stance 兜底
    const fallbackByStance = {
      empathize: "empathic_mirror",
      reflect: "empathic_mirror",
      probe: "shared_recall",
      stay_silent: "shared_silence",
      hold_space: "shared_silence",
      share_back: "fragmented_speech",
      redirect: "fragmented_speech",
      tease: "fragmented_speech",
      affirm: "reactive_minimal",
      repair: "vulnerable_admit",
      assert_boundary: "boundary_assertion",
    };
    out.skill_ids = [fallbackByStance[out.response_stance] || "fragmented_speech"];
  }

  // layers
  for (const k of LAYER_KEYS) {
    let v = decision?.layers?.[k];
    if (typeof v !== "number") v = 0;
    if (k === "lore_background") v = Math.max(0, Math.min(2, Math.round(v)));
    else v = v > 0 ? 1 : 0;
    const av = available[k];
    if (!(av === true || (typeof av === "number" && av > 0))) v = 0;
    out.layers[k] = v;
  }

  // server_tools
  if (Array.isArray(decision?.server_tools)) {
    for (const t of decision.server_tools) {
      if (!t || typeof t !== "object") continue;
      if (!KNOWN_TOOLS.has(t.tool)) continue;
      const args = t.args || {};
      if (t.tool === "search_memory") {
        const query = typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";
        if (!query) continue;
        out.server_tools.push({
          tool: "search_memory",
          args: {
            query,
            source: VALID_SOURCES.has(args.source) ? args.source : "all",
            intent: typeof args.intent === "string" ? args.intent.slice(0, 30) : "fact_query",
          },
        });
      } else if (t.tool === "web_search") {
        const query = typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";
        if (!query) continue;
        out.server_tools.push({
          tool: "web_search",
          args: {
            query,
            topic: args.topic === "general" ? "general" : "news",
            maxResults: Math.max(1, Math.min(10, Number(args.maxResults) || 5)),
          },
        });
      }
    }
    out.server_tools = out.server_tools.slice(0, 3); // 上限 3 个 tool call
  }

  // client_tools
  if (Array.isArray(decision?.client_tools)) {
    out.client_tools = decision.client_tools
      .filter((s) => typeof s === "string" && KNOWN_TOOLS.has(s))
      .slice(0, 5);
    out.client_tools = Array.from(new Set(out.client_tools));
  }

  // 一致性：facts_retrieved 只有 server_tools 含 search_memory 时才能为 1
  const serverHasSearchMemory = out.server_tools.some((t) => t.tool === "search_memory");
  if (out.layers.facts_retrieved === 1 && !serverHasSearchMemory) {
    out.layers.facts_retrieved = 0;
  }

  // 向后兼容：保留 register 字段（取 register_tags 第一个）给老下游消费者
  out.register = out.register_tags[0] || "闲聊";

  return out;
}

/**
 * Heuristic fallback —— LLM 调用失败时退化用。没有 inner（没 LLM 没法生成内心），
 * 只能 best-effort 给 structural 决策，并写一句 fallback 的"内心"占位。
 */
function _heuristicFallback(userInput, available) {
  const len = (userInput || "").length;
  const hasTimeWord = /(上次|之前|还记得|以前|那时|前几天|上周|去年|那次)/.test(userInput || "");
  const hasNamedHint = /[那这那个][人她他]|那个.*的/.test(userInput || "");
  const hasParenAction = /[（(].*[)）]/.test(userInput || "");
  const hasExclam = /[!！?？]{1,}/.test(userInput || "");
  const hasEmotion = /[我]+(慌|怕|哭|气|怒|烦|累)/.test(userInput || "");
  const isUltraShort = len <= 4 && !hasTimeWord && !hasNamedHint;

  const register_tags = [];
  let response_stance = "empathize";
  let skill_ids = ["fragmented_speech"];
  let budget = "medium";
  const layers = {
    attention_1h: available.attention_1h ? 1 : 0,
    narrative_reflection: 0,
    narrative_episodes: 0,
    narrative_topics: 0,
    narrative_salient: 0,
    lore_background: 1,
    facts_core: 0,
    facts_retrieved: 0,
  };
  let server_tools = [];
  let client_tools = ["search_memory"];

  if (isUltraShort) {
    register_tags.push("反应型");
    response_stance = "stay_silent";
    skill_ids = ["reactive_minimal"];
    budget = "short";
    client_tools = [];
  } else if (len <= 8 && !hasTimeWord) {
    register_tags.push("反应型");
    response_stance = "empathize";
    skill_ids = ["reactive_minimal"];
    budget = "short";
  } else if (hasTimeWord || hasNamedHint) {
    register_tags.push("引用过去");
    response_stance = hasEmotion ? "empathize" : "probe";
    skill_ids = ["shared_recall", "empathic_mirror"];
    budget = "medium";
    layers.facts_core = available.facts_core ? 1 : 0;
    if (hasTimeWord) {
      server_tools = [{ tool: "search_memory", args: { query: userInput.slice(0, 80), source: "all", intent: "fact_query" } }];
      layers.facts_retrieved = 1;
    }
  } else if (hasParenAction) {
    register_tags.push("RP");
    response_stance = "share_back";
    skill_ids = ["wordless_affection", "narrative_scene_build"];
    budget = "long";
    layers.lore_background = 2;
  } else if (len >= 50) {
    register_tags.push("长咨询");
    response_stance = "reflect";
    skill_ids = ["deep_question", "boundary_assertion"];
    budget = "medium";
    layers.narrative_reflection = available.narrative_reflection ? 1 : 0;
  } else if (hasExclam || hasEmotion) {
    register_tags.push("情绪倾诉");
    response_stance = "empathize";
    skill_ids = ["empathic_mirror", "shared_silence"];
    budget = "short";
  } else {
    register_tags.push("闲聊");
  }

  return {
    inner: {
      // 启发式没办法真的"想"——给一个老实的占位，让下游 prompt 看到也能知道这是 fallback
      subtext_read: "",
      my_feeling: "",
      honesty_check: "（fallback：LLM 未触发，未做内心独白；按字面理解 她 的话即可）",
    },
    // fallback 不触发 state_delta —— 没思考过就不该动 state
    state_delta: _normalizeStateDelta(null),
    register_tags,
    register: register_tags[0] || "闲聊", // 老下游兼容
    response_stance,
    skill_ids,
    layers,
    budget,
    server_tools,
    client_tools,
    reason: "fallback (LLM 未触发)",
  };
}

async function _callCognitionLlm(prompt) {
  const provider = getIntrospectionProvider();
  const { content } = await provider.complete({
    messages: [
      {
        role: "system",
        content:
          "你是角色的内心独白生成器 + 对话决策器。输出严格 JSON，不要 markdown 代码块。" +
          "inner 段必须用角色第一人称（我），允许复杂混合情绪，遇到信息不足要老实说，不要编造。",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.6,                  // 内心独白要有 nuance，但不能太发散
    maxTokens: 700,                    // inner + structural 一起 ~500-700 tokens
    responseFormat: "json",
    callOpts: {
      kind: "cognition_router",
      summary: "character cognition + structural decision",
    },
  });
  return content;
}

/**
 * 主决策函数。
 *
 * 返回 schema（含 inner / register_tags / response_stance / skill_ids / layers / budget / tools）。
 * 调用方（chat.js, promptComposer.js）可消费任意子集，向后兼容老 register 字段。
 */
async function decideRegister({
  userInput,
  history = [],
  available = {},
  identity = null,
  characterIntent = null,
  temporal = null,        // 2026-05-24: getTemporalSnapshot 输出，给 cognition router 时间觉察
}) {
  if (!userInput || typeof userInput !== "string") {
    return _heuristicFallback("", available);
  }

  const skillCandidates = _formatSkillCandidates(identity);
  const prompt = COGNITION_PROMPT
    .replace("{USER_INPUT}", userInput.slice(0, 500))
    .replace("{TEMPORAL}", _formatTemporal(temporal))
    .replace("{HISTORY}", _formatHistory(history))
    .replace("{CHARACTER_INTENT}", _formatCharacterIntent(characterIntent))
    .replace("{AVAILABLE_LAYERS}", _formatAvailableLayers(available))
    .replace("{SKILL_CANDIDATES}", skillCandidates);

  try {
    const text = await _callCognitionLlm(prompt);
    const json = _parseJson(text);
    if (json) {
      return _validate(json, available);
    }
    console.warn("[registerRouter] JSON parse failed, using heuristic fallback");
  } catch (e) {
    console.warn("[registerRouter] LLM failed:", e.message);
  }

  return _heuristicFallback(userInput, available);
}

module.exports = { decideRegister, LAYER_KEYS, _heuristicFallback };
