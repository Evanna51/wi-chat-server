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
const { getProvider } = require("../llm");

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
{"category":"<id>","quality":"A|B|C|D|E","confidence":0.0~1.0,"facts":[{"key":"<snake_case>","value":"<≤50字>","confidence":0.0~1.0}]}

类别：chitchat / personal_experience / relationship_info / knowledge / goals_plans / preferences / decisions_reflections / wellbeing / ideas

质量：A=高信息密度长效 B=明确事件事实 C=一般闲聊 D=噪声 E=无信息

facts 抽取规则（重点）：
- 只抽**用户主语**的稳定事实（喜好、习惯、关系、目标、技能、生活基本面）
- key 用 snake_case 描述维度。例：preference_like / habit_morning / relationship_with_mom / goal_short_term / skill / job / location
- value 是简短陈述（≤50字），不是原句复述
- 否定/含糊/反讽/第三方主语 → 不抽
- 闲聊 / 单字应答 / 噪声 → facts: []

正例：
  "我每天早上六点起床跑步" → facts: [{"key":"habit_morning","value":"6点起床跑步","confidence":0.9}]
  "我妈妈是医生，我爸是工程师" → facts: [{"key":"relationship_with_mom","value":"医生","confidence":0.9},{"key":"relationship_with_dad","value":"工程师","confidence":0.9}]
  "我超喜欢拿铁" → facts: [{"key":"preference_like","value":"拿铁","confidence":0.9}]
反例（不抽）：
  "嗯" → facts: []
  "他喜欢打篮球" → facts: []  (主语不是用户)
  "我不喜欢咖啡其实" → facts: [] (有否定/反复)

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

function parseFactsArray(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const key = sanitizeFactKey(item.key);
    const value = sanitizeFactValue(item.value);
    if (!key || !value) continue;
    const confidence = clamp01(typeof item.confidence === "number" ? item.confidence : 0.7);
    out.push({ key, value, confidence });
    if (out.length >= 5) break; // 单条 turn 最多 5 个 fact，防止 LLM 灌水
  }
  return out;
}

async function classifyWithLLM(content) {
  const text = (content || "").trim();
  if (!text) return { category: "chitchat", quality: "E", confidence: 0.95, facts: [] };

  const prompt = LLM_PROMPT_TEMPLATE.replace("__CONTENT__", text.slice(0, 500));
  const { content: raw } = await getProvider().complete({
    messages: [{ role: "user", content: prompt }],
    responseFormat: "json",
    maxTokens: 240,
    temperature: 0,
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

  const facts = FACT_BEARING_CATEGORIES.has(category) ? parseFactsArray(parsed?.facts) : [];

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
     (id, assistant_id, session_id, memory_item_id, fact_key, fact_value, confidence, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);

/**
 * 把 facts 写入 memory_facts。需要 memory_item 的 assistant_id / session_id。
 * 同 memory_item + 同 fact_key 时去重（保留 confidence 高的那条）。
 */
function persistFactsForMemory(memoryId, facts) {
  if (!facts || facts.length === 0) return 0;
  const memRow = db
    .prepare("SELECT assistant_id, session_id FROM memory_items WHERE id = ?")
    .get(memoryId);
  if (!memRow) return 0;

  const existing = db
    .prepare("SELECT fact_key, confidence FROM memory_facts WHERE memory_item_id = ?")
    .all(memoryId);
  const existingMap = new Map(existing.map((r) => [r.fact_key, r.confidence]));

  const now = Date.now();
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
        now
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
    `SELECT memory_type, memory_category FROM memory_items WHERE id = ?`
  ).get(memoryId);
  if (!row) return { skipped: "not_found" };
  if (row.memory_type !== "user_turn") return { skipped: "non_user_turn" };
  if (row.memory_category && !force) return { skipped: "already_classified" };

  let result = classifyHeuristic(content);
  let method = "heuristic";

  if (!result) {
    try {
      result = await classifyWithLLM(content);
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
      const llmAux = await classifyWithLLM(content);
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
      `SELECT m.id, m.content
         FROM memory_items m
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
      llmResult = await classifyWithLLM(r.content);
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
