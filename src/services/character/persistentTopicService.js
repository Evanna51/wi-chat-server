/**
 * persistentTopicService — 长期话题（T-CC2-03）
 *
 * 长期话题不是 atomic memory，是"用户学钢琴半年了" / "和母亲关系一直紧张"这种
 * **跨多个对话/episode 反复出现**的关注点。它决定了 AI 可以主动问"钢琴最近怎么样"。
 *
 * 写入策略（关键设计）：
 *   - hot path（onUserMessage）只做 *update*：命中已知 topic 的 aliases → mention_count++ +
 *     last_discussed_at + trajectory append。**不创建新 topic**，避免每条消息都打 LLM。
 *   - 创建新 topic 主要由 episodeBuilder（Phase 2 cron）发起：它扫近 24h memory_items
 *     时用 LLM 识别 topic candidates，统一 upsert。
 *   - admin 也可以手动 create（API endpoint，T-CC2-07）。
 *
 * 状态机（status 字段）：
 *   growing      最近一周内多次提
 *   unresolved   悬而未决（用户表达过不安/无解，但还在谈）
 *   painful      谈起就疼
 *   nostalgic    很久没谈，回忆起带怀念
 *   exciting     最近多次正面提及
 *   dormant      连续 3 周未提（applyDormantSweep cron 自动转）
 *   resolved     用户明确说"放下了"
 *
 * trajectory 数据结构：[{ ts, valence, mentionText }]，保留最近 20 条
 */

const { v7: uuidv7 } = require("uuid");
const { db } = require("../../db");

const VALID_STATUSES = new Set([
  "growing", "unresolved", "painful", "nostalgic", "exciting", "dormant", "resolved",
]);

const VALID_EMOTIONAL_ASSOCIATIONS = new Set([
  "neutral", "pride", "anxiety", "regret", "hope", "longing",
  "anger", "sadness", "joy", "mixed",
]);

const TRAJECTORY_MAX_POINTS = 20;
const DORMANT_THRESHOLD_MS = 21 * 24 * 60 * 60 * 1000; // 3 周未提 → dormant

// ── 读 ─────────────────────────────────────────────────────────────

