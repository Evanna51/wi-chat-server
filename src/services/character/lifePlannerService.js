/**
 * lifePlannerService — 每天 04:00 给每个 active 角色生成今日时间表
 *
 * 输出：10-20 条 beat，每条 = (scheduled_at, activity, beat_type, importance, reach_seed?)。
 * 落 character_life_beat 表（pending），由 lifeBeatTickService 到点 → 入库 + 视情触发 proactive。
 *
 * 设计文档：docs/character-life-beat-plan.md
 *
 * 重点：
 *   - LLM 视角是"我（角色）今天会经历的一天"，不是"我给用户写日程"
 *   - 大部分 beat 是 autonomous（喝咖啡、通勤、走神），少数 anchored（联想到 她 说过的事）
 *   - 睡眠时段必须空着（identity 或 assistant_profile.life_sleep_hours 推断）
 *   - importance 由 LLM 自评 0-1，仅 anchored + ≥ 0.5 才会进 proactive 触发候选
 *
 * 触发途径：
 *   1. scheduler 的 daily-life-plan cron（每天 04:00 跑所有 allow_auto_life=1 角色）
 *   2. lazy 兜底：chat hot path 检测到当日无 plan → 调 generateLifePlanFor 单跑
 *   3. scripts/run-life-planner.js（debug）
 */

const {
  db,
  getAssistantProfile,
  getRecentTurnsAcrossSessions,
  getRecentMemoryItems,
  getConfidentFactsForAssistant,
  listAutoLifeAssistantProfiles,
  insertLifeBeat,
  insertBehaviorJournalEntry,
  expireStaleLifeBeats,
  hasLifePlanForDate,
} = require("../../db");
const { getIntrospectionProvider } = require("../../llm");
const { renderBackgroundForIntrospection } = require("./promptComposer");
const { getCharacterIdentity, buildIdentityPromptFragment } = require("./identityService");

// ── 文本 / JSON ──────────────────────────────────────────────────────

function clipText(input = "", maxLen = 240) {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseStrictJsonObject(text = "") {
  const normalized = String(text || "").trim();
  const fenced = normalized.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("life-plan ai output missing json object");
  const parsed = JSON.parse(fenced.slice(start, end + 1));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("life-plan ai output not json object");
  }
  return parsed;
}

// ── 本地时间 ─────────────────────────────────────────────────────────
// 项目 TZ=Asia/Shanghai（ecosystem.config.js 强制），Date.getX 都是本地。

function formatLocalDate(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * "HH:MM" + 本地 plan_date → ms epoch。
 * 跨日（如 02:30 但属于"夜班 beat"）由 LLM 在同日 schedule 里自己解决，这里只
 * 老老实实把 HH:MM 落到 plan_date 当天。
 */
function hhmmToMsForDate(hhmm, planDate) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  const [y, mo, dd] = planDate.split("-").map(Number);
  const d = new Date(y, mo - 1, dd, hh, mm, 0, 0);
  return d.getTime();
}

function isWeekend(planDate) {
  const [y, m, d] = planDate.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 || dow === 6;
}

function dayOfWeekLabel(planDate) {
  const [y, m, d] = planDate.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][dow];
}

// ── 素材拉取 ─────────────────────────────────────────────────────────

function fetchYesterdayBeats(assistantId, planDate) {
  // 给 LLM "你昨天大概是这样过的" 作为对照，避免今日 plan 与昨日完全重复
  const yesterday = (() => {
    const [y, m, d] = planDate.split("-").map(Number);
    const dd = new Date(y, m - 1, d);
    dd.setDate(dd.getDate() - 1);
    return formatLocalDate(dd.getTime());
  })();
  return db
    .prepare(
      `SELECT scheduled_at, activity, beat_type, status
         FROM character_life_beat
        WHERE assistant_id = ? AND plan_date = ?
        ORDER BY scheduled_at ASC`
    )
    .all(assistantId, yesterday);
}

// ── Prompt ───────────────────────────────────────────────────────────

