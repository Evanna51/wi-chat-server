/**
 * registerRouter — 让本地 LLM 决定本轮的"对话形状" + tool 决策
 *
 * 一次 LLM 调用，输出 JSON：
 *   1. register（6 选 1）
 *   2. 1-2 个 skill_id（从 catalog 候选里挑）
 *   3. layers — 多层级开关（attention / narrative_* / lore / facts）
 *   4. budget — 输出长度预算
 *   5. server_tools — server 立即跑的 tool（pre-fetch，结果进 facts slot）
 *   6. client_tools — 暴露给 chat LLM 让它自己 emit tool_call（细粒度查询）
 *
 * 输出 JSON schema：
 *   {
 *     register: "反应型|闲聊|情绪倾诉|引用过去|长咨询|RP",
 *     skill_ids: ["...", ...],                 // 1-2 个
 *     layers: {
 *       attention_1h: 0|1,
 *       narrative_reflection: 0|1,
 *       narrative_episodes: 0|1,
 *       narrative_topics: 0|1,
 *       narrative_salient: 0|1,
 *       lore_background: 0|1|2,                // 0=不要 / 1=短身份卡 / 2=完整 lore
 *       facts_core: 0|1,
 *       facts_retrieved: 0|1                   // 仅在 server_tools 含 search_memory 时才能为 1
 *     },
 *     budget: "short|medium|long",
 *     server_tools: [
 *       { tool: "search_memory", args: { query, source, intent } }
 *     ],
 *     client_tools: ["search_memory"],         // 空数组 = 不注入 <tool_protocol> slot
 *     reason: "..."
 *   }
 */

const { ChatOpenAI } = require("@langchain/openai");
const config = require("../../config");
const { listAllSkills, VALID_REGISTERS } = require("./dialogueSkillsCatalog");

let cachedLlm = null;
let cachedProvider = null;
function getLlm() {
  const llmCfg = config.getServerLlmConfig();
  if (cachedLlm && cachedProvider === llmCfg.provider) return cachedLlm;
  cachedLlm = new ChatOpenAI({
    model: llmCfg.model,
    temperature: 0.1,
    maxTokens: 250,
    apiKey: llmCfg.apiKey,
    configuration: { baseURL: llmCfg.baseUrl },
  });
  cachedProvider = llmCfg.provider;
  return cachedLlm;
}

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

const ROUTER_PROMPT = `你是对话决策器。决定一个 AI 角色对当前用户消息的"回应形状"。

**用户当前消息**：
{USER_INPUT}

**最近对话（最多 4 轮）**：
{HISTORY}

**角色当前内心倾向**（启发式判断，可作潜台词）：
{CHARACTER_INTENT}

**当前可用信息层**（哪些层有数据）：
{AVAILABLE_LAYERS}

**候选 skills（必选 1-2 个）**：
{SKILL_CANDIDATES}

**可用 tools**：
  - search_memory: 在过往对话/事实里语义检索（按 query 拉历史记忆）

**输出 JSON**（只返回 JSON，不要任何解释）：
{
  "register": "反应型 | 闲聊 | 情绪倾诉 | 引用过去 | 长咨询 | RP",
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

**决策原则**：
- 输入越短情绪越浓 → 反应型 + 短预算
- 输入含"上次/还记得/以前/那时"或具体人名地名 → 引用过去 + facts 层打开
- 输入是完整观点 / 边界质问 → 长咨询 + reflection 层打开
- 输入含括号动作 / 长叙事 → RP + lore_background=2
- 闲聊默认：闲聊 register + 中等预算 + attention_1h=1，其余层关闭
- skills 选 1-2 个最贴 register 和情境的，不要全选
- 没数据的层永远填 0（看 AVAILABLE_LAYERS）

**角色内心倾向（CHARACTER_INTENT）使用规则**：
- 如果用户消息**正面回应**这个倾向（例如倾向是 reassure_abandonment_fear，用户消息也提到"是不是要走"）→ 选共情/承接类 skill（empathic_mirror / vulnerable_admit / shared_silence）
- 如果用户消息跟倾向**无关**（用户在闲聊，倾向是 follow_up_unresolved_topic）→ 按用户消息为主，inner intent 留作潜台词，**不要硬塞**
- 内心倾向 = none → 忽略此字段

**Tool 决策原则**：
- server_tools = "你能预判用户在问哪个具体事实/记忆 → server 预先跑"
  · 用户引用过去 + attention_1h 看得到具体事件 → 加 search_memory，args.query 写改写后的核心词
  · 用户问"上次"但 attention 里没数据 → 留空（不知道查啥，让 chat LLM 决定）
  · 闲聊 / 反应型 → 必空
- client_tools = "暴露给 chat LLM 自己决定要不要再查"
  · 任何引用过去 / 长咨询 / 命名实体（人名地名）场景 → 加 search_memory
  · 反应型 / 简单情绪 / 极短闲聊 → 空数组（chat LLM 不需要 tool 能力）
- 同一个 tool 可以同时进 server_tools 和 client_tools（pre-fetch + 仍然暴露给 chat 自己再查一次）
- facts_retrieved 只有 server_tools 含 search_memory 时才能为 1`;

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

