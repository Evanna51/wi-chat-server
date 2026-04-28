const { v7: uuidv7 } = require("uuid");
const { getProvider } = require("../llm");
const { buildStatePromptFragment } = require("./characterStateService");
const {
  getAssistantProfile,
  getRecentTurnsAcrossSessions,
  getRecentMemoryItems,
  getConfidentFactsForAssistant,
  insertMemoryItem,
  insertOutboxEvent,
  insertBehaviorJournalEntry,
} = require("../db");
const {
  maxJaccardAgainst,
  isGenericSummary,
} = require("./textDedupService");

function clipText(input = "", maxLen = 240) {
  const text = String(input || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatHumanTs(ts) {
  if (!ts) return "未知";
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}`;
}

function parseAbsTimeToMs(absTime, windowStart, windowEnd) {
  const text = String(absTime || "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  // Walk day-by-day from windowStart's day to windowEnd's day, return first match in window.
  const startDate = new Date(windowStart);
  const endDate = new Date(windowEnd);
  const dayMs = 24 * 60 * 60 * 1000;
  for (
    let d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate()).getTime();
    d <= endDate.getTime() + dayMs;
    d += dayMs
  ) {
    const dayStart = new Date(d);
    const candidate = new Date(
      dayStart.getFullYear(),
      dayStart.getMonth(),
      dayStart.getDate(),
      hh,
      mm,
      0,
      0
    ).getTime();
    if (candidate >= windowStart && candidate <= windowEnd) return candidate;
  }
  // Fallback: spread evenly inside window if absTime not reachable.
  return null;
}

function spreadFallbackTimestamps(events, windowStart, windowEnd) {
  const n = events.length;
  if (!n) return events;
  const span = Math.max(1, windowEnd - windowStart);
  return events.map((ev, idx) => {
    if (ev.absMs) return ev;
    const ts = windowStart + Math.round(((idx + 1) / (n + 1)) * span);
    return { ...ev, absMs: ts };
  });
}

function buildCatchupPrompt({
  characterName,
  characterBackground,
  lastInteractionAt,
  now,
  durationHours,
  recentTurns,
  recentMemories,
  userFacts,
  nEvents,
  anchorMin,
  seed,
  stateFragment,
}) {
  const turnLines = recentTurns
    .slice(0, 6)
    .map((t) => `- ${t.role}: ${clipText(t.content, 140)}`)
    .join("\n");
  const memLines = recentMemories
    .slice(0, 12)
    .map((m) => {
      const t = new Date(m.created_at);
      const HH = String(t.getHours()).padStart(2, "0");
      const MM = String(t.getMinutes()).padStart(2, "0");
      return `- [${HH}:${MM} ${m.memory_type}] ${clipText(m.content, 140)}`;
    })
    .join("\n");
  const factLines = userFacts
    .slice(0, 12)
    .map((f) => `- ${f.fact_key}=${clipText(f.fact_value, 80)}`)
    .join("\n");

  return [
    `你正在为 AI 角色「${characterName}」写一份"在用户不在的这段时间里发生了什么"的私人日记。这是给角色自己的内部记录，不是要发给用户的内容。`,
    "",
    ...(stateFragment ? [stateFragment, ""] : []),
    "【时间窗】",
    `开始：${formatHumanTs(lastInteractionAt)}（${lastInteractionAt} 时间戳）`,
    `现在：${formatHumanTs(now)}（${now} 时间戳）`,
    `跨度：${durationHours} 小时`,
    "",
    "【角色档案】",
    clipText(characterBackground || "无", 800),
    "",
    "【最近 6 条对话】",
    turnLines || "- 无",
    "",
    "【角色之前已经发生的事情，本次必须避开重复主题或动作】",
    memLines || "- 无",
    "",
    "【已知用户事实】",
    factLines || "- 无",
    "",
    "【生成要求】",
    `1. 输出 ${nEvents} 条事件，按 absTime 升序`,
    "2. 每条 20-50 字，必须含**具体的人/事/物**：写\"和老李在 7 楼吵了一架\"，不写\"和同事产生了分歧\"",
    `3. 至少有 ${anchorMin} 条事件要呼应"最近对话"或"用户事实"——比如用户提到学羽毛球，角色今天可以在路上想到这件事`,
    "4. 时间分布合理：吃饭、通勤、休息、走神都可以，不要全是工作",
    "5. **禁止**出现以下空话：\"思考人生\"\"享受时光\"\"感受美好\"\"内心平静\"\"微笑了\"\"陷入回忆\"\"若有所思\"",
    "6. **禁止**与\"已经发生过的事情\"列表中任何一条主题/动作重复：如果之前已经\"喝咖啡\"过，本次不能再写\"喝咖啡\"，要换具体动作",
    "7. 风格语气与角色背景一致",
    "",
    `【random_seed】 ${seed}`,
    "",
    "严格输出 JSON（不要任何额外文本，不要 markdown 代码块包裹）：",
    "{",
    '  "events": [',
    "    {",
    '      "absTime": "HH:MM",',
    '      "memoryType": "life_event" | "work_event",',
    '      "summary": "<20-50 字的事件描述>",',
    '      "anchorRef": "<本条引用了哪条对话/fact 的关键词，没有就空字符串>",',
    '      "whyNow": "<snake_case_reason 用于审计，比如 user_mentioned_badminton_3d_ago>"',
    "    }",
    "  ]",
    "}",
  ].join("\n");
}

function parseStrictJsonObject(text = "") {
  const normalized = String(text || "").trim();
  const fenced = normalized.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("catchup ai output missing json object");
  }
  const parsed = JSON.parse(fenced.slice(start, end + 1));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("catchup ai output not json object");
  }
  return parsed;
}

async function callLlmForCatchup(prompt, { temperature = 0.8, maxTokens = 900 } = {}) {
  const { content } = await getProvider().complete({
    messages: [{ role: "user", content: prompt }],
    temperature,
    maxTokens,
    responseFormat: "json",
  });
  return parseStrictJsonObject(content);
}

function normalizeEvents(rawEvents = [], { windowStart, windowEnd }) {
  if (!Array.isArray(rawEvents)) return [];
  const out = [];
  for (const raw of rawEvents) {
    if (!raw || typeof raw !== "object") continue;
    const summary = clipText(raw.summary || "", 200);
    if (!summary) continue;
    const memoryType = raw.memoryType === "work_event" ? "work_event" : "life_event";
    const absMs = parseAbsTimeToMs(raw.absTime, windowStart, windowEnd);
    out.push({
      absTime: String(raw.absTime || ""),
      absMs,
      memoryType,
      summary,
      anchorRef: clipText(raw.anchorRef || "", 80),
      whyNow: clipText(raw.whyNow || "unspecified", 100),
    });
  }
  // Spread fallback for events without parseable absTime.
  const filled = spreadFallbackTimestamps(out, windowStart, windowEnd);
  filled.sort((a, b) => (a.absMs || 0) - (b.absMs || 0));
  return filled;
}

function evaluateEvents(events, recentMemoryContents) {
  const accepted = [];
  const dropped = [];
  for (const ev of events) {
    const reasons = [];
    if (isGenericSummary(ev.summary)) {
      reasons.push("generic_summary");
    }
    const score = maxJaccardAgainst(ev.summary, recentMemoryContents);
    if (score > 0.5) {
      reasons.push(`jaccard_against_recent:${score.toFixed(2)}`);
    }
    // Also dedup against already-accepted in this batch.
    const intraScore = accepted.length
      ? maxJaccardAgainst(
          ev.summary,
          accepted.map((a) => a.summary)
        )
      : 0;
    if (intraScore > 0.5) {
      reasons.push(`jaccard_intra_batch:${intraScore.toFixed(2)}`);
    }
    if (reasons.length) {
      dropped.push({ ...ev, droppedReason: reasons.join("|") });
    } else {
      accepted.push(ev);
    }
  }
  return { accepted, dropped };
}

async function runCatchup({
  assistantId,
  lastInteractionAt,
  now = Date.now(),
  maxEvents = 5,
}) {
  if (!assistantId) {
    return { ok: false, generated: 0, reason: "missing_assistant_id" };
  }
  const lastTs = Number(lastInteractionAt);
  if (!Number.isFinite(lastTs) || lastTs <= 0) {
    return { ok: false, generated: 0, reason: "invalid_last_interaction_at" };
  }
  const gap = now - lastTs;
  const windowMs = gap;
  if (gap < 60 * 60 * 1000) {
    return { ok: true, generated: 0, reason: "gap_too_short", windowMs };
  }
  const cap = clamp(Number(maxEvents) || 5, 1, 8);
  const nEvents = clamp(Math.round(gap / (90 * 60 * 1000)), 1, cap);
  const anchorMin = Math.max(1, Math.floor(nEvents / 2));
  const durationHours = Math.round((gap / (60 * 60 * 1000)) * 10) / 10;

  const profile = getAssistantProfile(assistantId);
  if (!profile) {
    return { ok: false, generated: 0, reason: "assistant_not_found" };
  }
  const characterName = profile.character_name || assistantId;
  const characterBackground = profile.character_background || "";

  const recentTurns = getRecentTurnsAcrossSessions({ assistantId, limit: 8 });
  const recentMemories = getRecentMemoryItems({
    assistantId,
    memoryTypes: ["life_event", "work_event"],
    limit: 12,
  });
  const userFacts = getConfidentFactsForAssistant({
    assistantId,
    minConfidence: 0.5,
    limit: 30,
  });

  const recentMemoryContents = recentMemories.map((m) => m.content);

  const seedBase = `${assistantId}:${now}`;
  let seed = seedBase;
  let lastError = null;
  let lastDecision = null;

  const attempts = [
    { temperature: 0.8, top_p: 0.95 },
    { temperature: 0.95, top_p: 0.95 },
  ];

  for (let attemptIdx = 0; attemptIdx < attempts.length; attemptIdx += 1) {
    const params = attempts[attemptIdx];
    seed = `${seedBase}:a${attemptIdx}`;
    const prompt = buildCatchupPrompt({
      characterName,
      characterBackground,
      lastInteractionAt: lastTs,
      now,
      durationHours,
      recentTurns,
      recentMemories,
      userFacts,
      nEvents,
      anchorMin,
      seed,
      stateFragment: buildStatePromptFragment(assistantId, now),
    });

    let parsed;
    try {
      parsed = await callLlmForCatchup(prompt, {
        temperature: params.temperature,
        topP: params.top_p,
        maxTokens: 900,
      });
    } catch (error) {
      lastError = error;
      // One transient retry inside this attempt before bumping temperature.
      try {
        parsed = await callLlmForCatchup(prompt, {
          temperature: params.temperature,
          topP: params.top_p,
          maxTokens: 900,
        });
        lastError = null;
      } catch (error2) {
        lastError = error2;
        continue;
      }
    }

    const events = normalizeEvents(parsed.events || [], {
      windowStart: lastTs,
      windowEnd: now,
    });
    const { accepted, dropped } = evaluateEvents(events, recentMemoryContents);
    lastDecision = { events, accepted, dropped, attempt: attemptIdx };

    if (dropped.length > Math.floor(nEvents / 2) && attemptIdx < attempts.length - 1) {
      // Too many duplicates; retry with higher temperature.
      continue;
    }

    if (accepted.length === 0) {
      // Final attempt yielded nothing usable.
      insertBehaviorJournalEntry({
        runType: "catchup_tick",
        assistantId,
        sessionId: profile.last_session_id || null,
        shouldPersist: false,
        status: "dedup_rejected",
        reason: "all_duplicates",
        input: {
          now,
          lastInteractionAt: lastTs,
          gapMs: gap,
          nEventsRequested: nEvents,
          attempt: attemptIdx,
        },
        result: {
          nGenerated: 0,
          nDroppedByDedup: dropped.length,
          dropped: dropped.slice(0, 8),
        },
        createdAt: now,
      });
      return {
        ok: true,
        generated: 0,
        reason: "all_duplicates",
        windowMs,
        nDropped: dropped.length,
      };
    }

    // Persist accepted events.
    const inserted = [];
    for (const ev of accepted) {
      const sourceTurnId = `auto-catchup:${uuidv7()}`;
      const memoryId = insertMemoryItem({
        assistantId,
        sessionId: profile.last_session_id || `persona:${assistantId}`,
        sourceTurnId,
        content: ev.summary,
        memoryType: ev.memoryType,
        salience: clamp(0.5, 0.5, 0.85),
        confidence: 0.7,
      });
      // Override created_at to match the absMs (within window).
      try {
        require("../db").db
          .prepare(
            "UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?"
          )
          .run(ev.absMs, ev.absMs, memoryId);
      } catch (e) {
        // ignore — keep default created_at if update fails
      }
      insertOutboxEvent({
        eventType: "memory_item.created",
        aggregateType: "memory_item",
        aggregateId: memoryId,
        dedupeKey: `memory-index:${memoryId}`,
        payload: { memoryId },
      });
      inserted.push({
        id: memoryId,
        memoryType: ev.memoryType,
        content: ev.summary,
        createdAt: ev.absMs,
        anchorRef: ev.anchorRef,
        whyNow: ev.whyNow,
      });
    }

    insertBehaviorJournalEntry({
      runType: "catchup_tick",
      assistantId,
      sessionId: profile.last_session_id || null,
      shouldPersist: true,
      status: "ok",
      reason: "catchup_generated",
      input: {
        now,
        lastInteractionAt: lastTs,
        gapMs: gap,
        nEventsRequested: nEvents,
        attempt: attemptIdx,
      },
      result: {
        nGenerated: inserted.length,
        nDroppedByDedup: dropped.length,
        memoryIds: inserted.map((i) => i.id),
      },
      createdAt: now,
    });

    return {
      ok: true,
      generated: inserted.length,
      memories: inserted,
      windowMs,
      nDropped: dropped.length,
      attempt: attemptIdx,
    };
  }

  // All attempts failed (LLM unreachable / json parse failure).
  insertBehaviorJournalEntry({
    runType: "catchup_tick",
    assistantId,
    sessionId: profile.last_session_id || null,
    shouldPersist: false,
    status: "error",
    reason: "llm_unreachable",
    input: {
      now,
      lastInteractionAt: lastTs,
      gapMs: gap,
      nEventsRequested: nEvents,
    },
    result: {
      nGenerated: 0,
      nDroppedByDedup: lastDecision ? lastDecision.dropped.length : 0,
    },
    errorMessage: lastError ? lastError.message : "",
    createdAt: now,
  });

  return {
    ok: false,
    generated: 0,
    reason: "llm_unreachable",
    error: lastError ? lastError.message : "",
    windowMs,
  };
}

module.exports = { runCatchup };
