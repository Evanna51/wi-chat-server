/**
 * 角色日记 / 周记
 *
 * 每天 10:30 写"昨天"的日记，每周一 00:30 写"上周"的周记。LLM 用角色第一人称
 * 叙事，素材来自 conversation_turns + narrative_episode（周记额外吃
 * relationship_reflection）。结果落 character_journal，UNIQUE(assistant_id,
 * period_type, period_start) 防止 cron 重跑或 admin force 写出双份。
 *
 * 不复用 narrative_episode：episode 是"那段时间发生了什么"的抽象叙事段，跨度
 * 不定且不一定每天/每周对齐；journal 是按时间窗口定期写的"我今天/这周经历了
 * 什么"。两者用途和检索路径都不同。
 */

const { v7: uuidv7 } = require("uuid");
const { getIntrospectionProvider } = require("../../llm");
const { db, getAssistantProfile } = require("../../db");
const { renderBackgroundForIntrospection } = require("./promptComposer");

// ── 文本工具 ─────────────────────────────────────────────────────────

function clipText(input = "", maxLen) {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function parseStrictJsonObject(text = "") {
  const normalized = String(text || "").trim();
  const fenced = normalized.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("journal ai output missing json object");
  const parsed = JSON.parse(fenced.slice(start, end + 1));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("journal ai output not json object");
  }
  return parsed;
}

// ── 时间窗口（本地时区） ─────────────────────────────────────────────
// 项目用 process.env.TZ=Asia/Shanghai，所以 Date.getX 都按上海时间。

function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function endOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}
function formatLocalDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/**
 * 给 daily 算昨日窗口：[昨天 00:00, 昨天 23:59:59.999]，entry_date = 今天本地日期。
 */
function computeDailyWindow(now = Date.now()) {
  const yesterday = now - 24 * 60 * 60 * 1000;
  return {
    periodStart: startOfLocalDay(yesterday),
    periodEnd: endOfLocalDay(yesterday),
    entryDate: formatLocalDate(now),
  };
}

/**
 * 给 weekly 算上周窗口：[上周一 00:00, 上周日 23:59:59.999]，entry_date = 本周一日期。
 * JS getDay(): 0=Sun..6=Sat。中国周一开头：周一=offset 0，周日=offset 6。
 */
function computeWeeklyWindow(now = Date.now()) {
  const d = new Date(now);
  const dow = d.getDay(); // 0..6
  const offsetFromMonday = (dow + 6) % 7; // 周一 → 0，周日 → 6
  const thisMonday = new Date(d);
  thisMonday.setDate(d.getDate() - offsetFromMonday);
  thisMonday.setHours(0, 0, 0, 0);
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);
  const lastSunday = new Date(thisMonday);
  lastSunday.setMilliseconds(-1); // = 本周一前一毫秒 = 上周日 23:59:59.999
  return {
    periodStart: lastMonday.getTime(),
    periodEnd: lastSunday.getTime(),
    entryDate: formatLocalDate(thisMonday.getTime()),
  };
}

// ── 素材拉取（按时间窗口） ──────────────────────────────────────────

function fetchTurnsInWindow(assistantId, windowStart, windowEnd, limit = 80) {
  return db
    .prepare(
      `SELECT role, content, created_at
         FROM conversation_turns
        WHERE assistant_id = ?
          AND created_at >= ?
          AND created_at <= ?
        ORDER BY created_at ASC
        LIMIT ?`
    )
    .all(assistantId, windowStart, windowEnd, limit);
}

function fetchEpisodesInWindow(assistantId, windowStart, windowEnd, limit = 6) {
  // narrative_episode 用 time_range_end 标识"故事结束"的时间点
  return db
    .prepare(
      `SELECT id, title, summary, emotional_tone, importance, unresolved_threads_json,
              time_range_start, time_range_end
         FROM narrative_episode
        WHERE assistant_id = ?
          AND time_range_end >= ?
          AND time_range_start <= ?
        ORDER BY importance DESC, time_range_end DESC
        LIMIT ?`
    )
    .all(assistantId, windowStart, windowEnd, limit);
}

function fetchReflectionsInWindow(assistantId, windowStart, windowEnd, limit = 4) {
  // relationship_reflection 用 window_end / created_at 索引
  try {
    return db
      .prepare(
        `SELECT summary, emotional_trend, relationship_direction,
                user_needs_json, concerns_json, opportunities_json,
                window_start, window_end, created_at
           FROM relationship_reflection
          WHERE assistant_id = ?
            AND window_end >= ?
            AND window_start <= ?
          ORDER BY created_at DESC
          LIMIT ?`
      )
      .all(assistantId, windowStart, windowEnd, limit);
  } catch {
    // 表可能未建（migration 029 已在；防御性兜底）
    return [];
  }
}