const KNOWN_TOOLS = new Set(["search_memory"]);
const VALID_SOURCES = new Set(["user", "character", "knowledge", "all"]);

function _validate(decision, available) {
  const out = {
    register: VALID_REGISTERS.includes(decision?.register) ? decision.register : "闲聊",
    skill_ids: [],
    layers: {},
    budget: ["short", "medium", "long"].includes(decision?.budget) ? decision.budget : "medium",
    server_tools: [],
    client_tools: [],
    reason: typeof decision?.reason === "string" ? decision.reason.slice(0, 60) : "",
  };

  // skill_ids: 至少 1 个，最多 2 个
  if (Array.isArray(decision?.skill_ids)) {
    out.skill_ids = decision.skill_ids
      .filter((s) => typeof s === "string" && s.trim())
      .slice(0, 2);
  }
  if (!out.skill_ids.length) {
    const defaultBy = {
      反应型: "reactive_minimal",
      闲聊: "fragmented_speech",
      情绪倾诉: "empathic_mirror",
      引用过去: "shared_recall",
      长咨询: "deep_question",
      RP: "wordless_affection",
    };
    out.skill_ids = [defaultBy[out.register] || "fragmented_speech"];
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
      }
    }
    out.server_tools = out.server_tools.slice(0, 3); // 上限 3 个 tool call
  }

  // client_tools
  if (Array.isArray(decision?.client_tools)) {
    out.client_tools = decision.client_tools
      .filter((s) => typeof s === "string" && KNOWN_TOOLS.has(s))
      .slice(0, 5);
    // 去重
    out.client_tools = Array.from(new Set(out.client_tools));
  }

  // 一致性：facts_retrieved 只有 server_tools 含 search_memory 时才能为 1
  const serverHasSearchMemory = out.server_tools.some((t) => t.tool === "search_memory");
  if (out.layers.facts_retrieved === 1 && !serverHasSearchMemory) {
    out.layers.facts_retrieved = 0;
  }

  return out;
}

function _heuristicFallback(userInput, available) {
  const len = (userInput || "").length;
  const hasTimeWord = /(上次|之前|还记得|以前|那时|前几天|上周|去年|那次)/.test(userInput || "");
  const hasNamedHint = /[那这那个][人她他]|那个.*的/.test(userInput || "");
  const hasParenAction = /[（(].*[)）]/.test(userInput || "");
  const hasExclam = /[!！?？]{1,}/.test(userInput || "");

  let register = "闲聊";
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
  let client_tools = [];

  if (len <= 8 && !hasTimeWord) {
    register = "反应型";
    skill_ids = ["reactive_minimal"];
    budget = "short";
  } else if (hasTimeWord || hasNamedHint) {
    register = "引用过去";
    skill_ids = ["shared_recall", "empathic_mirror"];
    budget = "medium";
    layers.facts_core = available.facts_core ? 1 : 0;
    if (hasTimeWord) {
      server_tools = [{ tool: "search_memory", args: { query: userInput.slice(0, 80), source: "all", intent: "fact_query" } }];
      layers.facts_retrieved = 1;
    }
    client_tools = ["search_memory"];
  } else if (hasParenAction) {
    register = "RP";
    skill_ids = ["wordless_affection", "narrative_scene_build"];
    budget = "long";
    layers.lore_background = 2;
  } else if (len >= 50) {
    register = "长咨询";
    skill_ids = ["deep_question", "boundary_assertion"];
    budget = "medium";
    layers.narrative_reflection = available.narrative_reflection ? 1 : 0;
    client_tools = ["search_memory"];
  } else if (hasExclam || /[我]+(慌|怕|哭|气|怒|烦|累)/.test(userInput || "")) {
    register = "情绪倾诉";
    skill_ids = ["empathic_mirror", "shared_silence"];
    budget = "short";
  }

  return { register, skill_ids, layers, budget, server_tools, client_tools, reason: "fallback (LLM 未触发)" };
}

/**
 * 主决策函数。
 *
 * @param {object} args
 * @param {string} args.userInput
 * @param {Array}  [args.history]        最近 turn 列表 [{role, content}]
 * @param {object} [args.available]      哪些层有数据 { attention_1h, narrative_reflection, ... }
 *                                       值是 true / 数字 > 0 / 1（任何 truthy 都算"有"）
 * @param {object} [args.identity]       角色 identity（用于挑 catalog 中可用 skills）
 * @returns {Promise<object>} 验证过的 decision
 */
async function decideRegister({ userInput, history = [], available = {}, identity = null, characterIntent = null }) {
  if (!userInput || typeof userInput !== "string") {
    return _heuristicFallback("", available);
  }

  const skillCandidates = _formatSkillCandidates(identity);
  const prompt = ROUTER_PROMPT
    .replace("{USER_INPUT}", userInput.slice(0, 500))
    .replace("{HISTORY}", _formatHistory(history))
    .replace("{CHARACTER_INTENT}", _formatCharacterIntent(characterIntent))
    .replace("{AVAILABLE_LAYERS}", _formatAvailableLayers(available))
    .replace("{SKILL_CANDIDATES}", skillCandidates);

  try {
    const resp = await getLlm().invoke([{ role: "user", content: prompt }]);
    const text = typeof resp.content === "string" ? resp.content : "";
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
