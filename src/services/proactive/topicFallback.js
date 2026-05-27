/**
 * Web-topic fallback —— LLM 决定 skip 之后兜底跑 web search 找热点。
 *
 * 触发：scheduleNextPushPlan 里 LLM 输出 `skip: true` 时，本函数被调用。
 *
 * 三段式：
 *   1) 抽用户兴趣：top persistent_topic + 高分 memory_facts + 角色 identity.skills
 *   2) LLM 决定搜索词（1-2 条），尽量切兴趣交集
 *   3) Tavily news 搜每条 → 拿 snippet → LLM 用角色口吻写一条主动消息
 *
 * 失败任何一步都返回 { ok: false, reason }，让调用方接受原 skip。配额闸门在
 * webSearchService 里，本文件不再额外计数。
 *
 * 性能开销：约 2× LLM + 1× web search ≈ 7~13s。日均不会高频跑（仅 skip 路径
 * + 每角色 3/天封顶）。
 */

const {
  getRecentTurnsAcrossSessions,
  getConfidentFactsForAssistant,
  insertBehaviorJournalEntry,
  db,
} = require("../../db");
const { getProvider } = require("../../llm");
const {
  listActiveTopics,
} = require("../character/persistentTopicService");
const {
  getCharacterIdentity,
} = require("../character/identityService");
const { runWebSearch } = require("../webSearchService");

const {
  clipText,
  parseStrictJsonObject,
  VALID_INTENTS,
} = require("./shared");

// ── 兴趣抽取 ─────────────────────────────────────────────────────────

function _collectUserInterests(assistantId, characterName = null) {
  const topics = listActiveTopics(assistantId, { limit: 6 })
    .map((t) => t.topic)
    .filter(Boolean);

  // 高 importance 的 fact 视为长期偏好。confidence > 0.5 且按 importance 排
  const facts = getConfidentFactsForAssistant({
    assistantId,
    minConfidence: 0.5,
    limit: 20,
    characterName,
  })
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
    .slice(0, 8)
    .map((f) => `${f.fact_key}:${clipText(f.fact_value, 40)}`);

  let characterSkills = [];
  try {
    const id = getCharacterIdentity(assistantId);
    if (id && Array.isArray(id.skills)) {
      characterSkills = id.skills.map((s) => s?.name).filter(Boolean).slice(0, 5);
    }
  } catch { /* ignore */ }

  return { topics, facts, characterSkills };
}

// ── LLM 1：决定搜索词 ────────────────────────────────────────────────

function _buildQueryPrompt({ characterName, interests }) {
  const { topics, facts, characterSkills } = interests;
  return [
    `你要帮一个 AI 角色「${characterName || "角色"}」找近期热点，跟用户开启一个自然话题。`,
    "",
    "用户/角色的兴趣线索：",
    `- 长期话题：${topics.length ? topics.join("、") : "（无）"}`,
    `- 用户事实：${facts.length ? facts.join(" / ") : "（无）"}`,
    `- 角色擅长：${characterSkills.length ? characterSkills.join("、") : "（无）"}`,
    "",
    "任务：给出 1-2 个**中文**搜索词，用于搜索最近一周的新闻 / 热点，目标是找一些用户**可能感兴趣**且**适合作为聊天起点**的内容。",
    "",
    "搜索词原则：",
    "- 不要太宽（『科技』），不要太窄（用户专有名词）",
    "- 偏新闻 / 事件性，不要查百科类",
    "- 如果用户兴趣里有具体领域（钢琴/加密货币/某剧），就围绕它出关键词",
    "- 完全没有线索时，搜偏生活化的轻量热点（『近期值得看的电影』『本周值得关注的科技进展』等）",
    "",
    "输出严格 JSON，不要 markdown：",
    '{"queries": ["搜索词1", "搜索词2"], "rationale": "为什么选这俩"}',
  ].join("\n");
}

async function _decideQueries({ assistantId, characterName, interests }) {
  const prompt = _buildQueryPrompt({ characterName, interests });
  const { content } = await getProvider().complete({
    messages: [
      { role: "system", content: "你是 LLM agent 的搜索词决策器。只输出 JSON。" },
      { role: "user", content: prompt },
    ],
    temperature: 0.4,
    maxTokens: 300,
    responseFormat: "json",
    callOpts: { kind: "web_topic_queries", scopeKey: assistantId, summary: "topic queries" },
  });
  const raw = parseStrictJsonObject(content);
  const queries = Array.isArray(raw?.queries) ? raw.queries.filter(Boolean).slice(0, 2) : [];
  return { queries, rationale: raw?.rationale || "" };
}

