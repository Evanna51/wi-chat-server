/**
 * episodeBuilder — Narrative Memory Phase 2 的核心 (T-CC2-02)
 *
 * 功能：
 *   1. 扫一个 assistant 的"上次构建之后到现在"的 memory_items
 *   2. 用 LLM 把它们聚合成 K 个 narrative_episode（带 title / summary / 情感色调）
 *   3. 同时让 LLM 识别 topic mentions（已有 topic 的 update + 候选新 topic）
 *   4. 写入 narrative_episode + episode_memory_link + persistent_topic
 *
 * 调用形式：
 *   - 通过 cron（runEpisodeBuilderTick）每天扫所有 character 类 assistant
 *   - 通过 admin endpoint 手动触发单个 assistant
 *
 * 关键设计：
 *   - LLM 失败不抛错：记 console.warn 并 return null，让 cron 继续处理下一个 assistant
 *   - cursor 不存表：直接 query "最新 episode 的 time_range_end" 作为本次起点
 *     （首次构建 = "最早 memory_items.created_at" 作为起点）
 *   - 一次最多 30 条 memory + 最多 5 个 episode + 最多 5 个新 topic（避免 prompt 爆炸 + 表膨胀）
 *   - memory_items 引用：LLM 用 1-based index，service 翻译回 memory_item.id
 */

const { v7: uuidv7 } = require("uuid");
const { getProvider } = require("../../llm");
const { db, getRecentMemoryItems, getAssistantProfile } = require("../../db");
const {
  listAllTopics,
  recordMention,
  createTopic,
  VALID_STATUSES,
  VALID_EMOTIONAL_ASSOCIATIONS,
} = require("./persistentTopicService");

// ── 常量 ───────────────────────────────────────────────────────────

const MAX_MEMORIES_PER_RUN = 30;
const MAX_EPISODES_PER_RUN = 5;
const MAX_NEW_TOPICS_PER_RUN = 5;
const MIN_MEMORIES_TO_RUN = 5;       // 少于 5 条 memory 不够形成 episode
const VALID_EMOTIONAL_TONES = new Set([
  "painful", "nostalgic", "healing", "exciting", "tender", "tense", "mundane",
]);

// ── helpers ───────────────────────────────────────────────────────

