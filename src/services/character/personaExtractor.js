/**
 * personaExtractor — 从用户写的 setup_prompt 提炼出结构化 identity + 净化 lore。
 *
 * Phase 3 设计（见 docs/api-redesign-plan.md 后续 followup）：
 *   用户输入 setup_prompt（混合体：lore + 风格 + 系统指令）
 *     → 本地 Qwen LLM 调一次（introspection family，markdown 风格 prompt）
 *     → { identityFields: 18 字段 JSON, lore: 净化叙事段 }
 *     → caller 调 upsertIdentity + 更新 assistant_profile.lore
 *
 * 提炼准确度无法 100% — caller **必须**让用户 review 后再写库。
 *
 * 不直接读写 DB — 纯函数。caller 决定何时同步触发（admin UI extract 端点）/
 * 异步触发（subscriber 监听 setup_prompt.changed 事件）。
 */

const { getProvider } = require("../../llm");
const {
  PERSONALITY_TRAITS,
  ATTACHMENT_STYLES,
  SOCIAL_STRATEGIES,
  COMMON_SKILLS,
  CARE_LANGUAGES,
  TENSIONS,
  COMMON_INSECURITIES,
  COMMON_CORE_WOUNDS,
  COMMON_DESIRES,
  PRONOUN_PRESETS,
} = require("./identityVocab");

// ── prompt 构建 ────────────────────────────────────────────────────

/**
 * 给本地 LLM 用的 introspection 风格 prompt。markdown 段标 + 第一人称指令 +
 * 严格 JSON 输出 schema。
 */
function buildExtractionPrompt(setupPrompt) {
  // vocab 清单显式列出，让 LLM 做 constrained extraction
  const traitList = PERSONALITY_TRAITS.join(", ");
  const attachmentList = ATTACHMENT_STYLES.join(", ");
  const strategyList = SOCIAL_STRATEGIES.join(", ");
  const skillList = COMMON_SKILLS.join(", ");
  const careList = CARE_LANGUAGES.join(", ");
  const tensionList = TENSIONS.join(", ");
  const insecList = COMMON_INSECURITIES.join(", ");
  const woundList = COMMON_CORE_WOUNDS.join(", ");
  const desireList = COMMON_DESIRES.join(", ");
  const pronounList = PRONOUN_PRESETS.join(" | ");

  return [
    "你是角色提炼助手。给定一段用户写的「角色设定 prompt」，",
    "提取出结构化 identity 字段 + 净化后的 lore（叙事段）。",
    "",
    "── 输入：用户写的角色设定 ──",
    setupPrompt,
    "",
    "── 输出严格 JSON ──",
    "{",
    '  "identity": {',
    '    "ageYears": 35,                              // integer 或 null（推断不出留 null）',
    '    "genderExpression": "男性，克制干练",        // 自由文本，描述性别表达',
    `    "pronouns": "${pronounList} 或自定义",       // 英文人称代词`,
    '    "speakingStyle": "...",                      // 100-200 字描述说话风格',
    '    "worldview": "...",                          // 50-150 字描述世界观',
    `    "personalityTraits": ["..."],                 // 从 vocab 选 3-8 项`,
    `    "attachmentStyle": "secure|anxious|avoidant|disorganized",`,
    `    "emotionalSensitivity": 0.5,                  // 0-1`,
    `    "empathyLevel": 0.5,                          // 0-1`,
    `    "expressiveness": 0.5,                        // 0-1`,
    `    "socialStrategyDefault": "casual",            // 从 vocab 选`,
    '    "values": ["..."],                            // 自由文本数组，3-5 项',
    '    "hardBoundaries": ["..."],                   // 不可触碰的边界',
    '    "softBoundaries": ["..."],                   // 软边界（被这样对待会偏转）',
    '    "avoidanceTopics": ["..."],                   // 主动回避的话题',
    '    "triggeringTopics": ["..."],                  // 被触发会有强反应的话题',
    `    "insecurities": ["..."],                      // 从 vocab 选 1-3 项（或自定义）`,
    `    "coreWounds": ["..."],                        // 从 vocab 选 0-2 项（或自定义）`,
    `    "desires": ["..."],                           // 从 vocab 选 1-4 项`,
    `    "careLanguages": { "give": ["..."], "receive": ["..."] },`,
    '    "tensions": { "intimacy_vs_independence": 0.5, ... },  // 0-1，8 个 tension',
    '    "skills": [',
    '      { "name": "...", "examples": ["短句1", "短句2"] }',
    '    ]',
    "  },",
    '  "lore": "..."',
    "}",
    "",
    "── 字段约束 vocabulary ──",
    `personalityTraits 必须从这个 43 项清单选（或返回空数组）：`,
    `  ${traitList}`,
    `attachmentStyle 必须是: ${attachmentList}`,
    `socialStrategyDefault 必须从: ${strategyList}`,
    `careLanguages.give/receive 必须从: ${careList}`,
    `tensions 8 个键: ${tensionList}（值 0-1）`,
    `insecurities 建议清单（也可自定义中文）: ${insecList}`,
    `coreWounds 建议清单（也可自定义中文）: ${woundList}`,
    `desires 建议清单（也可自定义中文）: ${desireList}`,
    `skills.name 建议清单（也可自定义）: ${skillList}`,
    "",
    "── lore 段约束（关键） ──",
    "lore 是「纯叙事性背景」—— 写角色在哪里、做什么、记得谁、经历过什么。",
    "**剥离以下内容**（这些已在 identity 字段里覆盖，重复在 lore 里会稀释 LLM 注意力）：",
    "- 说话风格描述（如「你的语气是 X」「你说话时 Y」）→ 进 speakingStyle 字段",
    "- 价值观描述（如「你认为 X 比 Y 重要」）→ 进 values 字段",
    "- 边界描述（如「你不接受 X」「你回避 Y」）→ 进 hardBoundaries / avoidanceTopics 字段",
    "- 系统指令（如「必须调 search_memory」「禁止编造」）→ **完全删除**（这是 system rule，不是 lore）",
    "lore 字数：50-400 字。如果原 setup_prompt 没有叙事性背景，lore 返回空字符串。",
    "",
    "── 输出要求 ──",
    "- 严格 JSON，不要 markdown 代码块",
    "- 推断不出的字段：ageYears 用 null，数组用 []，对象用 {}",
    "- speakingStyle / worldview 等字符串字段：推断不出留空字符串 \"\"",
    "- 数值字段（emotionalSensitivity 等）：推断不出用 0.5（中性默认）",
    "- 不要 hallucinate：只用 setup_prompt 里能推出的信息",
  ].join("\n");
}