// ── LLM 2：用角色口吻 + snippets 写消息 ───────────────────────────────

function _buildMessagePrompt({ characterBackground, characterName, snippets, interests, recentTurns }) {
  const snippetLines = snippets
    .slice(0, 5)
    .map((s, i) => `[${i + 1}] ${s.title}\n    ${clipText(s.content, 200)}\n    (${s.url})`)
    .join("\n");

  const recentLines = recentTurns
    .slice(0, 4)
    .map((t) => `- ${t.role}: ${clipText(t.content, 100)}`)
    .join("\n");

  return [
    `你是角色「${characterName || "角色"}」，准备给用户主动发一条消息。这次没什么"自然话题"，你刚从网上看到了一些近期内容，想挑一个跟用户聊。`,
    "",
    "角色档案（简）：",
    clipText(characterBackground, 400),
    "",
    "用户兴趣（聊天时优先关联这些）：",
    `- 长期话题：${interests.topics.join("、") || "无"}`,
    `- 已知偏好：${interests.facts.join(" / ") || "无"}`,
    "",
    "最近几条对话（避免重复话题 / 角度）：",
    recentLines || "- 无",
    "",
    "你刚搜到的 snippets：",
    snippetLines || "- 无",
    "",
    "**写作要求**：",
    "- 用角色第一人称，自然口语，像是闲聊里 她 看到一条新闻想分享给对方",
    "- **挑一条最贴用户兴趣**的 snippet 来切入，没贴的就挑最有意思的",
    "- 不要复述新闻全文，说『看到 / 听说 / 注意到 X，X 怎么样吧 / 你怎么看 / 想起你之前说过 Y』这种钩子",
    "- 不要给 url 不要标 [1]，自然提就行",
    "- 如果所有 snippets 都不靠谱（话题敏感 / 跟用户兴趣完全无关 / 全是广告），可以 skip",
    "- body ≤ 120 字，中文",
    "",
    "输出严格 JSON：",
    '{"skip": false, "skipReason": "", "intent": "share_thought|ask_followup|check_in", "title": "<≤20字>", "body": "<正文>", "anchorTopic": "<提到的具体事>", "sourceSnippetIndex": 1, "rationale": "<选这条理由>"}',
  ].join("\n");
}

async function _writeMessageFromSnippets({
  assistantId,
  characterBackground,
  characterName,
  snippets,
  interests,
  recentTurns,
}) {
  if (!snippets || snippets.length === 0) return null;
  const prompt = _buildMessagePrompt({ characterBackground, characterName, snippets, interests, recentTurns });
  const { content } = await getProvider().complete({
    messages: [
      { role: "system", content: "你是角色主动消息生成器，基于 web 搜到的 snippets 写一条切兴趣的开口。只输出 JSON。" },
      { role: "user", content: prompt },
    ],
    temperature: 0.65,
    maxTokens: 500,
    responseFormat: "json",
    callOpts: { kind: "web_topic_message", scopeKey: assistantId, summary: "topic message" },
  });
  return parseStrictJsonObject(content);
}

// ── 主入口 ───────────────────────────────────────────────────────────

/**
 * 尝试基于 web search 给一个 fallback proactive 消息草稿。
 *
 * @param {object} args
 * @param {string} args.assistantId
 * @param {object} args.profile
 * @returns {Promise<{ok: true, intent, title, body, anchorTopic, rationale, sourceUrl, query}
 *           | {ok: false, reason, ...}>}
 */
