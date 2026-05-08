const { v7: uuidv7 } = require("uuid");
const config = require("../config");
const { db } = require("../db");
const { embedText } = require("./embeddingService");
const { vectorStore } = require("./vectorStore");
const { cosineSimilarity, blobToVector } = require("./vectorProviders/sqliteVectorStore");

/**
 * 给一组 memoryId 拉取它们的 vector 并计算与 queryVector 的余弦相似度。
 * 只用于 SQL-first 路径（时间窗给定时绕过向量近邻取候选）。
 */
function computeSemanticScoresForIds(memoryIds, queryVector) {
  if (!memoryIds.length) return new Map();
  const ph = memoryIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT memory_item_id, vector_blob FROM memory_vectors WHERE memory_item_id IN (${ph})`)
    .all(...memoryIds);
  const out = new Map();
  for (const r of rows) {
    const vec = blobToVector(r.vector_blob);
    if (!vec) continue;
    out.set(r.memory_item_id, cosineSimilarity(queryVector, vec));
  }
  return out;
}

// 评分公式版本号，写入 memory_retrieval_log.strategy 作为评估切片用。
// 改任一权重 / 半衰期 / 公式形态 → 必须 bump 此版本号，回归脚本据此分组对比。
const RETRIEVAL_STRATEGY_VERSION = "v1";

const QUALITY_WEIGHT = { A: 1.0, B: 0.8, C: 0.6, D: 0.3, E: 0.0 };

// 不同 category 的 recency 半衰期（天）。代表"这类记忆多久衰减到一半"。
// 偏好/关系/目标这类长期知识衰减慢；闲聊噪声衰减快；其它中等。
const RECENCY_HALF_LIFE_DAYS = {
  preferences:           180,  // 半年（喜欢喝拿铁这种基本不变）
  relationship_info:     180,  // 半年（家庭关系）
  goals_plans:            90,  // 3 个月（短期目标会过期）
  personal_experience:    90,  // 3 个月（个人经历有时效）
  decisions_reflections:  90,
  knowledge:              90,
  ideas:                  60,
  wellbeing:              30,  // 1 个月（情绪状态时效短）
  chitchat:               14,  // 2 周（闲聊快忘）
};
const RECENCY_HALF_LIFE_DEFAULT = 60;
// 永不归零的下限：远的记忆也保留底分，让"语义强 + 巩固高"的老记忆能挤进 top
const RECENCY_FLOOR = 0.15;

// source 参数 → memory_type IN (...) 映射
const SOURCE_TYPES = {
  user:      ["user_turn"],
  character: ["life_event", "work_event"],   // T-08 后 assistant_turn 不再存在
  knowledge: ["knowledge"],                   // 知识库条目
  all:       null,                            // 不过滤（仅调试/导出用）
};

// 调用方不传 source 时的默认候选池。
const DEFAULT_TYPES = ["user_turn", "life_event", "work_event", "knowledge"];

function normalize(value, min, max) {
  if (max <= min) return 0;
  return (value - min) / (max - min);
}

/**
 * recency 评分：指数衰减 + 不归零地板 + 按 category 不同半衰期 + 巩固效应。
 *
 * 公式：score = floor + (1 - floor) * 0.5^(deltaDays / effectiveHalfLife)
 *
 * effectiveHalfLife = baseHalfLife(category) * (1 + log1p(citeCount) * 0.5)
 * cite_count 高的"被反复唤起的"记忆，半衰期延长——这就是认知科学说的巩固效应。
 *
 * 例（category=preferences, halfLife=180d, floor=0.15）：
 *   0d → 1.00       30d → 0.91       90d → 0.71       365d → 0.31
 *   180d → 0.58     720d → 0.18      不会归零
 */
function scoreRecency(ts, now, category = null, citeCount = 0, memoryType = null) {
  // knowledge 类记忆视为不衰减（用户主动添加的稳定知识）
  if (memoryType === "knowledge") return 1.0;
  const oneDay = 24 * 3600 * 1000;
  const deltaDays = Math.max(0, (now - ts) / oneDay);
  const baseHalfLife = (category && RECENCY_HALF_LIFE_DAYS[category]) || RECENCY_HALF_LIFE_DEFAULT;
  // 巩固效应：cite=0 不变；cite=5 → halfLife * 1.9；cite=20 → halfLife * 2.5
  const consolidationMul = 1 + Math.log1p(citeCount || 0) * 0.5;
  const halfLife = baseHalfLife * consolidationMul;
  const raw = Math.pow(0.5, deltaDays / halfLife);
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * raw;
}

function scoreQuality(grade) {
  if (grade && QUALITY_WEIGHT[grade] !== undefined) return QUALITY_WEIGHT[grade];
  return 0.5; // 未分类按中性处理
}

function scoreCitePopularity(citeCount) {
  // log1p / log(50)：cite=0→0, cite=10→~0.61, cite=50→1
  return Math.min(1, Math.log1p(citeCount || 0) / Math.log(50));
}

// 批量算 graph boost：旧版本是每条命中 1 个 SQL（N+1），改成 1 个 SQL 一次性聚合。
// 把 source_memory_id / target_memory_id 两边的 weight 合到同一个 memory_id 上 SUM。
function batchGraphBoost(assistantId, memoryIds) {
  if (!memoryIds.length) return new Map();
  const ph = memoryIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT memory_id, SUM(weight) AS total_weight FROM (
         SELECT source_memory_id AS memory_id, weight FROM memory_edges
          WHERE assistant_id = ? AND source_memory_id IN (${ph})
         UNION ALL
         SELECT target_memory_id AS memory_id, weight FROM memory_edges
          WHERE assistant_id = ? AND target_memory_id IN (${ph})
       ) GROUP BY memory_id`
    )
    .all(assistantId, ...memoryIds, assistantId, ...memoryIds);
  const out = new Map();
  for (const r of rows) {
    out.set(r.memory_id, Math.min(1, normalize(r.total_weight || 0, 0, 5)));
  }
  return out;
}

