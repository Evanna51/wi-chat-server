/**
 * 用户记忆分类 + 质量评级 + 事实抽取
 *
 * 两段策略：
 *   1) 启发式（关键词 + 长度）零成本，覆盖明确情况（仅给 category + quality，不抽 facts）
 *   2) LLM JSON 调用兜底（一次 call 同时输出 category + quality + facts[]）
 *
 * 仅对 memory_type='user_turn' 行做分类。LLM 抽到的 facts 写入 memory_facts 表。
 *
 * Backfill：
 *   - backfillUnclassified  扫 memory_category IS NULL 的行
 *   - backfillMissingFacts  扫已分类 LLM 路径但 memory_facts 空的事实型行
 */

const { v7: uuidv7 } = require("uuid");
const { db } = require("../db");
const { getIntrospectionProvider } = require("../llm");

// 哪些 category 值得期待 facts。其它 category（如 chitchat / wellbeing 临时情绪）
// 即使 LLM 输出 facts 也按 0 处理，避免事实表被噪音灌满。
const FACT_BEARING_CATEGORIES = new Set([
  "preferences",
  "relationship_info",
  "goals_plans",
  "personal_experience",
  "knowledge",
  "decisions_reflections",
  "ideas",
]);

const VALID_CATEGORIES = new Set([
  "chitchat",
  "personal_experience",
  "relationship_info",
  "knowledge",
  "goals_plans",
  "preferences",
  "decisions_reflections",
  "wellbeing",
  "ideas",
]);

const VALID_GRADES = new Set(["A", "B", "C", "D", "E"]);

// ── Heuristic patterns (single-label, top match wins) ────────────────────────

const CATEGORY_RULES = [
  // 顺序敏感：先匹配先用
  { id: "wellbeing",            re: /压力|失眠|睡眠|头疼|情绪低|心情差|心情不好|焦虑|抑郁/ },
  { id: "goals_plans",          re: /想做|打算|计划|目标|希望|准备|要去|要做|todo/ },
  { id: "decisions_reflections",re: /最终|选了|决定|复盘|反思|想清楚|想明白/ },
  { id: "knowledge",            re: /你知道吗|其实|原来|学到|看了篇|看到资料|wiki|百科|文档/ },
  { id: "preferences",          re: /(不喜欢|喜欢|讨厌|偏好|习惯)|(经常|总是|从来不|每天|每周|每月|每晚|每年)/ },
  { id: "relationship_info",    re: /我妈|我爸|男友|女友|老板|同事|朋友|室友|哥哥|姐姐|弟弟|妹妹|家人/ },
  { id: "personal_experience",  re: /上周|上个月|昨天|前天|去年|那次|那时候|小时候|当年/ },
  { id: "ideas",                re: /要不|要不然|灵感|想到一个|试试|可以试|搞个|做一个/ },
  // chitchat 在最后兜底（短消息 + 应答词）
  { id: "chitchat",             re: /^(嗯+|哈+|好的?|ok|对|是|行|可以)[\s。，！？]*$/i },
];

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/**
 * 启发式分类：返回 { category, quality, confidence } 或 null（让 LLM 接手）
 */
function classifyHeuristic(content) {
  const text = (content || "").trim();
  if (!text) return { category: "chitchat", quality: "E", confidence: 0.95 };

  const len = text.length;

  // 命中 chitchat 短回应
  if (len < 20 && CATEGORY_RULES[CATEGORY_RULES.length - 1].re.test(text)) {
    return { category: "chitchat", quality: "D", confidence: 0.9 };
  }

  // 其他类别：扫描规则表
  for (const rule of CATEGORY_RULES) {
    if (rule.id === "chitchat") continue; // 已处理
    if (rule.re.test(text)) {
      const quality = len > 50 ? "B" : len > 20 ? "C" : "C";
      return { category: rule.id, quality, confidence: 0.7 };
    }
  }

  // 短消息（< 5 字）兜底为 chitchat，避免对超短文本浪费 LLM
  if (len < 5) return { category: "chitchat", quality: "D", confidence: 0.6 };

  // 其余无法判定的，交给 LLM
  return null;
}

// ── LLM classification + fact extraction ────────────────────────────────────