function buildLifePlanPrompt({
  characterBackground,
  identityFragment,
  planDate,
  isWeekendDay,
  dowLabel,
  sleepHours,
  recentTurns,
  recentMemories,
  userFacts,
  yesterdayBeats,
  nMin,
  nMax,
  seed,
}) {
  const turnLines = recentTurns
    .slice(0, 8)
    .map((t) => `- ${t.role === "user" ? "她" : "你"}：${clipText(t.content, 100)}`)
    .join("\n");
  const memLines = recentMemories
    .slice(0, 10)
    .map((m) => `- [${m.memory_type}] ${clipText(m.content, 100)}`)
    .join("\n");
  const factLines = userFacts
    .slice(0, 12)
    .map((f) => `- ${f.fact_key}=${clipText(f.fact_value, 60)}`)
    .join("\n");
  const yLines = yesterdayBeats
    .slice(0, 12)
    .map((b) => {
      const t = new Date(b.scheduled_at);
      const HH = String(t.getHours()).padStart(2, "0");
      const MM = String(t.getMinutes()).padStart(2, "0");
      return `- ${HH}:${MM} [${b.beat_type}] ${clipText(b.activity, 80)}`;
    })
    .join("\n");

  return [
    '你是这个角色。请规划"今天"你自己的一天 —— 不是给用户安排，是你作为这个角色会经历的具体时刻。',
    "",
    ...(identityFragment ? [identityFragment, ""] : []),
    "【角色档案】",
    renderBackgroundForIntrospection(characterBackground, 600),
    "",
    `【今天】${planDate}（${dowLabel}${isWeekendDay ? "，周末" : "，工作日"}）`,
    sleepHours ? `【你的作息】睡眠 ${sleepHours}（这段时间不要安排任何 beat）` : "【你的作息】没有显式配置 —— 按你自己的身份判断；至少留 6 小时连续睡眠空白",
    "",
    "【最近和 她 的对话采样】",
    turnLines || "- 无",
    "",
    "【你之前最近的记忆片段】",
    memLines || "- 无",
    "",
    "【她 的事实（已知信息）】",
    factLines || "- 无",
    "",
    "【你昨天的时间表（仅作参考，今天不要照抄）】",
    yLines || "- 无",
    "",
    "【生成要求】",
    `1. 输出 ${nMin}-${nMax} 条 beat，按 absTime 升序，覆盖一天（起床后到睡前），睡眠时段空白`,
    '2. 每条 beat 是一个"具体时刻 + 你在做什么"，活动 15-40 字，必须有**具体人/事/物/场景**',
    `   ✅ "在便利店买冰美式，店员换了"  ✅ "在公司茶水间被同事拉去吐槽老板"`,
    `   ❌ "享受时光"  ❌ "思考人生"  ❌ "感受美好"  ❌ "陷入回忆"  ❌ "若有所思"`,
    "3. beat_type：",
    "   - autonomous：你自己的独立时刻，跟用户无关。占大多数（>= 60%）",
    '   - anchored：你"想到了" 她 —— 但触发点必须是【对话采样】或【ta 的事实】里实际出现过的细节，',
    "                而不是你凭空假设 她 的喜好。anchored beat 必须填 reachSeed（你想到的具体是 她 的哪句话/哪个事实）",
    "4. importance 0-1：",
    "   - 大多数 autonomous = 0.2-0.4（日常）",
    "   - 普通 anchored = 0.4-0.5",
    "   - 重要 anchored（看到 她 提过的东西、做了 她 提过想做的事、发生了想跟 她 分享的事）= 0.6-0.85",
    "5. 时间分布：吃饭/通勤/工作/休息/走神都可以；不要全部塞工作；不要每个 beat 间隔完全均匀",
    '6. **禁止凭空假设 她 的喜好**：除非【她 的事实】里写了，否则不要写"给 她 买 她 爱的 X"。',
    '   可以写"我想到 她 上次说想吃 X 我就也点了一份"——前提是 她 真的说过',
    '7. anchored 的 reachSeed 要写**具体引用**：例如"她 上次提想试燕麦拿铁"而不是"她 喜欢咖啡"',
    "",
    `【random_seed】 ${seed}`,
    "",
    "严格输出 JSON（不要任何额外文本，不要 markdown 代码块包裹）：",
    "{",
    '  "beats": [',
    "    {",
    '      "absTime": "HH:MM",',
    '      "activity": "<15-40 字>",',
    '      "beatType": "autonomous" | "anchored",',
    '      "reachSeed": "<anchored 时填，引用具体的对话/事实关键词；autonomous 留空字符串>",',
    '      "importance": <0..1>',
    "    }",
    "  ]",
    "}",
  ].join("\n");
}

