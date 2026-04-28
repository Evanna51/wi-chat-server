/**
 * 用户记忆分类 + 质量评级
 *
 * 两段策略：
 *   1) 启发式（关键词 + 长度）零成本，覆盖明确情况
 *   2) LLM JSON 调用兜底（合并 category + quality 一次调用）
 *
 * 仅对 memory_type='user_turn' 行做分类。
 */

const { db } = require("../db");
const { getProvider } = require("../llm");

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

// ── LLM classification ───────────────────────────────────────────────────────

const LLM_PROMPT_TEMPLATE = `将以下用户消息打标，必须返回 JSON：
{"category":"<id>","quality":"A|B|C|D|E","confidence":0.0~1.0}

类别：chitchat / personal_experience / relationship_info / knowledge / goals_plans / preferences / decisions_reflections / wellbeing / ideas

质量：A=高信息密度长效  B=明确事件事实  C=一般闲聊  D=噪声  E=无信息

消息：「__CONTENT__」`;

async function classifyWithLLM(content) {
  const text = (content || "").trim();
  if (!text) return { category: "chitchat", quality: "E", confidence: 0.95 };

  const prompt = LLM_PROMPT_TEMPLATE.replace("__CONTENT__", text.slice(0, 500));
  const { content: raw } = await getProvider().complete({
    messages: [{ role: "user", content: prompt }],
    responseFormat: "json",
    maxTokens: 60,
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

  return {
    category,
    quality,
    confidence: clamp01(typeof parsed.confidence === "number" ? parsed.confidence : 0.6),
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

/**
 * 对一条 memory 做分类 + 写回。幂等可重复调用。
 * - 仅处理 memory_type='user_turn'
 * - 已有 category 的跳过（除非 force=true）
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
  }

  if (!result) {
    // LLM 也失败：保守标 chitchat C，避免永久 NULL
    result = { category: "chitchat", quality: "C", confidence: 0.3 };
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

  return { ok: true, ...result, method };
}

/**
 * 扫一遍所有 memory_type='user_turn' AND memory_category IS NULL，逐条分类。
 * 供 backfill 脚本和 cron 复用。
 */
async function backfillUnclassified({ limit = 500 } = {}) {
  const rows = db.prepare(
    `SELECT id, content FROM memory_items
      WHERE memory_type = 'user_turn'
        AND memory_category IS NULL
      ORDER BY created_at ASC
      LIMIT ?`
  ).all(limit);

  let processed = 0;
  let llmCalls  = 0;
  for (const r of rows) {
    const res = await classifyAndPersist(r.id, r.content);
    if (res?.ok) {
      processed++;
      if (res.method === "llm") llmCalls++;
    }
  }
  return { processed, llmCalls, scanned: rows.length };
}

module.exports = {
  classifyHeuristic,
  classifyWithLLM,
  classifyAndPersist,
  backfillUnclassified,
  VALID_CATEGORIES,
  VALID_GRADES,
};