const LLM_PROMPT_TEMPLATE = `将以下用户消息打标 + 抽事实，必须严格返回 JSON：
{"category":"<id>","quality":"A|B|C|D|E","confidence":0.0~1.0,"facts":[{"key":"<snake_case>","value":"<≤50字>","confidence":0.0~1.0,"importance":0.0~1.0}]}

类别：chitchat / personal_experience / relationship_info / knowledge / goals_plans / preferences / decisions_reflections / wellbeing / ideas

质量：A=高信息密度长效 B=明确事件事实 C=一般闲聊 D=噪声 E=无信息

────────────────────────────────────────────────────
facts 抽取规则（重点，按顺序遵守）

【1. 这里只抽用户的事实】
- 数据来源就是用户消息，所以**抽出来的事实天然是关于"用户"或"用户和{角色}之间"**
- {角色} 是占位符，指代当前对话另一方（你不需要知道实际名字，照写就行）
- 闲聊 / 单字应答 / 否定 / 反讽 / 第三方主语 → facts: []

【2. value 必须语义自足，主语明确】
- value 是一句**能脱离 key 单独读懂**的陈述
- 凡是涉及双方关系 / 用户对 {角色} 的态度，**显式写主语**："用户..." 或 "用户对 {角色}..."
- ❌ 反例（主语不清楚）："承认喜欢用户" / "表达爱意" / "感到满足" / "对你有依赖"
- ✅ 正例：
    "用户承认喜欢 {角色}"
    "用户向 {角色} 表达爱意"
    "用户感到满足，依赖 {角色} 陪伴"
    "用户握过 {角色} 的手"

【3. fact_value 涉及对话另一方时一律用占位符 {角色}】
- **禁止写实际角色名 / "AI" / "助手" / "assistant" / "bot" / "我" / "你"**
- 占位符就写 5 个字符："{角色}"
- 这是为了改角色名时数据不失效；server 端读出时会自动展开成真名

【4. key 是 snake_case，必须从下面"首选集"挑】

A. 身份 / 基本面（用户自己）：
   name_user / identity_job / identity_location / identity_age /
   health_condition / employment_status
B. 关系（用户与他人）：
   relationship_with_user_self（用户的自我认同 / 关系角色）
   relationship_with_<who>（与具体人，如 relationship_with_mom / _husband / _friend_<名>）
   relationship_with_character（**用户和 {角色} 的关系**——这是统一 key）
C. 偏好 / 习惯：
   preference_like / preference_dislike / preference_food / preference_drink /
   habit_morning / habit_sleep / habit_<场景>
D. 目标 / 计划：
   goal_short_term / goal_long_term / goal_<topic>
E. 技能：
   skill_<name>
F. 用户对 {角色} 的情感 / 关系动态（**统一收敛到这几个 key**）：
   feeling_about_character（持续性情感，用户长期感受）
   attitude_about_character（用户表达过的态度/期待）
   shared_event_with_character（双方共同经历的事件 / 互动瞬间）
   ⚠️ 不要再用：emotion_towards_user / emotional_state / current_emotional_state /
   current_state_emotion / emotional_state_with_user / shared_moment_with_user
   它们都是同义碎片，统一到上面 3 个 canonical key
G. 内容 / 创作（如果对话是写作 / RP 场景）：
   writing_style_preference / content_requirement_<aspect> /
   plot_event_<n> / plot_setting

【5. confidence vs importance（两个维度正交）】
- confidence = 这个 fact 提取得准不准。原句直白明确 → 0.9+；含糊推断 → 0.5-0.7
- importance = 这个 fact 对角色行为影响多大（"该不该天天记着这件事"）
  · 0.9-1.0：健康状况 / 重大身份 / 不可逆决定（"糖尿病" / "已婚" / "刚失业"）
  · 0.7-0.9：长期关系 / 职业 / 居住地 / 重大目标 / **用户对 {角色} 的持续情感**
  · 0.5-0.7：习惯 / 技能 / 中度偏好 / **双方互动瞬间**
  · 0.3-0.5：轻偏好 / 兴趣 / 临时态度
  · <0.3：一次性闲聊事件

────────────────────────────────────────────────────
正例：

"我每天早上六点起床跑步"
  → [{"key":"habit_morning","value":"用户每天 6 点起床跑步","confidence":0.9,"importance":0.6}]

"我妈妈是医生"
  → [{"key":"relationship_with_mom","value":"用户的妈妈是医生","confidence":0.9,"importance":0.8}]

"我超喜欢拿铁"
  → [{"key":"preference_drink","value":"用户喜欢拿铁","confidence":0.9,"importance":0.4}]

"我有糖尿病"
  → [{"key":"health_condition","value":"用户有糖尿病","confidence":0.95,"importance":0.95}]

"你还记得我握着你的手吗"
  → [{"key":"shared_event_with_character","value":"用户握过 {角色} 的手","confidence":0.85,"importance":0.6}]

"我对你的依赖越来越深，有时候害怕这种感觉"
  → [{"key":"feeling_about_character","value":"用户对 {角色} 越来越依赖，同时害怕这种感觉","confidence":0.85,"importance":0.75}]

"我觉得跟你在一起特别安心"
  → [{"key":"feeling_about_character","value":"用户跟 {角色} 在一起感到安心","confidence":0.9,"importance":0.7}]

反例（不抽 / 抽错）：
  "嗯"                     → facts: []
  "他喜欢打篮球"           → facts: []（主语不是用户）
  "我不喜欢咖啡其实"       → facts: []（否定 / 反复）
  ❌ {"key":"emotion_towards_user","value":"承认喜欢用户"}
  ✅ {"key":"feeling_about_character","value":"用户承认喜欢 {角色}"}

消息：「__CONTENT__」`;