// 当窄时间窗 (≤31 天) 给定时，走 SQL-first 检索：先按时间窗过滤拉所有行，
// 再算 query embedding 计算语义分。这样不会被向量近邻 top-25 池子局限漏掉。
const SQL_FIRST_WINDOW_MAX_DAYS = 31;

// 防 query echo：默认排除最近 N 秒同 (assistant, session) 的 user_turn，
// 避免 sync-push 异步分类后立刻被自己的 query 命中。
const ECHO_EXCLUDE_RECENT_SECONDS = 60;

async function retrieveMemory({
  assistantId,
  sessionId = "",
  query,
  topK = config.retrievalTopK,
  category = null,
  source = null,        // "user" | "character" | "all" | null（不过滤）
  minQuality = null,    // "A"|"B"|"C"|"D"|"E"，A 最严
  // ── PR-11 过滤维度 ───────────────────────────────────────────
  fromMs = null,        // created_at >= fromMs
  toMs = null,          // created_at <= toMs
  withinDays = null,    // 便捷：from = now - withinDays * 86400000
  minScore = null,      // 0-1，最终 finalScore 阈值，过滤弱相关
  memoryType = null,    // 单独 memory_type 过滤（如 'life_event'）；优先于 source
  excludeIds = null,    // string[]，从结果排除（用于翻页 / "再来 N 条不重复"）
  includeFacts = false, // 一并返回每条 memory 的 memory_facts 行
  // ── PR-12 新增 ───────────────────────────────────────────
  dateString = null,    // "YYYY-MM-DD" 便捷参数 → 自动转当天 fromMs/toMs (本地时区)
  excludeRecentEcho = true, // 默认 true：屏蔽最近 60s 同 session 的 user_turn 防 echo
  // ── PR-14 新增（知识库）─────────────────────────────────
  kbName = null,        // 仅在指定 kb_name 知识空间内搜
}) {
  const now = Date.now();

  // dateString 便捷参数：覆盖 fromMs/toMs（用本地时区当天 0:00-23:59）
  if (dateString && /^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    const d = new Date(`${dateString}T00:00:00`);
    if (!Number.isNaN(d.getTime())) {
      fromMs = d.getTime();
      toMs = fromMs + 86400000 - 1;
    }
  }

  // 计算最终时间窗
  let effectiveFrom = fromMs;
  if (effectiveFrom == null && withinDays && withinDays > 0) {
    effectiveFrom = now - withinDays * 86400000;
  }
  let effectiveTo = toMs;
  const windowMs =
    effectiveFrom != null && effectiveTo != null ? effectiveTo - effectiveFrom : null;
  const useSqlFirst =
    windowMs != null && windowMs > 0 && windowMs <= SQL_FIRST_WINDOW_MAX_DAYS * 86400000;

  const queryVector = await embedText(query);
  let memoryIds;
  let vectorMatches = null; // 仅向量路径下有值；SQL-first 路径走 computeSemanticScoresForIds 补
  if (useSqlFirst) {
    // SQL-first：先按时间窗 + 其它过滤条件直接 SQL 拉所有匹配行的 id（不走向量近邻）
    const whereClauses = [`assistant_id = ?`, `created_at >= ?`, `created_at <= ?`];
    const params = [assistantId, effectiveFrom, effectiveTo];
    if (category) {
      whereClauses.push("memory_category = ?");
      params.push(category);
    }
    if (memoryType) {
      whereClauses.push("memory_type = ?");
      params.push(memoryType);
    } else {
      // source 显式指定 → 用对应映射；否则用 DEFAULT_TYPES
      const sourceTypes = source
        ? SOURCE_TYPES[source]
        : DEFAULT_TYPES;
      if (sourceTypes && sourceTypes.length > 0) {
        const tp = sourceTypes.map(() => "?").join(",");
        whereClauses.push(`memory_type IN (${tp})`);
        params.push(...sourceTypes);
      }
    }
    if (minQuality) {
      whereClauses.push(`(quality_grade IS NULL OR quality_grade <= ?)`);
      params.push(minQuality);
    }
    if (kbName) {
      whereClauses.push("kb_name = ?");
      params.push(kbName);
    }
    const allInWindow = db
      .prepare(
        `SELECT id FROM memory_items WHERE ${whereClauses.join(" AND ")} ORDER BY created_at ASC`
      )
      .all(...params);
    memoryIds = allInWindow.map((r) => r.id);
  } else {
    // 默认：向量近邻 top-K * N
    const hasFilter = !!(
      category || source || minQuality || effectiveFrom != null || effectiveTo != null ||
      memoryType || (excludeIds && excludeIds.length)
    );
    vectorMatches = await vectorStore.search({
      assistantId,
      queryVector,
      topK: Math.max(topK * (hasFilter ? 5 : 2), 20),
    });
    memoryIds = vectorMatches.map((item) => item.memoryId);
  }

  // exclude 清单
  if (excludeIds && excludeIds.length) {
    const ex = new Set(excludeIds);
    memoryIds = memoryIds.filter((id) => !ex.has(id));
  }
  // echo 防护：排除最近 60s 同 session 的 user_turn id
  if (excludeRecentEcho && sessionId) {
    const echoIds = db
      .prepare(
        `SELECT id FROM memory_items
          WHERE assistant_id = ? AND session_id = ?
            AND memory_type = 'user_turn'
            AND created_at >= ?`
      )
      .all(assistantId, sessionId, now - ECHO_EXCLUDE_RECENT_SECONDS * 1000);
    if (echoIds.length > 0) {
      const ex = new Set(echoIds.map((r) => r.id));
      memoryIds = memoryIds.filter((id) => !ex.has(id));
    }
  }

  if (!memoryIds.length) return [];

  const placeholders = memoryIds.map(() => "?").join(",");
  const whereClauses = [`assistant_id = ?`, `id IN (${placeholders})`];
  const params = [assistantId, ...memoryIds];

  // SQL-first 路径已经过滤过了；走向量路径时这里再加 SQL 过滤
  if (!useSqlFirst) {
    if (category) {
      whereClauses.push("memory_category = ?");
      params.push(category);
    }
    if (memoryType) {
      whereClauses.push("memory_type = ?");
      params.push(memoryType);
    } else {
      const sourceTypes = source
        ? SOURCE_TYPES[source]
        : DEFAULT_TYPES;
      if (sourceTypes && sourceTypes.length > 0) {
        const typePlaceholders = sourceTypes.map(() => "?").join(",");
        whereClauses.push(`memory_type IN (${typePlaceholders})`);
        params.push(...sourceTypes);
      }
    }
    if (minQuality) {
      whereClauses.push(`(quality_grade IS NULL OR quality_grade <= ?)`);
      params.push(minQuality);
    }
    if (kbName) {
      whereClauses.push("kb_name = ?");
      params.push(kbName);
    }
    if (effectiveFrom != null) {
      whereClauses.push("created_at >= ?");
      params.push(effectiveFrom);
    }
    if (effectiveTo != null) {
      whereClauses.push("created_at <= ?");
      params.push(effectiveTo);
    }
  }

  const sql = `SELECT id, assistant_id, session_id, memory_type, content, salience, confidence,
                      memory_category, quality_grade, cite_count, created_at
                 FROM memory_items
                WHERE ${whereClauses.join(" AND ")}`;
  const rows = db.prepare(sql).all(...params);

  // 语义分来源分两种：
  //   - 向量近邻路径：vectorStore.search 已经返回了每个候选的 cosine score
  //   - SQL-first 路径：候选是按时间过滤来的，没有 score，临时算一下
  const matchScoreMap = useSqlFirst
    ? computeSemanticScoresForIds(memoryIds, queryVector)
    : new Map(vectorMatches.map((item) => [item.memoryId, item.score]));
  // 一次性批量算 graph boost，避免 rows 中每行都跑一次 SQL 的 N+1
  const edgeBoostMap = batchGraphBoost(assistantId, rows.map((r) => r.id));
  const ranked = rows
    .map((row) => {
      const rawSemantic    = matchScoreMap.get(row.id);
      const semantic       = rawSemantic == null ? 0.5 : (rawSemantic + 1) / 2;
      const recency        = scoreRecency(row.created_at, now, row.memory_category, row.cite_count, row.memory_type);
      const salience       = row.salience || 0.5;
      const confidence     = row.confidence || 0.5;
      const qualityScore   = scoreQuality(row.quality_grade);
      const citePopularity = scoreCitePopularity(row.cite_count);
      const sessionBoost   = sessionId && row.session_id === sessionId ? 0.02 : 0;
      const edgeBoost      = edgeBoostMap.get(row.id) || 0;

      const finalScore =
        semantic        * 0.42
        + recency       * 0.18
        + salience      * 0.10
        + confidence    * 0.08
        + qualityScore  * 0.10
        + citePopularity * 0.05
        + edgeBoost     * 0.05
        + sessionBoost;

      return {
        id: row.id,
        content: row.content,
        sessionId: row.session_id,
        memoryType: row.memory_type,
        category: row.memory_category,
        quality: row.quality_grade,
        createdAt: row.created_at,
        score: finalScore,
        breakdown: {
          semantic, recency, salience, confidence,
          qualityScore, citePopularity, edgeBoost, sessionBoost,
        },
      };
    })
    .sort((a, b) => b.score - a.score);

  // 应用 minScore 阈值过滤（在 topK 截断前）
  const afterScoreFilter = minScore != null
    ? ranked.filter((r) => r.score >= minScore)
    : ranked;
  const sliced = afterScoreFilter.slice(0, topK);

  // 可选：把 memory_facts 一起拉回来
  if (includeFacts && sliced.length > 0) {
    const ids = sliced.map((r) => r.id);
    const ph = ids.map(() => "?").join(",");
    const factRows = db
      .prepare(
        `SELECT memory_item_id, fact_key, fact_value, confidence, importance
           FROM memory_facts
          WHERE memory_item_id IN (${ph})
          ORDER BY importance DESC, confidence DESC`
      )
      .all(...ids);
    const factsByMem = new Map();
    for (const fr of factRows) {
      const arr = factsByMem.get(fr.memory_item_id) || [];
      arr.push({
        key: fr.fact_key,
        value: fr.fact_value,
        confidence: fr.confidence,
        importance: fr.importance,
      });
      factsByMem.set(fr.memory_item_id, arr);
    }
    for (const item of sliced) {
      item.facts = factsByMem.get(item.id) || [];
    }
  }

  // re-bind to existing variable name for downstream code
  const rankedFinal = sliced;

  // 批量自增 cite_count，记录被检索行为
  if (rankedFinal.length > 0) {
    const ids = rankedFinal.map((r) => r.id);
    const idPlaceholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE memory_items
          SET cite_count = cite_count + 1, last_cited_at = ?
        WHERE id IN (${idPlaceholders})`
    ).run(now, ...ids);
  }

  db.prepare(
    `INSERT INTO memory_retrieval_log
      (id, assistant_id, session_id, query_text, selected_memory_ids_json, score_breakdown_json, strategy, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uuidv7(),
    assistantId,
    sessionId,
    query,
    JSON.stringify(rankedFinal.map((item) => item.id)),
    JSON.stringify(rankedFinal.map((item) => ({ id: item.id, ...item.breakdown, score: item.score }))),
    RETRIEVAL_STRATEGY_VERSION,
    now
  );

  return rankedFinal;
}

module.exports = { retrieveMemory };
