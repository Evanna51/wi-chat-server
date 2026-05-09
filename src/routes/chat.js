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
const { composeForChat } = require("../services/character/promptComposer");
const {
  shouldRetrieveMemory,
  formatMemoryLines,
  buildMemoryGuidance,
} = require("../services/memoryDecisionService");
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

function safeGetCoreFacts(assistantId) {
  try {
    return getCoreFacts(assistantId, { limit: 15 });
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

    // 用 composer 渲染静态 slots（不含 facts / narrative — 那些每轮变，走 chat/context）
    const composed = composeForChat({ profile, identity });
    const { role, character, background, constraints, tool_protocol } = composed.slots;

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
      renderedSlots: { role, character, background, constraints, tool_protocol },
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
    haveSlotsETag: z.string().trim().optional(),
    topK: z.number().int().positive().max(20).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const { assistantId, sessionId, userInput, haveSlotsETag, topK } = parsed.data;

  try {
    const profile = getAssistantProfile(assistantId);
    if (!profile) {
      return res.status(404).json({ ok: false, error: "assistant_profile_not_found" });
    }

    // 1. 角色认知（state / dynamics / episodes / topics / reflection / prefill）
    const ctx = buildCharacterContext(assistantId, { lastUserMessage: userInput });
    if (!ctx) {
      return res.status(404).json({ ok: false, error: "character_context_unavailable" });
    }

    // 2. 用户事实（pinned + retrieved）
    const coreFacts = safeGetCoreFacts(assistantId);
    const coreMemories = safeGetCoreMemories(assistantId);

    let retrievedMemories = [];
    let memoryDecision = null;
    if (config.memoryRetrievalEnabled && sessionId) {
      const decision = await shouldRetrieveMemory({ userInput, assistantId });
      memoryDecision = {
        shouldRetrieve: !!decision.shouldRetrieve,
        intent: decision.intent || (decision.shouldRetrieve ? "fact_query" : "small_talk"),
        source: decision.source,
        reason: decision.reason,
      };
      if (decision.shouldRetrieve) {
        try {
          const items = await retrieveMemory({
            assistantId,
            sessionId,
            query: decision.query || userInput,
            topK: topK || config.retrievalTopK,
          });
          retrievedMemories = items.map((m) => ({
            id: m.id,
            content: m.content,
            score: m.score,
            createdAt: m.createdAt,
          }));
        } catch (err) {
          // retrieve 失败不阻塞 chat path —— 客户端拿不到 retrieved 也能用 prefill
          memoryDecision.retrievalError = err.message;
        }
      }
    } else if (!sessionId) {
      memoryDecision = { shouldRetrieve: false, intent: "small_talk", reason: "no_session" };
    }

    // 3. 用 composer 渲染本轮动态 slots（facts / narrative / prefill）
    const identity = getCharacterIdentity(assistantId);
    const composed = composeForChat({
      profile,
      identity,
      coreFacts: coreFacts.length ? coreFacts : coreMemories,
      retrievedMemories,
      recentReflection: ctx.latestReflection,
      activeEpisodes: ctx.recentEpisodes,
      activeTopics: ctx.activeTopics,
      salientPhrase: ctx.salientPhrase,
      prefill: ctx.userPrefix,
    });

    // 4. etag 比对：客户端 etag 没变就不回传静态 slots
    const etag = computeSlotsEtag({ profile, identity });
    const slotsChanged = !haveSlotsETag || haveSlotsETag !== etag;

    const response = {
      ok: true,
      assistantId,
      sessionId: sessionId || null,
      facts: composed.slots.facts,
      narrative: composed.slots.narrative,
      assistantPrefill: composed.assistantPrefill,
      salientPhrase: ctx.salientPhrase || null,
      memoryDecision,
      etag,
      stateVersion: ctx.ts,  // 客户端可记下来
      ts: Date.now(),
    };
    if (slotsChanged) {
      response.renderedSlots = {
        role: composed.slots.role,
        character: composed.slots.character,
        background: composed.slots.background,
        constraints: composed.slots.constraints,
        tool_protocol: composed.slots.tool_protocol,
      };
    } else {
      response.renderedSlots = null; // signal client: use cached slots
    }

    // 调试用辅助字段（旧 memory-context 客户端可能依赖）
    if (memoryDecision?.shouldRetrieve && retrievedMemories.length) {
      response.memoryLines = formatMemoryLines(retrievedMemories);
      response.memoryGuidance = buildMemoryGuidance(response.memoryLines);
    }

    return res.json(response);
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