function sanitizeFactKey(k) {
  if (typeof k !== "string") return null;
  const cleaned = k.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  return cleaned.length > 0 && cleaned.length <= 60 ? cleaned : null;
}

function sanitizeFactValue(v) {
  if (typeof v !== "string") return null;
  const cleaned = v.trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, 50);
}

/**
 * Post-process safety net：把 LLM 输出的 fact_value 里的角色名 / 通用代称
 * **标准化成占位符 `{角色}`**（2026-05-24 改：原来是反向替换成角色名）。
 *
 * 为什么：fact_value 在 DB 里要长期存活，角色改名时不该需要批量改库。
 * 存储层永远只有 `{角色}` 占位符，读端按当前 character_name 展开。
 * 见 src/utils/characterPlaceholder.js。
 *
 * 这里只针对 fact_value，conversation_turns 原始文本不动。
 */
const { normalizeToPlaceholder } = require("../utils/characterPlaceholder");

function parseFactsArray(raw, characterName = null) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const key = sanitizeFactKey(item.key);
    let value = sanitizeFactValue(item.value);
    if (!key || !value) continue;
    // 标准化到占位符：AI/助手/角色名 → {角色}
    value = normalizeToPlaceholder(value, characterName);
    const confidence = clamp01(typeof item.confidence === "number" ? item.confidence : 0.7);
    const importance = clamp01(typeof item.importance === "number" ? item.importance : 0.5);
    out.push({ key, value, confidence, importance });
    if (out.length >= 5) break; // 单条 turn 最多 5 个 fact，防止 LLM 灌水
  }
  return out;
}

/**
 * @param {string} content
 * @param {object} [opts]
 * @param {string} [opts.characterName] 角色名，用于 post-process 把 LLM 输出里的真名 → `{角色}` 占位符。
 *                                       prompt 本身使用 `{角色}` 占位符，**不再注入真名**。
 */
async function classifyWithLLM(content, opts = {}) {
  const text = (content || "").trim();
  if (!text) return { category: "chitchat", quality: "E", confidence: 0.95, facts: [] };

  const characterName = (opts.characterName || "").trim();
  const prompt = LLM_PROMPT_TEMPLATE.replace("__CONTENT__", text.slice(0, 500));
  const { content: raw } = await getIntrospectionProvider().complete({
    messages: [
      { role: "system", content: "你是记忆分类与事实抽取引擎。只输出 JSON，不要额外文字。" },
      { role: "user", content: prompt },
    ],
    responseFormat: "json",
    maxTokens: 240,
    temperature: 0,
    callOpts: {
      kind: "memory_classify",
      scopeKey: opts.assistantId || null,
      summary: `classify ${text.slice(0, 30)}`,
    },
  });

  let parsed;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  const category = VALID_CATEGORIES.has(parsed?.category) ? parsed.category : null;
  const quality  = VALID_GRADES.has(parsed?.quality) ? parsed.quality : null;
  if (!category || !quality) return null;

  const facts = FACT_BEARING_CATEGORIES.has(category)
    ? parseFactsArray(parsed?.facts, characterName)
    : [];

  return {
    category,
    quality,
    confidence: clamp01(typeof parsed.confidence === "number" ? parsed.confidence : 0.6),
    facts,
  };
}