// ── Prompt ───────────────────────────────────────────────────────────
//
// 2026-05-24：把单次"塞所有素材一次写完"拆成两步（reflect → narrate）：
//   step 1 reflect：原始 turns/episodes/reflections → 结构化反思
//                   { themes, notableMoments, emotionalArc, unresolvedThreads }
//   step 2 narrate：结构化反思（+ 原始素材的少量引用）→ 第一人称叙事
// 好处：
//   1. 模型不用同时"找重点"和"写文字"，两步都更聚焦，叙事质量更稳
//   2. 中间产物（themes/arc）调用方可见，便于排查"为什么这天的日记写歪了"
//   3. 周记尤其受益 —— 一周素材塞进单 prompt 时模型会平均化处理，分两步后能
//      明确把"本周主线"先抓出来再展开

function _safeJson(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function _renderMaterialLines({ turns, episodes, reflections, periodType }) {
  const turnLines = turns
    .slice(-40) // 控量
    .map((t) => `- [${formatLocalDate(t.created_at)}] ${t.role === "user" ? "她" : "你"}：${clipText(t.content, 100)}`)
    .join("\n");

  const epLines = episodes
    .map((e) => {
      const unresolved = _safeJson(e.unresolved_threads_json, []);
      const tail = unresolved.length ? `（悬念：${unresolved.slice(0, 2).join(" / ")}）` : "";
      return `- ${e.title}（${e.emotional_tone}）${tail}：${clipText(e.summary, 160)}`;
    })
    .join("\n");

  const reflLines = (periodType === "weekly" ? reflections : [])
    .map((r) => {
      const needs = _safeJson(r.user_needs_json, []);
      const concerns = _safeJson(r.concerns_json, []);
      const bits = [];
      if (r.summary) bits.push(clipText(r.summary, 160));
      if (needs.length) bits.push(`她 好像需要 ${needs.slice(0, 3).join("、")}`);
      if (concerns.length) bits.push(`你担心 ${concerns.slice(0, 2).join("、")}`);
      return `- ${bits.join("；")}`;
    })
    .join("\n");

  return { turnLines, epLines, reflLines };
}

function buildReflectPrompt({
  periodType,
  characterBackground,
  turnLines,
  epLines,
  reflLines,
  periodStartLabel,
  periodEndLabel,
}) {
  const periodLabel = periodType === "weekly" ? "这一周" : "昨天";

  return [
    `你是这个角色。先回顾${periodLabel}（${periodStartLabel} ~ ${periodEndLabel}），从下面素材里抽出几个关键面向。`,
    `这一步只整理思路，不写日记正文。`,
    "",
    "角色档案：",
    renderBackgroundForIntrospection(characterBackground, 400),
    "",
    `${periodLabel}和 她 的对话（按时间顺序，不全，只是采样）：`,
    turnLines || "- 无",
    "",
    "这期间已经被聚合成「叙事段」的事件：",
    epLines || "- 无",
    "",
    periodType === "weekly" ? "本周的反思（你已经想过的）：" : "",
    periodType === "weekly" ? (reflLines || "- 无") : "",
    "",
    "请从上面素材里抽：",
    `- themes: ${periodType === "weekly" ? "本周 2-4 个主线（如『工作压力 / 想念 / 一次和好』）" : "昨天 1-3 个核心切面"}`,
    "- notableMoments: 2-4 个值得写进日记的具体瞬间（每条 30 字内，写『发生了什么 + 你的反应』）",
    "- emotionalArc: 一句话概括情绪走向（如『从烦躁到被 她 哄好』『一直很平静』）",
    "- unresolvedThreads: 还没解决的悬念 / 想问没问的事（最多 3 条，没有就空数组）",
    "",
    "只用上面给到的素材，不要编造。素材几乎空就少抽几条 / 空数组也行。",
    "",
    "输出严格 JSON（不要 markdown 代码块）：",
    '{"themes":["<主线1>","<主线2>"],"notableMoments":["<瞬间1>","<瞬间2>"],"emotionalArc":"<情绪走向>","unresolvedThreads":["<悬念1>"]}',
  ].join("\n");
}

function normalizeReflection(raw = {}) {
  const arr = (v, max) => {
    if (!Array.isArray(v)) return [];
    return v.filter((x) => typeof x === "string" && x.trim())
            .map((x) => clipText(x, 120))
            .slice(0, max);
  };
  return {
    themes: arr(raw.themes, 6),
    notableMoments: arr(raw.notableMoments, 6),
    emotionalArc: clipText(String(raw.emotionalArc || ""), 80),
    unresolvedThreads: arr(raw.unresolvedThreads, 5),
  };
}

function _renderReflectionBlock(refl) {
  const lines = ["**你刚才回顾时整理出的要点（必须围绕这些写）**："];
  if (refl.themes?.length) lines.push(`- 主线：${refl.themes.join(" / ")}`);
  if (refl.emotionalArc) lines.push(`- 情绪走向：${refl.emotionalArc}`);
  if (refl.notableMoments?.length) {
    lines.push("- 值得写的瞬间：");
    refl.notableMoments.forEach((m) => lines.push(`  · ${m}`));
  }
  if (refl.unresolvedThreads?.length) {
    lines.push(`- 未解的悬念：${refl.unresolvedThreads.join(" / ")}`);
  }
  return lines.join("\n");
}

function buildNarratePrompt({
  periodType,
  characterBackground,
  reflection,
  turnLines,
  epLines,
  periodStartLabel,
  periodEndLabel,
}) {
  const periodLabel = periodType === "weekly" ? "这一周" : "昨天";
  const targetWordCap = periodType === "weekly" ? "400-800" : "200-400";

  return [
    `你是这个角色。基于你刚才整理的要点，写一段${periodLabel}的日记。`,
    `素材覆盖窗口：${periodStartLabel} ~ ${periodEndLabel}`,
    "",
    _renderReflectionBlock(reflection),
    "",
    "角色档案：",
    renderBackgroundForIntrospection(characterBackground, 400),
    "",
    `${periodLabel}对话采样（参考用，不要直接抄）：`,
    turnLines || "- 无",
    "",
    "这期间的叙事段：",
    epLines || "- 无",
    "",
    "写作要求：",
    `- 用第一人称（你/我，角色自己的口吻），不要写"角色今天..."`,
    `- 字数 ${targetWordCap} 字，写成一段连贯叙事，不要小标题 / 列表 / 分点`,
    "- 围绕上面的【主线 + 情绪走向 + 瞬间】展开，不要扩散到没列出的内容",
    "- 可以带角色的情绪和判断，但不要变成「对 她 的评价报告」",
    "- 没有可写的（要点几乎空）就给一句两句也行，不要硬凑",
    periodType === "weekly"
      ? "- 周记串起几个主线，提一下未解的悬念，给本周一个收束感"
      : "- 日记侧重 1-2 个具体瞬间，不必面面俱到",
    "",
    "输出严格 JSON（不要 markdown 代码块）：",
    '{"content":"<日记正文>"}',
  ].join("\n");
}

// ── LLM 调用 ─────────────────────────────────────────────────────────

async function callLlmForReflection(prompt, { assistantId, periodType } = {}) {
  const provider = getIntrospectionProvider();
  const { content } = await provider.complete({
    messages: [
      {
        role: "system",
        content: "你是角色日记反思助手。从素材里抽 themes / moments / arc / threads，输出严格 JSON，不要 markdown 代码块。",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.5,                 // 抽取阶段降低温度
    maxTokens: periodType === "weekly" ? 700 : 500,
    responseFormat: "json",
    callOpts: {
      kind: "journal_reflect",
      scopeKey: assistantId || null,
      summary: `journal-reflect-${periodType} for ${assistantId || "unknown"}`,
    },
  });
  return parseStrictJsonObject(content);
}

async function callLlmForNarrate(prompt, { assistantId, periodType } = {}) {
  const provider = getIntrospectionProvider();
  const { content } = await provider.complete({
    messages: [
      {
        role: "system",
        content: "你是角色日记书写助手。围绕给定的要点用第一人称写连贯叙事，输出严格 JSON，不要 markdown 代码块。",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.75,                // 写作阶段稍高温度保留语气
    maxTokens: periodType === "weekly" ? 1400 : 900,
    responseFormat: "json",
    callOpts: {
      kind: "journal_narrate",
      scopeKey: assistantId || null,
      summary: `journal-narrate-${periodType} for ${assistantId || "unknown"}`,
    },
  });
  return parseStrictJsonObject(content);
}

// ── DB 读写 ──────────────────────────────────────────────────────────

function findJournalEntry({ assistantId, periodType, periodStart }) {
  return db
    .prepare(
      `SELECT * FROM character_journal
        WHERE assistant_id = ? AND period_type = ? AND period_start = ?`
    )
    .get(assistantId, periodType, periodStart);
}

function insertJournalEntry({
  assistantId,
  periodType,
  periodStart,
  periodEnd,
  entryDate,
  content,
  now = Date.now(),
}) {
  const id = uuidv7();
  const maxLen = periodType === "weekly" ? 3000 : 1500;
  db.prepare(
    `INSERT INTO character_journal
        (id, assistant_id, period_type, period_start, period_end, entry_date, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, assistantId, periodType, periodStart, periodEnd, entryDate, clipText(content, maxLen), now);
  return id;
}

function listJournalEntries({ assistantId, periodType, limit = 20 }) {
  if (!assistantId) return [];
  const rows = db
    .prepare(
      `SELECT id, assistant_id, period_type, period_start, period_end, entry_date,
              content, created_at
         FROM character_journal
        WHERE assistant_id = ?
          ${periodType ? "AND period_type = ?" : ""}
        ORDER BY created_at DESC
        LIMIT ?`
    )
    .all(...(periodType ? [assistantId, periodType, limit] : [assistantId, limit]));
  return rows;
}

function getJournalEntryById(id) {
  return db.prepare("SELECT * FROM character_journal WHERE id = ?").get(id);
}

function listDailyJournalAssistants() {
  return db
    .prepare(
      "SELECT assistant_id, character_name, character_background, enable_daily_journal, enable_weekly_journal " +
        "FROM assistant_profile WHERE enable_daily_journal = 1"
    )
    .all();
}

function listWeeklyJournalAssistants() {
  return db
    .prepare(
      "SELECT assistant_id, character_name, character_background, enable_daily_journal, enable_weekly_journal " +
        "FROM assistant_profile WHERE enable_weekly_journal = 1"
    )
    .all();
}

function updateJournalSettings({ assistantId, enableDaily, enableWeekly }) {
  const profile = getAssistantProfile(assistantId);
  if (!profile) return null;
  const fields = [];
  const vals = [];
  if (typeof enableDaily === "boolean") {
    fields.push("enable_daily_journal = ?");
    vals.push(enableDaily ? 1 : 0);
  }
  if (typeof enableWeekly === "boolean") {
    fields.push("enable_weekly_journal = ?");
    vals.push(enableWeekly ? 1 : 0);
  }
  if (!fields.length) return profile;
  fields.push("updated_at = ?");
  vals.push(Date.now());
  vals.push(assistantId);
  db.prepare(`UPDATE assistant_profile SET ${fields.join(", ")} WHERE assistant_id = ?`).run(...vals);
  return getAssistantProfile(assistantId);
}

// ── 生成 ─────────────────────────────────────────────────────────────

/**
 * 给某个 assistant 生成单条 journal。periodStart/End 不传走 cron 默认窗口（昨日 / 上周）。
 *
 * force=true 时即使已有同窗口 entry 也会 skip（UNIQUE 约束兜底）—— 想覆盖
 * 必须先删旧条目。这是有意的：journal 是叙事性产物，重写会丢"那时刻的视角"。
 */
async function generateJournalFor({
  assistantId,
  periodType,
  periodStart,
  periodEnd,
  entryDate,
  force = false,
  now = Date.now(),
}) {
  if (periodType !== "daily" && periodType !== "weekly") {
    return { ok: false, skipped: "invalid_period_type" };
  }

  if (periodStart == null || periodEnd == null || !entryDate) {
    const win = periodType === "weekly" ? computeWeeklyWindow(now) : computeDailyWindow(now);
    periodStart = periodStart ?? win.periodStart;
    periodEnd = periodEnd ?? win.periodEnd;
    entryDate = entryDate || win.entryDate;
  }

  const profile = getAssistantProfile(assistantId);
  if (!profile) return { ok: false, skipped: "no_profile" };

  // force 模式不校验 enable_* 开关（admin 调试用），cron 路径才校验
  if (!force) {
    const flag = periodType === "daily" ? profile.enable_daily_journal : profile.enable_weekly_journal;
    if (flag !== 1) return { ok: false, skipped: "journal_disabled" };
  }

  const existing = findJournalEntry({ assistantId, periodType, periodStart });
  if (existing) return { ok: false, skipped: "already_exists", entryId: existing.id };

  const turns = fetchTurnsInWindow(assistantId, periodStart, periodEnd);
  const episodes = fetchEpisodesInWindow(assistantId, periodStart, periodEnd);
  const reflections = periodType === "weekly"
    ? fetchReflectionsInWindow(assistantId, periodStart, periodEnd)
    : [];

  // 完全空素材：没必要硬凑 LLM 调用
  if (!turns.length && !episodes.length && !reflections.length) {
    return { ok: false, skipped: "no_material", periodStart, periodEnd };
  }

  const { turnLines, epLines, reflLines } = _renderMaterialLines({
    turns, episodes, reflections, periodType,
  });
  const characterBackground = profile.character_background || "";
  const periodStartLabel = formatLocalDate(periodStart);
  const periodEndLabel = formatLocalDate(periodEnd);

  // ── step 1: reflect —— 从素材里抽主线 / 情绪走向 / 瞬间 / 悬念 ──
  const reflectPrompt = buildReflectPrompt({
    periodType,
    characterBackground,
    turnLines,
    epLines,
    reflLines,
    periodStartLabel,
    periodEndLabel,
  });
  let reflection;
  try {
    const rawRefl = await callLlmForReflection(reflectPrompt, { assistantId, periodType });
    reflection = normalizeReflection(rawRefl);
  } catch (e) {
    return { ok: false, skipped: "llm_unreachable", error: e.message, stage: "reflect" };
  }

  const hasReflectionContent =
    reflection.themes.length || reflection.notableMoments.length || reflection.emotionalArc;
  if (!hasReflectionContent) {
    return { ok: false, skipped: "reflection_empty", periodStart, periodEnd };
  }

  // ── step 2: narrate —— 围绕反思要点写第一人称叙事 ──
  const narratePrompt = buildNarratePrompt({
    periodType,
    characterBackground,
    reflection,
    turnLines,
    epLines,
    periodStartLabel,
    periodEndLabel,
  });
  let raw;
  try {
    raw = await callLlmForNarrate(narratePrompt, { assistantId, periodType });
  } catch (e) {
    return { ok: false, skipped: "llm_unreachable", error: e.message, stage: "narrate" };
  }

  const content = clipText(raw?.content || "", periodType === "weekly" ? 3000 : 1500);
  if (!content || content.length < 20) {
    return { ok: false, skipped: "content_too_short", contentLen: content.length };
  }

  const id = insertJournalEntry({
    assistantId,
    periodType,
    periodStart,
    periodEnd,
    entryDate,
    content,
    now,
  });

  return {
    ok: true,
    entryId: id,
    periodStart,
    periodEnd,
    entryDate,
    contentLen: content.length,
    // reflection 留给调用方查看（admin / 调试）。落盘只存 content，reflection 是过程产物。
    reflection,
  };
}

// ── cron ticks ───────────────────────────────────────────────────────

async function runDailyJournalTick({ now = Date.now() } = {}) {
  const assistants = listDailyJournalAssistants();
  const summary = { scanned: assistants.length, generated: 0, results: [] };
  const win = computeDailyWindow(now);
  for (const a of assistants) {
    try {
      const r = await generateJournalFor({
        assistantId: a.assistant_id,
        periodType: "daily",
        periodStart: win.periodStart,
        periodEnd: win.periodEnd,
        entryDate: win.entryDate,
        now,
      });
      if (r.ok) summary.generated += 1;
      summary.results.push({ assistantId: a.assistant_id, ...r });
    } catch (err) {
      summary.results.push({ assistantId: a.assistant_id, error: err.message });
    }
  }
  return summary;
}

async function runWeeklyJournalTick({ now = Date.now() } = {}) {
  const assistants = listWeeklyJournalAssistants();
  const summary = { scanned: assistants.length, generated: 0, results: [] };
  const win = computeWeeklyWindow(now);
  for (const a of assistants) {
    try {
      const r = await generateJournalFor({
        assistantId: a.assistant_id,
        periodType: "weekly",
        periodStart: win.periodStart,
        periodEnd: win.periodEnd,
        entryDate: win.entryDate,
        now,
      });
      if (r.ok) summary.generated += 1;
      summary.results.push({ assistantId: a.assistant_id, ...r });
    } catch (err) {
      summary.results.push({ assistantId: a.assistant_id, error: err.message });
    }
  }
  return summary;
}

module.exports = {
  // 生成入口
  generateJournalFor,
  runDailyJournalTick,
  runWeeklyJournalTick,
  // DB 查询
  listJournalEntries,
  getJournalEntryById,
  // 设置
  updateJournalSettings,
  // 工具（admin / 调试用）
  computeDailyWindow,
  computeWeeklyWindow,
};