// ── LLM 调用 ─────────────────────────────────────────────────────────

async function callLlmForLifePlan(prompt, { assistantId, temperature = 0.85 } = {}) {
  const provider = getIntrospectionProvider();
  const { content } = await provider.complete({
    messages: [
      {
        role: "system",
        content:
          "你是角色生活规划器。以角色第一人称视角规划今日时间表。输出严格 JSON，不要 markdown 代码块。",
      },
      { role: "user", content: prompt },
    ],
    temperature,
    maxTokens: 1800,
    responseFormat: "json",
    callOpts: {
      kind: "life_plan",
      scopeKey: assistantId || null,
      summary: `life-plan for ${assistantId || "unknown"}`,
    },
  });
  return parseStrictJsonObject(content);
}

// ── 规范化 ───────────────────────────────────────────────────────────

function normalizeBeats(rawBeats, planDate, { now = Date.now() } = {}) {
  if (!Array.isArray(rawBeats)) return [];
  const out = [];
  const seenTime = new Set();
  for (const raw of rawBeats) {
    if (!raw || typeof raw !== "object") continue;
    const activity = clipText(raw.activity || "", 200);
    if (!activity) continue;
    const scheduledAt = hhmmToMsForDate(raw.absTime, planDate);
    if (!scheduledAt) continue;
    // 排重同一时刻（LLM 偶尔重复 HH:MM）
    if (seenTime.has(scheduledAt)) continue;
    seenTime.add(scheduledAt);
    const beatType = raw.beatType === "anchored" ? "anchored" : "autonomous";
    const importanceRaw = Number(raw.importance);
    const importance = Number.isFinite(importanceRaw) ? clamp(importanceRaw, 0, 1) : 0.4;
    const reachSeed = beatType === "anchored" ? clipText(raw.reachSeed || "", 200) : null;
    out.push({
      scheduledAt,
      activity,
      beatType,
      importance,
      reachSeed,
    });
  }
  out.sort((a, b) => a.scheduledAt - b.scheduledAt);
  return out;
}

// ── 单角色生成 ───────────────────────────────────────────────────────

/**
 * 给某个 assistant 生成今日 plan。
 *
 * @param {object} opts
 * @param {string} opts.assistantId
 * @param {string} [opts.planDate]  'YYYY-MM-DD' 本地日；默认今日
 * @param {boolean} [opts.force]    true 时即使已有 plan 也重新生成（先 expire 旧的）
 * @param {number} [opts.now]
 */
