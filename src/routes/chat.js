/**
 * Chat / Character v2 路由 — Phase 2 落地的客户端 lifecycle 端点。
 *
 * 命名遵循"客户端在做什么"，不再按服务边界切。详见 docs/api-redesign-plan.md §3。
 *
 * 端点：
 *   GET    /api/character/:id              — App 启动 / 切换角色（取代 bootstrap）
 *   POST   /api/chat/context               — 每次发消息前 hot path（取代 character/context + memory-context）
 *   POST   /api/chat/turn                  — 上传一轮（语义化别名，等价 /api/sync/push）
 *   DELETE /api/chat/turn/:turnId          — 删除一轮（含 cascade）
 *
 * 注意挂载顺序：必须在 apiRouter 之后注册，因为 `GET /character/:id` 是
 * catch-all 形态，会捕获 `/character/identity` 等具体路径。让 apiRouter
 * 的具体路由先匹配，本 router 兜底动态 :id。
 */

const express = require("express");
const { z } = require("zod");
const config = require("../config");
const {
  getAssistantProfile,
  getRecentMemoryItems,
} = require("../db");
const {
  getCharacterIdentity,
} = require("../services/character/identityService");
const { buildCharacterContext } = require("../services/character/characterContextBuilder");
const {
  composeForChatV3,
  composeForChatV3Default,
} = require("../services/character/promptComposer");
const { decideRegister } = require("../services/character/registerRouter");
const { applyStateDelta } = require("../services/characterStateService");
const { getTemporalSnapshot } = require("../utils/temporalContext");
const { buildAttention1h } = require("../services/character/attentionWindow");
const { getSkillById } = require("../services/character/dialogueSkillsCatalog");
const { evaluate: evaluateBehaviorIntent } = require("../services/character/behaviorPlanner");
const { retrieveMemory } = require("../services/memoryRetrievalService");
const { getCoreMemories, getCoreFacts } = require("../db");
const { ingestTurnsBatch } = require("../services/syncIngestService");
const { turnEvents } = require("../events/turnEvents");
const { deleteConversationTurnCascade } = require("../services/memoryEditService");

const router = express.Router();

const authMiddleware = (req, res, next) => {
  if (!config.requireApiKey) return next();
  const required = config.appApiKey;
  const provided = req.header("x-api-key");
  if (!provided || provided !== required) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
};

// ── helpers (与 api.js 内部 safe* helper 等价；本地复用避免循环 require) ─────

function safeGetCoreFacts(assistantId, characterName) {
  try {
    return getCoreFacts(assistantId, { limit: 15, characterName });
  } catch (_e) {
    return [];
  }
}

function safeGetCoreMemories(assistantId) {
  try {
    return getCoreMemories(assistantId, { limit: 8 });
  } catch (_e) {
    return [];
  }
}

/**
 * Etag 格式：`v2.0:identity_v{N}:profile_updated_{ts}`
 * 客户端缓存到 etag 不变就不重拉静态 slots。
 */
function computeSlotsEtag({ profile, identity }) {
  const ident = identity?.identityVersion || 0;
  const updated = profile?.updated_at || profile?.created_at || 0;
  return `v2.0:identity_v${ident}:profile_${updated}`;
}

// ── GET /api/character/:id — boot 时拉静态 slots ──────────────────────