function parseJson(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function rowToTopic(row) {
  if (!row) return null;
  return {
    id: row.id,
    assistantId: row.assistant_id,
    topic: row.topic,
    aliases: parseJson(row.aliases_json, []),
    emotionalAssociation: row.emotional_association,
    status: row.status,
    importance: row.importance,
    trajectory: parseJson(row.trajectory_json, []),
    firstMentionedAt: row.first_mentioned_at,
    lastDiscussedAt: row.last_discussed_at,
    mentionCount: row.mention_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getTopicById(topicId) {
  return rowToTopic(db.prepare("SELECT * FROM persistent_topic WHERE id = ?").get(topicId));
}

/**
 * 列出 assistant 的活跃 topic。
 * @param {object} opts
 * @param {string[]} [opts.statuses] - 默认 growing/unresolved/painful/exciting（去 dormant/resolved/nostalgic）
 * @param {number} [opts.limit] - 默认 10
 * @param {string} [opts.orderBy] - 'importance' | 'recent'，默认 importance
 */
function listActiveTopics(assistantId, opts = {}) {
  const statuses = opts.statuses || ["growing", "unresolved", "painful", "exciting"];
  const limit = opts.limit || 10;
  const order = opts.orderBy === "recent" ? "last_discussed_at DESC" : "importance DESC, last_discussed_at DESC";
  const placeholders = statuses.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM persistent_topic
       WHERE assistant_id = ? AND status IN (${placeholders})
       ORDER BY ${order}
       LIMIT ?`
    )
    .all(assistantId, ...statuses, limit);
  return rows.map(rowToTopic);
}

function listAllTopics(assistantId, { limit = 50 } = {}) {
  return db
    .prepare("SELECT * FROM persistent_topic WHERE assistant_id = ? ORDER BY updated_at DESC LIMIT ?")
    .all(assistantId, limit)
    .map(rowToTopic);
}

// ── 写 ─────────────────────────────────────────────────────────────

/**
 * 创建新 topic。caller 应当先调 findTopicByAlias 检查重复。
 *
 * @returns {object} 创建后的 topic
 */
function createTopic(assistantId, {
  topic,
  aliases = [],
  emotionalAssociation = "neutral",
  status = "growing",
  importance = 0.4,
  now = Date.now(),
} = {}) {
  if (!topic || !topic.trim()) throw new Error("topic name required");
  if (!VALID_STATUSES.has(status)) throw new Error(`invalid status: ${status}`);
  if (!VALID_EMOTIONAL_ASSOCIATIONS.has(emotionalAssociation)) {
    throw new Error(`invalid emotional_association: ${emotionalAssociation}`);
  }
  if (typeof importance !== "number" || importance < 0 || importance > 1) {
    throw new Error("importance must be number in [0,1]");
  }

  const id = uuidv7();
  db.prepare(
    `INSERT INTO persistent_topic (
      id, assistant_id, topic, aliases_json, emotional_association,
      status, importance, trajectory_json,
      first_mentioned_at, last_discussed_at, mention_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, 1, ?, ?)`
  ).run(
    id,
    assistantId,
    topic.trim(),
    JSON.stringify(aliases),
    emotionalAssociation,
    status,
    importance,
    now,
    now,
    now,
    now
  );
  return getTopicById(id);
}

/**
 * 给已知 topic 加一次 mention：自增 count、更新 last_discussed_at、append trajectory。
 *
 * @returns {object} 更新后的 topic
 */
function recordMention(topicId, { mentionText = "", valence = 0, now = Date.now() } = {}) {
  const existing = getTopicById(topicId);
  if (!existing) throw new Error(`topic not found: ${topicId}`);

  const trajectory = existing.trajectory.slice();
  trajectory.push({ ts: now, valence: clamp(valence, -1, 1), mentionText: clipText(mentionText, 80) });
  // 滑动窗口：只保留最近 TRAJECTORY_MAX_POINTS 条
  while (trajectory.length > TRAJECTORY_MAX_POINTS) trajectory.shift();

  db.prepare(
    `UPDATE persistent_topic SET
      last_discussed_at = ?,
      mention_count = mention_count + 1,
      trajectory_json = ?,
      updated_at = ?
     WHERE id = ?`
  ).run(now, JSON.stringify(trajectory), now, topicId);

  return getTopicById(topicId);
}

/**
 * 状态转换。caller 应该有清晰的触发条件，不要随便调（status 是设计核心）。
 *
 * 例：
 *   - episodeBuilder 检测到用户最近一周内对该 topic 表达 painful → transitionStatus(id, 'painful')
 *   - dormantSweep cron 发现 last_discussed > 21d → transitionStatus(id, 'dormant')
 *   - 用户消息含"我已经放下了/想开了" + topic match → transitionStatus(id, 'resolved')
 */
function transitionStatus(topicId, newStatus, { now = Date.now() } = {}) {
  if (!VALID_STATUSES.has(newStatus)) throw new Error(`invalid status: ${newStatus}`);
  const result = db.prepare(
    `UPDATE persistent_topic SET status = ?, updated_at = ? WHERE id = ?`
  ).run(newStatus, now, topicId);
  if (result.changes === 0) throw new Error(`topic not found: ${topicId}`);
  return getTopicById(topicId);
}

function setImportance(topicId, importance) {
  if (typeof importance !== "number" || importance < 0 || importance > 1) {
    throw new Error("importance must be number in [0,1]");
  }
  db.prepare("UPDATE persistent_topic SET importance = ?, updated_at = ? WHERE id = ?")
    .run(importance, Date.now(), topicId);
  return getTopicById(topicId);
}

// ── 匹配 ───────────────────────────────────────────────────────────

/**
 * 在用户消息中查 assistant 已有 topic 的 alias 是否命中。
 * 启发式：substring 匹配（aliases 数组里任一字符串是 message 子串即命中）。
 *
 * 不做模糊/语义匹配 —— 那应该由 episodeBuilder 阶段用 LLM 做（hot path 不打 LLM）。
 *
 * @returns {object[]} 匹配到的 topic 数组（可能多个）
 */
function findTopicMatchesInMessage(assistantId, message) {
  const text = String(message || "").trim();
  if (!text || text.length < 4) return [];
  const topics = db
    .prepare("SELECT * FROM persistent_topic WHERE assistant_id = ?")
    .all(assistantId)
    .map(rowToTopic);

  const matches = [];
  for (const t of topics) {
    // topic 主名 + aliases 都查
    const candidates = [t.topic, ...t.aliases].filter((c) => c && String(c).trim().length >= 2);
    for (const c of candidates) {
      if (text.includes(c)) {
        matches.push(t);
        break; // 一个 topic 命中一次就够
      }
    }
  }
  return matches;
}

// ── 后台维护 ───────────────────────────────────────────────────────

/**
 * 扫所有 topic：
 *   - last_discussed_at > 21d 前 + status 不是 dormant/resolved → 转 dormant
 *
 * 应该被 scheduler 每天调一次。
 *
 * @returns {{transitioned: number, total: number}}
 */
function applyDormantSweep({ now = Date.now() } = {}) {
  const cutoff = now - DORMANT_THRESHOLD_MS;
  const result = db.prepare(
    `UPDATE persistent_topic
     SET status = 'dormant', updated_at = ?
     WHERE last_discussed_at < ?
       AND status NOT IN ('dormant', 'resolved', 'nostalgic')`
  ).run(now, cutoff);
  const total = db.prepare("SELECT COUNT(1) AS c FROM persistent_topic").get().c;
  return { transitioned: result.changes, total };
}

// ── prompt 注入 ────────────────────────────────────────────────────

/**
 * 把活跃 topic 渲染成 prompt 段，喂给 characterContextBuilder。
 *
 * 输出例：
 *   [长期关注的话题]
 *   - 钢琴学习（exciting，提及 12 次，最近 2 天前）
 *   - 母亲关系（unresolved，提及 8 次，最近 5 天前）
 */
function buildTopicsPromptFragment(assistantId, { limit = 5, now = Date.now() } = {}) {
  const topics = listActiveTopics(assistantId, { limit });
  if (!topics.length) return "";

  const lines = ["[长期关注的话题]"];
  for (const t of topics) {
    const daysAgo = Math.max(0, Math.round((now - t.lastDiscussedAt) / (24 * 3600 * 1000)));
    lines.push(`- ${t.topic}（${t.status}，提及 ${t.mentionCount} 次，最近 ${daysAgo} 天前）`);
  }
  return lines.join("\n");
}

// ── helpers ───────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clipText(t, n) {
  const s = String(t || "");
  return s.length <= n ? s : s.slice(0, n) + "...";
}

module.exports = {
  // CRUD
  createTopic,
  getTopicById,
  listActiveTopics,
  listAllTopics,
  // 状态机
  transitionStatus,
  setImportance,
  // 写入
  recordMention,
  // 匹配
  findTopicMatchesInMessage,
  // 后台
  applyDormantSweep,
  // prompt
  buildTopicsPromptFragment,
  // 常量
  VALID_STATUSES,
  VALID_EMOTIONAL_ASSOCIATIONS,
  TRAJECTORY_MAX_POINTS,
  DORMANT_THRESHOLD_MS,
};