async function generateLifePlanFor({
  assistantId,
  planDate = null,
  force = false,
  now = Date.now(),
}) {
  if (!assistantId) return { ok: false, reason: "missing_assistant_id" };

  const profile = getAssistantProfile(assistantId);
  if (!profile) return { ok: false, reason: "no_profile" };

  const effectivePlanDate = planDate || formatLocalDate(startOfLocalDay(now));

  // 已存在且非 force → skip
  if (!force && hasLifePlanForDate({ assistantId, planDate: effectivePlanDate })) {
    return { ok: false, skipped: "already_planned", planDate: effectivePlanDate };
  }

  const characterBackground = profile.character_background || "";
  const sleepHours = profile.life_sleep_hours || null;
  const isWeekendDay = isWeekend(effectivePlanDate);
  const dowLabel = dayOfWeekLabel(effectivePlanDate);

  const recentTurns = getRecentTurnsAcrossSessions({ assistantId, limit: 10 });
  const recentMemories = getRecentMemoryItems({
    assistantId,
    memoryTypes: ["life_event", "work_event", "life_event_autonomous"],
    limit: 12,
  });
  const userFacts = getConfidentFactsForAssistant({
    assistantId,
    minConfidence: 0.5,
    limit: 30,
    characterName: profile.character_name,
  });
  const yesterdayBeats = fetchYesterdayBeats(assistantId, effectivePlanDate);

  const identity = getCharacterIdentity(assistantId);
  const identityFragment = identity ? buildIdentityPromptFragment(identity) : "";

  const nMin = isWeekendDay ? 8 : 10;
  const nMax = 18;
  const seed = `${assistantId}:${effectivePlanDate}`;

  const prompt = buildLifePlanPrompt({
    characterBackground,
    identityFragment,
    planDate: effectivePlanDate,
    isWeekendDay,
    dowLabel,
    sleepHours,
    recentTurns,
    recentMemories,
    userFacts,
    yesterdayBeats,
    nMin,
    nMax,
    seed,
  });

  let parsed;
  try {
    parsed = await callLlmForLifePlan(prompt, { assistantId });
  } catch (err) {
    insertBehaviorJournalEntry({
      runType: "life_plan_tick",
      assistantId,
      sessionId: profile.last_session_id || null,
      shouldPersist: false,
      status: "error",
      reason: "llm_unreachable",
      input: { planDate: effectivePlanDate, nMin, nMax },
      result: {},
      errorMessage: err.message || String(err),
      createdAt: now,
    });
    return { ok: false, reason: "llm_unreachable", error: err.message };
  }

  const beats = normalizeBeats(parsed.beats || [], effectivePlanDate, { now });
  if (!beats.length) {
    insertBehaviorJournalEntry({
      runType: "life_plan_tick",
      assistantId,
      sessionId: profile.last_session_id || null,
      shouldPersist: false,
      status: "llm_empty",
      reason: "no_beats_generated",
      input: { planDate: effectivePlanDate, nMin, nMax },
      result: { nRaw: Array.isArray(parsed.beats) ? parsed.beats.length : 0 },
      createdAt: now,
    });
    return { ok: false, reason: "no_beats_generated", planDate: effectivePlanDate };
  }

  // force 重跑：先 expire 当日所有旧 pending；activated 不动（已经发生）
  if (force) {
    db.prepare(
      `UPDATE character_life_beat
          SET status = 'expired'
        WHERE assistant_id = ? AND plan_date = ? AND status = 'pending'`
    ).run(assistantId, effectivePlanDate);
  }

  let inserted = 0;
  for (const b of beats) {
    const id = insertLifeBeat({
      assistantId,
      planDate: effectivePlanDate,
      scheduledAt: b.scheduledAt,
      activity: b.activity,
      beatType: b.beatType,
      reachSeed: b.reachSeed,
      importance: b.importance,
      createdAt: now,
    });
    if (id) inserted += 1;
  }

  insertBehaviorJournalEntry({
    runType: "life_plan_tick",
    assistantId,
    sessionId: profile.last_session_id || null,
    shouldPersist: true,
    status: "ok",
    reason: force ? "force_regenerated" : "generated",
    input: { planDate: effectivePlanDate, nMin, nMax },
    result: {
      nBeats: inserted,
      nAnchored: beats.filter((b) => b.beatType === "anchored").length,
      nAutonomous: beats.filter((b) => b.beatType === "autonomous").length,
    },
    createdAt: now,
  });

  return {
    ok: true,
    planDate: effectivePlanDate,
    nBeats: inserted,
    sample: beats.slice(0, 3).map((b) => {
      const t = new Date(b.scheduledAt);
      return {
        absTime: `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`,
        activity: b.activity,
        beatType: b.beatType,
        importance: b.importance,
      };
    }),
  };
}

// ── cron tick ────────────────────────────────────────────────────────

/**
 * Cron 入口（daily-life-plan）：扫所有 allow_auto_life=1 的角色，给每个生成今日 plan。
 *
 * 串行调 LLM 避免 introspection LLM rate limit。开始前先把"昨天及更早"的 pending
 * beat 全部 expire（卫生）。
 */
async function runDailyLifePlanTick({ now = Date.now() } = {}) {
  const planDate = formatLocalDate(startOfLocalDay(now));
  const expired = expireStaleLifeBeats({ beforePlanDate: planDate });

  const assistants = listAutoLifeAssistantProfiles();
  const summary = {
    scanned: assistants.length,
    generated: 0,
    skipped: 0,
    errors: 0,
    expiredBeats: expired,
    planDate,
    results: [],
  };
  for (const a of assistants) {
    try {
      const r = await generateLifePlanFor({
        assistantId: a.assistant_id,
        planDate,
        now,
      });
      if (r.ok) summary.generated += 1;
      else if (r.skipped) summary.skipped += 1;
      else summary.errors += 1;
      summary.results.push({ assistantId: a.assistant_id, ...r });
    } catch (err) {
      summary.errors += 1;
      summary.results.push({ assistantId: a.assistant_id, error: err.message });
    }
  }
  return summary;
}

module.exports = {
  generateLifePlanFor,
  runDailyLifePlanTick,
  // 暴露给 lazy 兜底 / debug
  hasLifePlanForDate,
};