function clipText(t, n) {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length <= n ? s : s.slice(0, n) + "...";
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function parseStrictJsonObject(text = "") {
  if (!text) return null;
  // 尝试直接 parse；失败时找第一对 {} 包围
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function formatHumanTs(ts) {
  if (!ts) return "未知";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── cursor ────────────────────────────────────────────────────────

/**
 * 上次 episode 构建到的时间点。
 * 没历史 episode 时返回 null（caller 决定首次窗口）。
 */
function getLastEpisodeEndAt(assistantId) {
  const row = db
    .prepare(
      `SELECT time_range_end FROM narrative_episode
       WHERE assistant_id = ? ORDER BY time_range_end DESC LIMIT 1`
    )
    .get(assistantId);
  return row?.time_range_end || null;
}

// ── 拉数据 ────────────────────────────────────────────────────────

/**
 * 拉本次 build 的 memory_items 窗口。
 * 起点：上次 episode 末尾；没有 episode（首次构建）则按 fallbackDays 回看（默认 24h，admin/init 路径可传更长）
 * 终点：now
 * 不超过 MAX_MEMORIES_PER_RUN
 */
function fetchMemoriesForBuild(assistantId, { now = Date.now(), fallbackDays = 1 } = {}) {
  const lastEnd = getLastEpisodeEndAt(assistantId);
  const start = lastEnd || (now - fallbackDays * 24 * 60 * 60 * 1000);
  const rows = db
    .prepare(
      `SELECT id, memory_type, content, salience, created_at
       FROM memory_items
       WHERE assistant_id = ? AND created_at >= ? AND created_at <= ?
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(assistantId, start, now, MAX_MEMORIES_PER_RUN);
  return { memories: rows, windowStart: start, windowEnd: now };
}

// ── prompt ────────────────────────────────────────────────────────

function buildPrompt({ characterBackground, memories, knownTopics }) {
  const memLines = memories.map((m, i) => {
    const ts = formatHumanTs(m.created_at);
    return `${i + 1}. [${ts} ${m.memory_type}] ${clipText(m.content, 160)}`;
  }).join("\n");

  const topicLines = knownTopics.length
    ? knownTopics.slice(0, 12).map((t) =>
        `- ${t.topic}（status=${t.status}, importance=${t.importance.toFixed(2)}, aliases=${(t.aliases || []).slice(0, 4).join("/")}）`
      ).join("\n")
    : "（暂无）";

  return [
    `你是这个角色的叙事助手。把以下记忆按"主题 + 时间相关性"聚合成 K 个 narrative_episode，同时识别长期话题的 mention 和候选新话题。`,
    `所有输出里用"你"指代角色、用"ta"指代用户，不要写具体名字。`,
    "",
    "── 角色档案 ──",
    clipText(characterBackground || "无", 400),
    "",
    "── 已知长期话题（识别 mention 用） ──",
    topicLines,
    "",
    `── 待聚合的记忆（共 ${memories.length} 条） ──`,
    memLines,
    "",
    "── 输出严格 JSON ──",
    "{",
    `  "episodes": [        // 0-${MAX_EPISODES_PER_RUN} 个；记忆少时可以为空数组`,
    `    {`,
    `      "title": "8-20 字短标题，例 你失恋那段时间",`,
    `      "summary": "1-2 句叙事性总结，可代入角色视角",`,
    `      "emotionalTone": "${[...VALID_EMOTIONAL_TONES].join("|")}",`,
    `      "importance": 0.0-1.0,`,
    `      "unresolvedThreads": ["还没说完的事 / 留下的悬念"],`,
    `      "memoryItemIndices": [1,3,5]`,
    `    }`,
    `  ],`,
    `  "topicMentions": [   // 命中已知话题`,
    `    {"knownTopic":"钢琴学习","valence":0.4}`,
    `  ],`,
    `  "newTopics": [       // 0-${MAX_NEW_TOPICS_PER_RUN} 个新话题候选；保守，宁少勿滥`,
    `    {"topic":"和母亲关系","aliases":["妈","母亲","老妈"],"emotionalAssociation":"unresolved|painful|...","importance":0.0-1.0,"status":"growing|unresolved|painful|nostalgic|exciting"}`,
    `  ]`,
    "}",
    "",
    "约束：",
    "- 至少 3 条 memory 才能合成一个 episode；琐碎单条对话忽略",
    "- emotionalTone / status / emotionalAssociation 必须从枚举里选",
    "- importance 反映「这件事在角色 + 用户记忆里的分量」，不是新闻热度",
    "- newTopics 宁少勿滥：只挑明显跨多次出现的话题候选",
    "- 不要复述记忆，要总结叙事弧",
    "",
    "输出严格 JSON 对象，不要任何额外文本。",
  ].join("\n");
}

async function callLlmForEpisodes(prompt, opts = {}) {
  const provider = getProvider();
  const result = await provider.complete({
    messages: [
      { role: "system", content: "你是叙事记忆聚合助手。输出严格 JSON，不要 markdown 代码块。" },
      { role: "user", content: prompt },
    ],
    temperature: 0.4,
    maxTokens: 1500,
    responseFormat: "json",
    ...opts,
  });
  return parseStrictJsonObject(result?.content);
}

// ── 写入 ──────────────────────────────────────────────────────────

function insertEpisode({
  assistantId,
  title,
  summary,
  emotionalTone,
  importance,
  unresolvedThreads,
  participants,
  memoryItemIds,
  windowStart,
  windowEnd,
  source = "cron",
  now = Date.now(),
}) {
  const id = uuidv7();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO narrative_episode (
        id, assistant_id, title, summary, participants_json,
        emotional_tone, importance, unresolved_threads_json,
        time_range_start, time_range_end,
        created_at, updated_at, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      assistantId,
      clipText(title, 80),
      clipText(summary, 600),
      JSON.stringify(participants || ["user", "assistant"]),
      VALID_EMOTIONAL_TONES.has(emotionalTone) ? emotionalTone : "mundane",
      clamp(importance ?? 0.5, 0, 1),
      JSON.stringify(Array.isArray(unresolvedThreads) ? unresolvedThreads.map((s) => clipText(s, 200)) : []),
      windowStart,
      windowEnd,
      now,
      now,
      source
    );
    const linkStmt = db.prepare(
      `INSERT OR IGNORE INTO episode_memory_link (episode_id, memory_item_id, weight, created_at)
       VALUES (?, ?, ?, ?)`
    );
    for (const mid of memoryItemIds) {
      linkStmt.run(id, mid, 1.0, now);
    }
  });
  tx();
  return id;
}

// ── 主入口 ────────────────────────────────────────────────────────

/**
 * 给一个 assistant 跑一次构建。返回结果 summary（不抛错除非 prompt build 阶段失败）。
 *
 * @returns {{episodesCreated, topicsUpdated, newTopicsCreated, memoriesScanned, skipped, reason}|null}
 */
async function buildEpisodesFor(assistantId, { now = Date.now(), source = "cron", fallbackDays } = {}) {
  const profile = getAssistantProfile(assistantId);
  if (!profile) return { skipped: true, reason: "no_profile", memoriesScanned: 0 };

  // cron 路径默认 24h（每天累积），admin / init 路径首次构建时回看 90 天
  const effectiveFallback = fallbackDays ?? (source === "cron" ? 1 : 90);
  const { memories, windowStart, windowEnd } = fetchMemoriesForBuild(assistantId, { now, fallbackDays: effectiveFallback });
  if (memories.length < MIN_MEMORIES_TO_RUN) {
    return { skipped: true, reason: "too_few_memories", memoriesScanned: memories.length };
  }

  const knownTopics = listAllTopics(assistantId, { limit: 30 });
  const prompt = buildPrompt({
    characterBackground: profile.character_background || "",
    memories,
    knownTopics,
  });

  let parsed;
  try {
    parsed = await callLlmForEpisodes(prompt);
  } catch (err) {
    console.warn(`[episodeBuilder] LLM call failed for ${assistantId}: ${err.message}`);
    return { skipped: true, reason: "llm_error", error: err.message, memoriesScanned: memories.length };
  }
  if (!parsed) {
    console.warn(`[episodeBuilder] LLM returned non-JSON for ${assistantId}`);
    return { skipped: true, reason: "llm_parse_failed", memoriesScanned: memories.length };
  }

  const episodes = Array.isArray(parsed.episodes) ? parsed.episodes.slice(0, MAX_EPISODES_PER_RUN) : [];
  const topicMentions = Array.isArray(parsed.topicMentions) ? parsed.topicMentions : [];
  const newTopicsArr = Array.isArray(parsed.newTopics) ? parsed.newTopics.slice(0, MAX_NEW_TOPICS_PER_RUN) : [];

  // 翻译 memoryItemIndices (1-based) → memory_item.id
  let episodesCreated = 0;
  for (const ep of episodes) {
    const indices = Array.isArray(ep.memoryItemIndices) ? ep.memoryItemIndices : [];
    const mids = indices
      .map((idx) => memories[idx - 1]?.id)
      .filter(Boolean);
    if (mids.length < 2) continue; // episode 至少要 2 条 memory

    insertEpisode({
      assistantId,
      title: ep.title || "未命名段落",
      summary: ep.summary || "",
      emotionalTone: ep.emotionalTone,
      importance: ep.importance,
      unresolvedThreads: ep.unresolvedThreads,
      memoryItemIds: mids,
      windowStart,
      windowEnd,
      source,
      now,
    });
    episodesCreated++;
  }

  // 已知 topic 命中 → recordMention
  let topicsUpdated = 0;
  const knownByName = new Map(knownTopics.map((t) => [t.topic, t]));
  for (const tm of topicMentions) {
    const t = knownByName.get(tm.knownTopic);
    if (!t) continue;
    try {
      recordMention(t.id, {
        mentionText: tm.mentionText || `cron-discovered`,
        valence: clamp(Number(tm.valence) || 0, -1, 1),
        now,
      });
      topicsUpdated++;
    } catch (err) {
      console.warn(`[episodeBuilder] recordMention failed: ${err.message}`);
    }
  }

  // 新 topic
  let newTopicsCreated = 0;
  for (const nt of newTopicsArr) {
    if (!nt?.topic) continue;
    const status = VALID_STATUSES.has(nt.status) ? nt.status : "growing";
    const ea = VALID_EMOTIONAL_ASSOCIATIONS.has(nt.emotionalAssociation) ? nt.emotionalAssociation : "neutral";
    // 跳过 topic 名与已存在 topic / aliases 重复
    const dupName = nt.topic.trim();
    if (knownByName.has(dupName)) continue;
    try {
      createTopic(assistantId, {
        topic: dupName,
        aliases: Array.isArray(nt.aliases) ? nt.aliases.filter((a) => typeof a === "string" && a.trim().length >= 2) : [],
        emotionalAssociation: ea,
        importance: clamp(Number(nt.importance) || 0.4, 0, 1),
        status,
        now,
      });
      newTopicsCreated++;
    } catch (err) {
      console.warn(`[episodeBuilder] createTopic failed: ${err.message}`);
    }
  }

  return {
    skipped: false,
    memoriesScanned: memories.length,
    windowStart,
    windowEnd,
    episodesCreated,
    topicsUpdated,
    newTopicsCreated,
  };
}

/**
 * Cron 入口：扫所有 character 类 assistant，逐个跑 buildEpisodesFor。
 *
 * 串行（不并发）：LLM 调用是有 cost 的，并发跑会爆 rate limit；且数量级（< 20 个 assistant）不需要并发。
 */
async function runEpisodeBuilderTick({ now = Date.now() } = {}) {
  const assistants = db
    .prepare(
      `SELECT assistant_id FROM assistant_profile
       WHERE assistant_type = 'character'
       ORDER BY updated_at DESC`
    )
    .all();

  const results = [];
  for (const a of assistants) {
    try {
      const r = await buildEpisodesFor(a.assistant_id, { now, source: "cron" });
      results.push({ assistantId: a.assistant_id, ...r });
    } catch (err) {
      console.warn(`[episodeBuilder] tick failed for ${a.assistant_id}: ${err.message}`);
      results.push({ assistantId: a.assistant_id, skipped: true, reason: "tick_exception", error: err.message });
    }
  }
  return { tickedAssistants: assistants.length, results };
}

// ── 读 ────────────────────────────────────────────────────────────

function rowToEpisode(row) {
  if (!row) return null;
  return {
    id: row.id,
    assistantId: row.assistant_id,
    title: row.title,
    summary: row.summary,
    participants: (() => { try { return JSON.parse(row.participants_json); } catch { return ["user","assistant"]; } })(),
    emotionalTone: row.emotional_tone,
    importance: row.importance,
    unresolvedThreads: (() => { try { return JSON.parse(row.unresolved_threads_json); } catch { return []; } })(),
    timeRangeStart: row.time_range_start,
    timeRangeEnd: row.time_range_end,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    source: row.source,
  };
}

function listEpisodes(assistantId, { limit = 20, minImportance = 0 } = {}) {
  return db
    .prepare(
      `SELECT * FROM narrative_episode
       WHERE assistant_id = ? AND importance >= ?
       ORDER BY time_range_end DESC
       LIMIT ?`
    )
    .all(assistantId, minImportance, limit)
    .map(rowToEpisode);
}

function getEpisodeById(episodeId) {
  return rowToEpisode(db.prepare("SELECT * FROM narrative_episode WHERE id = ?").get(episodeId));
}

function getEpisodesForMemory(memoryItemId) {
  const rows = db
    .prepare(
      `SELECT e.* FROM narrative_episode e
       JOIN episode_memory_link l ON l.episode_id = e.id
       WHERE l.memory_item_id = ?
       ORDER BY e.importance DESC`
    )
    .all(memoryItemId);
  return rows.map(rowToEpisode);
}

module.exports = {
  buildEpisodesFor,
  runEpisodeBuilderTick,
  listEpisodes,
  getEpisodeById,
  getEpisodesForMemory,
  // 导出给 Phase 2 测试
  buildPrompt,
  insertEpisode,
  fetchMemoriesForBuild,
  MAX_MEMORIES_PER_RUN,
  MIN_MEMORIES_TO_RUN,
  MAX_EPISODES_PER_RUN,
  VALID_EMOTIONAL_TONES,
};