// ── 主入口 ────────────────────────────────────────────────────────

/**
 * 提炼 setup_prompt → identity + lore。
 *
 * @param {string} setupPrompt
 * @param {object} [opts]
 * @param {object} [opts.callOpts]   passed to provider call (kind / scopeKey for log)
 * @returns {Promise<{ identity: object, lore: string, raw: string, error?: string }>}
 */
async function extractPersona(setupPrompt, opts = {}) {
  if (!setupPrompt || !setupPrompt.trim()) {
    return { identity: {}, lore: "", raw: "", error: "empty_setup_prompt" };
  }

  const prompt = buildExtractionPrompt(setupPrompt);
  const provider = getProvider();

  let raw = "";
  try {
    const result = await provider.complete({
      messages: [
        {
          role: "system",
          content:
            "你是角色提炼助手。严格按 JSON schema 输出，不要 markdown 代码块。",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.3,
      maxTokens: 2000,
      responseFormat: "json",
      callOpts: {
        kind: "persona_extract",
        scopeKey: opts.callOpts?.scopeKey || null,
        summary: `extract persona (${setupPrompt.length} chars)`,
        ...(opts.callOpts || {}),
      },
    });
    raw = result?.content || "";
  } catch (err) {
    return { identity: {}, lore: "", raw: "", error: `llm_error: ${err.message}` };
  }

  const parsed = parseStrictJson(raw);
  if (!parsed) {
    return { identity: {}, lore: "", raw, error: "json_parse_failed" };
  }

  // 防御：parsed 应该有 identity + lore 两个键
  const identity = parsed.identity && typeof parsed.identity === "object" ? parsed.identity : {};
  const lore = typeof parsed.lore === "string" ? parsed.lore.trim() : "";

  // 字段二次校验：去掉 vocab 不识别的项（避免 upsertIdentity 抛错）
  const cleaned = cleanIdentity(identity);

  return { identity: cleaned, lore, raw };
}

// ── 校验 / 清洗 ────────────────────────────────────────────────────

const TRAIT_SET = new Set(PERSONALITY_TRAITS);
const ATTACHMENT_SET = new Set(ATTACHMENT_STYLES);
const STRATEGY_SET = new Set(SOCIAL_STRATEGIES);
const CARE_SET = new Set(CARE_LANGUAGES);
const TENSION_SET = new Set(TENSIONS);

function cleanIdentity(input) {
  const out = {};

  if (typeof input.ageYears === "number" && Number.isFinite(input.ageYears) && input.ageYears > 0) {
    out.ageYears = Math.round(input.ageYears);
  }
  if (typeof input.genderExpression === "string" && input.genderExpression.trim()) {
    out.genderExpression = input.genderExpression.trim();
  }
  if (typeof input.pronouns === "string") {
    out.pronouns = input.pronouns.trim();
  }
  for (const k of ["speakingStyle", "worldview"]) {
    if (typeof input[k] === "string") out[k] = input[k].trim();
  }

  // personalityTraits: 过滤 vocab 外的
  if (Array.isArray(input.personalityTraits)) {
    const filtered = input.personalityTraits.filter((t) => typeof t === "string" && TRAIT_SET.has(t));
    if (filtered.length > 0) out.personalityTraits = filtered;
  }

  if (typeof input.attachmentStyle === "string" && ATTACHMENT_SET.has(input.attachmentStyle)) {
    out.attachmentStyle = input.attachmentStyle;
  }

  for (const k of ["emotionalSensitivity", "empathyLevel", "expressiveness"]) {
    if (typeof input[k] === "number" && Number.isFinite(input[k])) {
      out[k] = Math.max(0, Math.min(1, input[k]));
    }
  }

  if (typeof input.socialStrategyDefault === "string" && STRATEGY_SET.has(input.socialStrategyDefault)) {
    out.socialStrategyDefault = input.socialStrategyDefault;
  }

  // 字符串数组字段：trim + 去空 + 长度 ≥ 2 的过滤（identityVocab.validateBoundaryStrings 要求）
  for (const k of ["values", "hardBoundaries", "softBoundaries", "avoidanceTopics", "triggeringTopics", "insecurities", "coreWounds", "desires"]) {
    if (Array.isArray(input[k])) {
      const minLen = ["hardBoundaries", "softBoundaries", "avoidanceTopics", "triggeringTopics"].includes(k) ? 2 : 1;
      const filtered = input[k]
        .map((s) => (typeof s === "string" ? s.trim() : ""))
        .filter((s) => s.length >= minLen);
      if (filtered.length > 0) out[k] = filtered;
    }
  }

  // careLanguages: { give, receive } 过滤 vocab
  if (input.careLanguages && typeof input.careLanguages === "object" && !Array.isArray(input.careLanguages)) {
    const give = Array.isArray(input.careLanguages.give)
      ? input.careLanguages.give.filter((s) => CARE_SET.has(s))
      : [];
    const receive = Array.isArray(input.careLanguages.receive)
      ? input.careLanguages.receive.filter((s) => CARE_SET.has(s))
      : [];
    if (give.length || receive.length) out.careLanguages = { give, receive };
  }

  // tensions: 8 维 + 0-1 数值
  if (input.tensions && typeof input.tensions === "object" && !Array.isArray(input.tensions)) {
    const t = {};
    for (const k of TENSION_SET) {
      const v = input.tensions[k];
      if (typeof v === "number" && Number.isFinite(v)) {
        t[k] = Math.max(0, Math.min(1, v));
      }
    }
    if (Object.keys(t).length > 0) out.tensions = t;
  }

  // skills: array of string OR { name, examples? }
  if (Array.isArray(input.skills)) {
    const filtered = [];
    for (const s of input.skills) {
      if (typeof s === "string" && s.trim()) {
        filtered.push(s.trim());
      } else if (s && typeof s === "object" && typeof s.name === "string" && s.name.trim()) {
        const item = { name: s.name.trim() };
        if (Array.isArray(s.examples)) {
          const exs = s.examples
            .map((e) => (typeof e === "string" ? e.trim() : ""))
            .filter((e) => e.length > 0);
          if (exs.length) item.examples = exs;
        }
        filtered.push(item);
      }
    }
    if (filtered.length > 0) out.skills = filtered;
  }

  return out;
}

function parseStrictJson(text) {
  if (!text) return null;
  // 容错：strip 可能的 markdown ``` 包裹
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*\n/, "").replace(/\n```\s*$/, "");
  }
  try {
    return JSON.parse(s);
  } catch (_) {
    return null;
  }
}

module.exports = {
  extractPersona,
  // 暴露给测试 / 调试
  buildExtractionPrompt,
  cleanIdentity,
  parseStrictJson,
};