async function tryWebTopicFallback({ assistantId, profile, now = Date.now() } = {}) {
  if (!assistantId || !profile) return { ok: false, reason: "missing_args" };

  const interests = _collectUserInterests(assistantId, profile.character_name);

  // 1) LLM 决定搜索词
  let queriesPlan;
  try {
    queriesPlan = await _decideQueries({
      assistantId,
      characterName: profile.character_name,
      interests,
    });
  } catch (e) {
    return { ok: false, reason: "query_planner_failed", error: e.message };
  }
  if (!queriesPlan.queries.length) {
    return { ok: false, reason: "no_queries_chosen" };
  }

  // 2) 跑 Tavily news search，合并所有 snippets 去重（按 url）
  const allSnippets = [];
  const seenUrls = new Set();
  let lastSearchErr = null;
  let triedQueries = 0;
  for (const q of queriesPlan.queries) {
    triedQueries += 1;
    const r = await runWebSearch({ assistantId, query: q, topic: "news", maxResults: 4, now });
    if (!r.ok) {
      lastSearchErr = r;
      // daily_cap_exceeded / api_key_missing 等是终止性失败，没必要再试第二个 query
      if (r.reason === "daily_cap_exceeded" || r.reason === "api_key_missing" || r.reason === "provider_not_loaded") {
        break;
      }
      continue;
    }
    for (const s of (r.results || [])) {
      if (!s.url || seenUrls.has(s.url)) continue;
      seenUrls.add(s.url);
      allSnippets.push({ ...s, sourceQuery: q });
    }
  }
  if (allSnippets.length === 0) {
    return {
      ok: false,
      reason: lastSearchErr?.reason || "no_snippets",
      detail: lastSearchErr,
      triedQueries,
    };
  }

  // 3) LLM 用 snippets 写一条
  const recentTurns = getRecentTurnsAcrossSessions({ assistantId, limit: 6 });
  let writeResult;
  try {
    writeResult = await _writeMessageFromSnippets({
      assistantId,
      characterBackground: profile.character_background || "",
      characterName: profile.character_name,
      snippets: allSnippets.slice(0, 5),
      interests,
      recentTurns,
    });
  } catch (e) {
    return { ok: false, reason: "writer_failed", error: e.message };
  }
  if (!writeResult) return { ok: false, reason: "writer_empty" };
  if (writeResult.skip === true || String(writeResult.skip).toLowerCase() === "true") {
    return { ok: false, reason: "writer_chose_skip", skipReason: writeResult.skipReason || "" };
  }
  const body = clipText(writeResult.body || "", 1000);
  if (!body || body.length < 8) {
    return { ok: false, reason: "writer_empty_body" };
  }

  // 取选中的 snippet url 做引用（即使 LLM 没填也好定位）
  const idx = Number(writeResult.sourceSnippetIndex) || 1;
  const chosen = allSnippets[Math.max(0, Math.min(allSnippets.length - 1, idx - 1))] || allSnippets[0];

  // URL dedup：同一篇文章 7 天内已发过 / 已计划 → skip，避免同文章反复推送
  if (chosen?.url) {
    try {
      const recentWithUrl = db
        .prepare(
          `SELECT id FROM proactive_plans
           WHERE assistant_id = ? AND rationale LIKE ? AND created_at >= ?
           LIMIT 1`
        )
        .get(assistantId, `%${chosen.url}%`, now - 7 * 24 * 60 * 60 * 1000);
      if (recentWithUrl) {
        return { ok: false, reason: "url_used_recently", url: chosen.url };
      }
    } catch (e) {
      // dedup 查询失败不阻塞主流程
    }
  }

  const intentRaw = String(writeResult.intent || "")
    .trim().toLowerCase().replace(/[\s-]+/g, "_");
  const intent = VALID_INTENTS.has(intentRaw) ? intentRaw : "share_thought";

  insertBehaviorJournalEntry({
    runType: "web_topic_fallback",
    assistantId,
    sessionId: profile.last_session_id || null,
    shouldPushMessage: true,
    status: "ok",
    reason: "web_topic_drafted",
    messageIntent: intent,
    draftMessage: body,
    input: { triedQueries: queriesPlan.queries, snippetsFound: allSnippets.length },
    result: {
      sourceUrl: chosen?.url,
      sourceTitle: clipText(chosen?.title || "", 100),
      rationale: clipText(writeResult.rationale || "", 200),
    },
    createdAt: now,
  });

  return {
    ok: true,
    intent,
    title: clipText(writeResult.title || "", 40) || "想说点什么",
    body,
    anchorTopic: clipText(writeResult.anchorTopic || chosen?.title || "", 60),
    rationale: clipText(writeResult.rationale || "", 200),
    sourceUrl: chosen?.url,
    sourceTitle: chosen?.title,
    query: chosen?.sourceQuery,
  };
}

module.exports = {
  tryWebTopicFallback,
};