router.get("/character/:id", authMiddleware, (req, res) => {
  const assistantId = String(req.params.id || "").trim();
  if (!assistantId) {
    return res.status(400).json({ ok: false, error: "assistantId required" });
  }
  try {
    const profile = getAssistantProfile(assistantId);
    if (!profile) {
      return res.status(404).json({ ok: false, error: "assistant_profile_not_found" });
    }
    const identity = getCharacterIdentity(assistantId);

    // 2026-05-10: boot 路径用 V3 default 渲染，输出 schema 跟 chat/context 一致。
    const composed = composeForChatV3Default({ profile, identity });
    const slots = {
      role: composed.slots.role || "",
      style: composed.slots.style || "",
      voice_skills: composed.slots.voice_skills || "",
      background: composed.slots.background || "",
      constraints: composed.slots.constraints || "",
      inner_thought: composed.slots.inner_thought || "",
      temporal_context: composed.slots.temporal_context || "",
      attention_1h: composed.slots.attention_1h || "",
      narrative: composed.slots.narrative || "",
      facts: composed.slots.facts || "",
      tool_protocol: composed.slots.tool_protocol || "",
      avoid: composed.slots.avoid || "",
    };

    return res.json({
      ok: true,
      assistantId,
      profile: {
        characterName: profile.character_name,
        characterBackground: profile.character_background,
        assistantType: profile.assistant_type || "",
        allowAutoLife: !!profile.allow_auto_life,
        allowProactiveMessage: !!profile.allow_proactive_message,
      },
      identity: identity || null,
      // ⭐ 主输出 — 跟 chat/context 同 schema，客户端 boot fallback 直接用 mergedSystem
      mergedSystem: composed.mergedSystem,
      enabledSlots: composed.enabledSlots,
      slots,
      etag: computeSlotsEtag({ profile, identity }),
      ts: Date.now(),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

// ── POST /api/chat/context — 每轮发消息前 hot path ────────────────────

router.post("/chat/context", authMiddleware, async (req, res) => {
  const schema = z.object({
    assistantId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1).optional(),
    userInput: z.string().min(1),
    history: z
      .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
      .max(10)
      .optional(),
    topK: z.number().int().positive().max(20).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const { assistantId, sessionId, userInput, history = [], topK } = parsed.data;

  try {
    const profile = getAssistantProfile(assistantId);
    if (!profile) {
      return res.status(404).json({ ok: false, error: "assistant_profile_not_found" });
    }
    const identity = getCharacterIdentity(assistantId);

    // ── 并行拉两个昂贵数据源：1h attention + character context ──
    const [attention1h, ctx] = await Promise.all([
      buildAttention1h(assistantId).catch((e) => {
        console.warn("[chat/context] attention1h failed:", e.message);
        return { topics: [], innerFocus: null, emotionalTone: null, turnCount: 0, ts: Date.now() };
      }),
      Promise.resolve(buildCharacterContext(assistantId, { lastUserMessage: userInput })),
    ]);

    if (!ctx) {
      return res.status(404).json({ ok: false, error: "character_context_unavailable" });
    }

    // ── 用户事实（pinned）──
    const coreFacts = safeGetCoreFacts(assistantId, profile.character_name);
    const coreMemories = safeGetCoreMemories(assistantId);
    const facts = coreFacts.length ? coreFacts : coreMemories;

    // ── available 矩阵（router 决策前给它看哪些层"潜在有数据"）──
    // facts_retrieved 此刻还不知道，标 true（可能有）—— router 自己决定要不要触发
    const available = {
      attention_1h: !!(attention1h.topics?.length || attention1h.innerFocus),
      narrative_reflection: !!ctx.latestReflection?.summary,
      narrative_episodes: !!(ctx.recentEpisodes?.length),
      narrative_topics: !!(ctx.activeTopics?.length),
      narrative_salient: !!ctx.salientPhrase,
      lore_background: !!(profile.lore || profile.character_background),
      facts_core: !!facts.length,
      facts_retrieved: !!(config.memoryRetrievalEnabled && sessionId), // 能不能跑 RAG
    };

    // ── 时间锚：现在几点 + 距用户上次说话多久 + 是不是新会话 ──
    const temporal = getTemporalSnapshot(assistantId);

    // ── 启发式 behavior intent（cheap，~10ms）——给 router 看角色当前内心倾向 ──
    let characterIntent = null;
    try {
      characterIntent = evaluateBehaviorIntent(assistantId, {
        now: Date.now(),
        attention1h, // 复用 chat path 已经 await 的 attention，零额外成本
      });
    } catch (err) {
      console.warn("[chat/context] evaluateBehaviorIntent failed:", err.message);
    }

    // ── Router LLM 决策：register + skills + layers + budget + tools ──
    const decision = await decideRegister({
      userInput,
      history,
      available,
      identity,
      characterIntent,
      temporal,                                // cognition router 也吃时间锚
    });

    // ── 跑 router 决定的 server_tools（当前只有 search_memory → retrieveMemory）──
    let retrievedMemories = [];
    const memoryDecision = {
      shouldRetrieve: false,
      ranTools: [],
      reason: decision.reason,
    };

    for (const t of decision.server_tools || []) {
      if (t.tool === "search_memory") {
        if (!config.memoryRetrievalEnabled || !sessionId) {
          memoryDecision.skipped = "memory_retrieval_disabled_or_no_session";
          continue;
        }
        try {
          const items = await retrieveMemory({
            assistantId,
            sessionId,
            query: t.args.query || userInput,
            topK: topK || config.retrievalTopK,
          });
          retrievedMemories = retrievedMemories.concat(
            items.map((m) => ({
              id: m.id,
              content: m.content,
              score: m.score,
              createdAt: m.createdAt,
            }))
          );
          memoryDecision.shouldRetrieve = true;
          memoryDecision.intent = t.args.intent || "fact_query";
          memoryDecision.source = t.args.source;
          memoryDecision.ranTools.push({ tool: t.tool, args: t.args, hits: items.length });
        } catch (err) {
          memoryDecision.retrievalError = err.message;
        }
      }
    }

    // 如果 router 决定 facts_retrieved=1 但实际没召回任何 memory，自动关闭这层
    if (decision.layers.facts_retrieved === 1 && !retrievedMemories.length) {
      decision.layers.facts_retrieved = 0;
    }

    // ── Resolve skills (router output → catalog) ──
    const skills = decision.skill_ids
      .map((id) => getSkillById(id, identity))
      .filter(Boolean);

    // ── state_delta：cognition router 的"这一轮我心情怎么动"立刻落 character_state ──
    // 故意放在 compose 之前的话，prompt 里 buildStatePromptFragment 看到的是新状态，
    // 但角色独白 (inner) 是基于旧状态算出来的，会冲突。所以放在 compose **之后**：
    // 本轮 prompt 用旧 state + 新 inner（一致：旧状态的角色，刚被这一句触动而 shift）；
    // 下一轮 prompt 看到的就是 shift 后的新 state。
    let stateDeltaResult = null;
    // 实际 apply 在 compose 之后做，这里先占位以便 payload 引用
    const _pendingStateDelta = decision.state_delta;

    // ── V3 compose ──
    const composed = composeForChatV3({
      profile,
      identity,
      decision,
      skills,
      attention1h,
      coreFacts: facts,
      retrievedMemories,
      recentReflection: ctx.latestReflection,
      activeEpisodes: ctx.recentEpisodes,
      activeTopics: ctx.activeTopics,
      salientPhrase: ctx.salientPhrase,
      temporal,                                  // <temporal_context> slot 数据
      prefill: "", // V3 不放 prefill —— 角色独白由 LLM 自然生成
    });

    // ── 按 slot 名字给字典 — 仅当客户端要嵌自己的 <client> slot 时用 ──
    // 每个值已经 XML-wrap 好（"<role>...</role>"），未启用的 slot 是空字符串 ""。
    // canonical 顺序见 docs/client-prompt-merge-protocol.md。
    const slots = {
      role: composed.slots.role || "",
      style: composed.slots.style || "",
      voice_skills: composed.slots.voice_skills || "",
      background: composed.slots.background || "",
      constraints: composed.slots.constraints || "",
      inner_thought: composed.slots.inner_thought || "",
      temporal_context: composed.slots.temporal_context || "",
      attention_1h: composed.slots.attention_1h || "",
      narrative: composed.slots.narrative || "",
      facts: composed.slots.facts || "",
      tool_protocol: composed.slots.tool_protocol || "",
      avoid: composed.slots.avoid || "",
    };

    // ── 应用 state_delta（compose 已用旧 state，现在把"这一轮的 shift"沉淀到 DB）──
    try {
      stateDeltaResult = applyStateDelta(assistantId, _pendingStateDelta);
    } catch (err) {
      console.warn("[chat/context] applyStateDelta failed:", err.message);
      stateDeltaResult = { applied: false, reason: "exception" };
    }

    return res.json({
      ok: true,
      assistantId,
      sessionId: sessionId || null,

      // ⭐ 主输出 — 直接当 system prompt 喂 LLM。99% 的客户端只用这个字段就够。
      mergedSystem: composed.mergedSystem,
      assistantPrefill: composed.assistantPrefill,
      salientPhrase: ctx.salientPhrase || null,

      // router 决策结果：本轮要拼哪些 slot（按 canonical 顺序）。
      // 例 ["role", "style", "voice_skills", "constraints", "attention_1h", "avoid"]
      // 客户端按这个数组 map slots 即可，无需自己硬编码 canonical 顺序。
      enabledSlots: composed.enabledSlots,

      // slot 字典：按 slot 名字给已渲染好的字符串（"<role>...</role>"），
      // 没启用的 slot 是 ""。仅当客户端要嵌 <client> slot 时配合 enabledSlots 用。
      // 推荐 <client> slot 插在 constraints 后、attention_1h 前。
      slots,

      // chat LLM tool capability — 调 LLM 时按这个 list 附 tools schema。
      availableTools: decision.client_tools || [],

      // ── 决策可见性（debug + 监控）──
      routerDecision: {
        register: decision.register,                  // 兼容老字段（= register_tags[0]）
        register_tags: decision.register_tags || [],
        response_stance: decision.response_stance || null,
        // inner 内心独白：客户端 UI 想暴露 "她当下在想什么" 时可读取（默认不展示给用户）
        inner: decision.inner || null,
        // state_delta：本轮 cognition 决定的 mood/relationship shift（已落 DB）
        state_delta: decision.state_delta || null,
        state_delta_applied: stateDeltaResult || null,
        skill_ids: decision.skill_ids,
        budget: decision.budget,
        layers: decision.layers,
        server_tools: decision.server_tools || [],
        client_tools: decision.client_tools || [],
        reason: decision.reason,
        // 启发式 intent（router 决策的输入之一）
        characterIntent: characterIntent
          ? {
              intent: characterIntent.intent,
              urgency: characterIntent.urgency,
              priority: characterIntent.priority,
              contentHint: characterIntent.contentHint,
              suggestedSocialMode: characterIntent.suggestedSocialMode,
            }
          : null,
      },
      attention1h: {
        topics: attention1h.topics || [],
        innerFocus: attention1h.innerFocus || null,
        emotionalTone: attention1h.emotionalTone || null,
        turnCount: attention1h.turnCount || 0,
      },

      // ── memory 决策结果 ──
      memoryDecision,

      // ── 元信息 ──
      stateVersion: ctx.ts,
      ts: Date.now(),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

// ── POST /api/chat/turn — 上传一轮（语义化别名 /api/sync/push） ───────

const turnSchema = z.object({
  deviceId: z.string().min(1).optional(),  // 兼容；不传时用 sessionId fallback
  assistantId: z.string().min(1).optional(), // 顶层；turns[].assistantId 也行
  sessionId: z.string().min(1).optional(),
  turns: z
    .array(
      z.object({
        id: z.string().min(1),
        assistantId: z.string().min(1).optional(),
        sessionId: z.string().min(1).optional(),
        role: z.enum(["user", "assistant", "tool_call", "tool_result", "system"]),
        content: z.string(),
        createdAt: z.number().int().min(0).optional(),
        ts: z.number().int().min(0).optional(),
        toolCallsJson: z.string().optional(),
        toolCallId: z.string().optional(),
        toolName: z.string().optional(),
      })
    )
    .min(1)
    .max(200),
});

router.post("/chat/turn", authMiddleware, (req, res) => {
  const parsed = turnSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const { deviceId: bodyDeviceId, assistantId: topAssistantId, sessionId: topSessionId, turns: rawTurns } = parsed.data;

  // 规范化 turns —— 顶层 assistantId / sessionId fallback；ts → createdAt 别名
  const turns = rawTurns.map((t) => ({
    ...t,
    assistantId: t.assistantId || topAssistantId,
    sessionId: t.sessionId || topSessionId,
    createdAt: t.createdAt ?? t.ts ?? Date.now(),
  }));
  for (const t of turns) {
    if (!t.assistantId || !t.sessionId) {
      return res.status(400).json({
        ok: false,
        error: "every turn requires assistantId + sessionId (top-level or per-turn)",
      });
    }
  }

  const deviceId = bodyDeviceId || `chat:${turns[0].sessionId}`;
  try {
    const result = ingestTurnsBatch({ deviceId, turns });
    // emit subscribers (cancelPendingPlans / characterStateUpdater / scheduleNextPush)
    for (const [assistantId, stats] of result.perAssistantStats) {
      if (!assistantId || stats.userTurnCount <= 0) continue;
      turnEvents.emitUserBatch({
        assistantId,
        userId: null,
        cause: "chat.turn",
        stats: {
          userTurnCount: stats.userTurnCount,
          lastUserAt: stats.lastUserAt,
          lastUserContent: stats.lastUserContent,
        },
      });
    }
    return res.json({
      ok: true,
      ingested: result.accepted,
      deduped: result.skipped,
      rejected: result.rejected,
      details: result.details,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

// ── DELETE /api/chat/turn/:turnId — 删除一轮（含 cascade） ────────────

router.delete("/chat/turn/:turnId", authMiddleware, (req, res) => {
  const turnId = String(req.params.turnId || "").trim();
  if (!turnId) {
    return res.status(400).json({ ok: false, error: "turnId required" });
  }
  try {
    const result = deleteConversationTurnCascade(turnId);
    if (!result || !result.found) {
      return res.status(404).json({ ok: false, error: "turn_not_found" });
    }
    return res.json({
      ok: true,
      turnId,
      cascade: {
        turn: result.deleted.turn,
        memoryItems: result.deleted.memoryItems,
        facts: result.deleted.facts,
        edges: result.deleted.edges,
        vectors: result.deleted.vectors,
        outboxEvents: result.deleted.outboxEvents,
      },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

module.exports = router;