// ── Persist ──────────────────────────────────────────────────────────────────

const updateStmt = db.prepare(
  `UPDATE memory_items
      SET memory_category    = ?,
          category_confidence = ?,
          category_method    = ?,
          quality_grade      = ?,
          updated_at         = ?
    WHERE id = ?`
);

const insertFactStmt = db.prepare(
  `INSERT INTO memory_facts
     (id, assistant_id, session_id, memory_item_id, fact_key, fact_value, confidence, importance, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

/**
 * 把 facts 写入 memory_facts。需要 memory_item 的 assistant_id / session_id。
 * 同 memory_item + 同 fact_key 时去重（保留 confidence 高的那条）。
 *
 * fact.created_at 用 **源 memory_item 的 created_at**（事件原始时间），
 * 不用 Date.now()——后者只是 LLM 抽取时刻，对检索/排序无意义。
 */
function persistFactsForMemory(memoryId, facts) {
  if (!facts || facts.length === 0) return 0;
  const memRow = db
    .prepare("SELECT assistant_id, session_id, created_at FROM memory_items WHERE id = ?")
    .get(memoryId);
  if (!memRow) return 0;

  const existing = db
    .prepare("SELECT fact_key, confidence FROM memory_facts WHERE memory_item_id = ?")
    .all(memoryId);
  const existingMap = new Map(existing.map((r) => [r.fact_key, r.confidence]));

  const eventTime = memRow.created_at || Date.now();
  let written = 0;
  const tx = db.transaction(() => {
    for (const f of facts) {
      const old = existingMap.get(f.key);
      if (old !== undefined && old >= f.confidence) continue; // 已有更高置信度的
      if (old !== undefined) {
        db.prepare(
          `DELETE FROM memory_facts WHERE memory_item_id = ? AND fact_key = ?`
        ).run(memoryId, f.key);
      }
      insertFactStmt.run(
        uuidv7(),
        memRow.assistant_id,
        memRow.session_id || "",
        memoryId,
        f.key,
        f.value,
        f.confidence,
        typeof f.importance === "number" ? clamp01(f.importance) : 0.5,
        eventTime
      );
      written += 1;
    }
  });
  tx();
  return written;
}

/**
 * 对一条 memory 做分类 + 写回 + 抽事实。幂等可重复调用。
 * - 仅处理 memory_type='user_turn'
 * - 已有 category 的跳过（除非 force=true）
 * - facts 仅在 LLM 路径产出，启发式分类不写 facts（语义不够细）
 */
async function classifyAndPersist(memoryId, content, { force = false } = {}) {
  const row = db.prepare(
    `SELECT memory_type, memory_category, assistant_id FROM memory_items WHERE id = ?`
  ).get(memoryId);
  if (!row) return { skipped: "not_found" };
  if (row.memory_type !== "user_turn") return { skipped: "non_user_turn" };
  if (row.memory_category && !force) return { skipped: "already_classified" };

  // 拉角色名给 LLM prompt + post-process 用，让 fact_value 不再出现 "AI"/"助手" 代称
  const profileRow = row.assistant_id
    ? db.prepare("SELECT character_name FROM assistant_profile WHERE assistant_id = ?").get(row.assistant_id)
    : null;
  const characterName = profileRow?.character_name || null;

  let result = classifyHeuristic(content);
  let method = "heuristic";

  if (!result) {
    try {
      result = await classifyWithLLM(content, { characterName, assistantId: row.assistant_id });
      method = "llm";
    } catch {
      result = null;
    }
  } else if (
    // 启发式命中事实型类别 + 内容够长 → 额外调 LLM 补抽 facts。
    // category/quality 保留启发式判定（更稳），仅 facts 走 LLM。
    FACT_BEARING_CATEGORIES.has(result.category) &&
    (content || "").trim().length >= 15
  ) {
    try {
      const llmAux = await classifyWithLLM(content, { characterName });
      if (llmAux && Array.isArray(llmAux.facts) && llmAux.facts.length > 0) {
        result.facts = llmAux.facts;
        method = "heuristic+llm_facts";
      }
    } catch {
      // 兜底失败不影响启发式分类结果
    }
  }

  if (!result) {
    // LLM 也失败：保守标 chitchat C，避免永久 NULL
    result = { category: "chitchat", quality: "C", confidence: 0.3, facts: [] };
    method = "fallback";
  }

  updateStmt.run(
    result.category,
    result.confidence,
    method,
    result.quality,
    Date.now(),
    memoryId
  );

  let factsWritten = 0;
  if (
    (method === "llm" || method === "heuristic+llm_facts") &&
    Array.isArray(result.facts) &&
    result.facts.length > 0
  ) {
    factsWritten = persistFactsForMemory(memoryId, result.facts);
  }

  return { ok: true, ...result, method, factsWritten };
}

/**
 * 扫一遍 memory_type='user_turn' AND memory_category IS NULL，逐条分类 + 抽事实。
 * cron / 脚本复用。limit 默认 50（一批），每条最多触发一次 LLM 调用。
 */
async function backfillUnclassified({ limit = 50 } = {}) {
  const rows = db.prepare(
    `SELECT id, content FROM memory_items
      WHERE memory_type = 'user_turn'
        AND memory_category IS NULL
      ORDER BY created_at ASC
      LIMIT ?`
  ).all(limit);

  let processed = 0;
  let llmCalls  = 0;
  let factsWritten = 0;
  for (const r of rows) {
    const res = await classifyAndPersist(r.id, r.content);
    if (res?.ok) {
      processed++;
      if (res.method === "llm") llmCalls++;
      factsWritten += res.factsWritten || 0;
    }
  }
  return { processed, llmCalls, factsWritten, scanned: rows.length };
}

/**
 * 给已经分类过、但 memory_facts 为空的事实型行重新跑一次 LLM 抽 facts。
 *
 * 这是为了应对历史数据：之前 PR-3 之前 facts 由 regex 抽（已清空），PR-3 之后
 * 禁用了 regex 但没接 LLM。本函数补这段空窗期。
 *
 * 只对 LLM 分类过的行做 (category_method='llm')，启发式分类的行不参与
 * （启发式判断的 category 准确度低，再 LLM 就属于"重做分类"了）。
 *
 * 默认 limit=20 一批，避免一次性大量 LLM 调用。
 */
async function backfillMissingFacts({ limit = 20 } = {}) {
  const factTypes = Array.from(FACT_BEARING_CATEGORIES);
  const placeholders = factTypes.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT m.id, m.content, m.assistant_id, p.character_name
         FROM memory_items m
         LEFT JOIN assistant_profile p ON p.assistant_id = m.assistant_id
        WHERE m.memory_type = 'user_turn'
          AND m.memory_category IN (${placeholders})
          AND m.category_method = 'llm'
          AND NOT EXISTS (
            SELECT 1 FROM memory_facts f WHERE f.memory_item_id = m.id
          )
        ORDER BY m.created_at DESC
        LIMIT ?`
    )
    .all(...factTypes, limit);

  let processed = 0;
  let factsWritten = 0;
  let llmCalls = 0;
  for (const r of rows) {
    let llmResult;
    try {
      llmResult = await classifyWithLLM(r.content, { characterName: r.character_name || null, assistantId: r.assistant_id });
      llmCalls += 1;
    } catch {
      continue;
    }
    if (!llmResult || !Array.isArray(llmResult.facts) || llmResult.facts.length === 0) continue;
    if (!FACT_BEARING_CATEGORIES.has(llmResult.category)) continue;
    const written = persistFactsForMemory(r.id, llmResult.facts);
    factsWritten += written;
    if (written > 0) processed += 1;
  }
  return { processed, factsWritten, llmCalls, scanned: rows.length };
}

module.exports = {
  classifyHeuristic,
  classifyWithLLM,
  classifyAndPersist,
  backfillUnclassified,
  backfillMissingFacts,
  persistFactsForMemory,
  FACT_BEARING_CATEGORIES,
  VALID_CATEGORIES,
  VALID_GRADES,
};
