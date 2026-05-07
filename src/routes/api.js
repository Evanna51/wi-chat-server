const express = require("express");
const { z } = require("zod");
const {
  db,
  upsertAssistantProfile,
  countAllowAutoLifeAssistants,
  searchConversation,
  searchMemory,
} = require("../db");
const { retrieveMemory } = require("../services/memoryRetrievalService");
const { generateWithMemory } = require("../services/langchainQwenService");
const {
  shouldRetrieveMemory,
  formatMemoryLines,
  buildMemoryGuidance,
} = require("../services/memoryDecisionService");
const { runCatchup } = require("../services/catchupService");
const { ensureDefaultState } = require("../services/characterStateService");
const { buildRelationshipStatePayload } = require("../services/relationshipStateView");
const {
  deleteMemoryItemCascade,
  deleteMemoryItemsBatch,
  updateMemoryItemContent,
  setMemoryQuality,
  addFact,
  removeFact,
} = require("../services/memoryEditService");
const {
  generatePlans,
  listPendingPlans,
  listPlansByStatus,
  cancelPlanById,
  findPlanById,
} = require("../services/proactivePlanService");
const config = require("../config");

const router = express.Router();
let didWarnAutoLifeCount = false;

const authMiddleware = (req, res, next) => {
  if (!config.requireApiKey) return next();
  const required = config.appApiKey;
  const provided = req.header("x-api-key");
  if (!provided || provided !== required) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
};

router.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

router.post("/register-push-token", authMiddleware, (req, res) => {
  const schema = z.object({
    userId: z.string().min(1),
    token: z.string().min(10),
    platform: z.string().default("android"),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { userId, token, platform } = parsed.data;
  db.prepare(
    "INSERT OR IGNORE INTO push_token (user_id, token, platform, created_at) VALUES (?, ?, ?, ?)"
  ).run(userId, token, platform, Date.now());
  res.json({ ok: true });
});

router.post("/assistant-profile/upsert", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    characterName: z.string().min(1),
    characterBackground: z.string().default(""),
    allowAutoLife: z.boolean(),
    allowProactiveMessage: z.boolean(),
    type: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const {
    assistantId,
    characterName,
    characterBackground,
    allowAutoLife,
    allowProactiveMessage,
    type,
  } = parsed.data;

  const row = upsertAssistantProfile({
    assistantId,
    characterName,
    characterBackground,
    allowAutoLife,
    allowProactiveMessage,
    assistantType: type,
  });

  const autoLifeCount = countAllowAutoLifeAssistants();
  if (autoLifeCount > 10 && !didWarnAutoLifeCount) {
    didWarnAutoLifeCount = true;
    console.warn(
      `[assistant-profile] allowAutoLife assistants exceed 10: current=${autoLifeCount}`
    );
  }

  res.json({
    ok: true,
    profile: {
      assistantId: row.assistant_id,
      characterName: row.character_name,
      characterBackground: row.character_background,
      allowAutoLife: row.allow_auto_life === 1,
      allowProactiveMessage: row.allow_proactive_message === 1,
      assistantType: row.assistant_type || "",
      lastSessionId: row.last_session_id || null,
      lastProactiveCheckAt: row.last_proactive_check_at || null,
      updatedAt: row.updated_at,
    },
    autoLifeCount,
  });
});

// 注：原 HTTP 轮询通道（/register-local-inbox, /pull-messages, /ack-message）
// 与 /report-interaction 均已于 2026-05-06 移除。
// 实时推送统一走 WebSocket /api/ws；对话写入统一走 /api/sync/push 与 /api/sync/snapshot。

router.post("/chat-with-memory", authMiddleware, async (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    sessionId: z.string().min(1),
    userInput: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, sessionId, userInput } = parsed.data;

  if (!config.memoryRetrievalEnabled) {
    return res.json({ ok: true, answer: "记忆检索已关闭。", memories: [] });
  }

  try {
    const memories = await retrieveMemory({
      assistantId,
      sessionId,
      query: userInput,
      topK: config.retrievalTopK,
    });
    const answer = await generateWithMemory({
      assistantName: assistantId,
      userPrompt: userInput,
      memories,
      fallbackText: "我记下了，我们继续聊聊。",
    });
    return res.json({
      ok: true,
      answer,
      memories: memories.map((item) => ({ id: item.id, score: item.score })),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post("/tool/memory-context", authMiddleware, async (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    sessionId: z.string().min(1),
    userInput: z.string().min(1),
    topK: z.number().int().positive().max(20).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });

  const { assistantId, sessionId, userInput, topK } = parsed.data;
  const decision = await shouldRetrieveMemory({ userInput });
  // 在所有 return 路径都附带 relationshipState，让客户端不论是否检索记忆，
  // 都能拿到最新的角色情绪/关系/精力快照（state 不存在时为 null）。
  const relationshipState = safeBuildRelationshipState(assistantId);

  if (!config.memoryRetrievalEnabled) {
    return res.json({
      ok: true,
      shouldRetrieve: false,
      intent: "small_talk",
      reason: "memory_retrieval_disabled",
      decisionSource: "system",
      memoryLines: [],
      relationshipState,
    });
  }

  if (!decision.shouldRetrieve) {
    return res.json({
      ok: true,
      shouldRetrieve: false,
      intent: decision.intent || "small_talk",
      reason: decision.reason,
      decisionSource: decision.source,
      memoryLines: [],
      relationshipState,
    });
  }

  try {
    const memories = await retrieveMemory({
      assistantId,
      sessionId,
      query: decision.query || userInput,
      topK: topK || config.retrievalTopK,
    });
    const memoryLines = formatMemoryLines(memories);
    const memoryGuidance = buildMemoryGuidance(memoryLines);
    return res.json({
      ok: true,
      shouldRetrieve: true,
      intent: decision.intent || "fact_query",
      reason: decision.reason,
      decisionSource: decision.source,
      retrievalQuery: decision.query || userInput,
      memoryLines,
      memoryGuidance,
      memories: memories.map((item) => ({
        id: item.id,
        content: item.content,
        score: item.score,
      })),
      relationshipState,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// 防御性 wrapper：state builder 抛错不应该让 memory-context 整个 500
function safeBuildRelationshipState(assistantId) {
  try {
    return buildRelationshipStatePayload(assistantId);
  } catch (e) {
    return null;
  }
}

/**
 * GET /api/relationship/state?assistantId=xxx
 *
 * 客户端主动拉取角色当前情绪/关系/精力快照。
 * 如果 character_state 行不存在（角色尚未交互过），自动用 ensureDefaultState 初始化默认值，
 * 保证客户端永远拿到结构完整的 payload，无需处理 404。
 */
router.get("/relationship/state", authMiddleware, (req, res) => {
  const schema = z.object({ assistantId: z.string().trim().min(1) });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const { assistantId } = parsed.data;
  try {
    ensureDefaultState(assistantId);
    const relationshipState = buildRelationshipStatePayload(assistantId);
    if (!relationshipState) {
      // ensureDefaultState 后理论上一定有 row；这里兜底
      return res.status(500).json({ ok: false, error: "state_init_failed" });
    }
    return res.json({ ok: true, assistantId, relationshipState, ts: Date.now() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

/**
 * Agentic RAG 搜索端点：给 app 端 LLM 的 search_memory tool 直接调用。
 *
 * - 默认 source='user'，只搜用户说过的话；角色信息（life_event 等）多在上下文里已有
 * - 显式提到"你"或角色名时，app 端 LLM 应改传 source='character'
 * - 无 decision 逻辑（与 /tool/memory-context 区分）：LLM 已决定要查，server 直接执行
 */
router.post("/tool/memory-recall", authMiddleware, async (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    query: z.string().min(1),
    source: z.enum(["user", "character", "all"]).default("user"),
    category: z.enum([
      "chitchat", "personal_experience", "relationship_info", "knowledge",
      "goals_plans", "preferences", "decisions_reflections", "wellbeing", "ideas",
    ]).optional(),
    minQuality: z.enum(["A", "B", "C", "D", "E"]).optional(),
    topK: z.coerce.number().int().positive().max(20).default(5),
    sessionId: z.string().optional(),
    // PR-11 新增过滤维度
    memoryType: z.enum([
      "user_turn", "assistant_turn", "life_event", "work_event",
      "tool_call", "tool_result", "system_event",
    ]).optional(),
    fromMs: z.coerce.number().int().min(0).optional(),
    toMs: z.coerce.number().int().min(0).optional(),
    withinDays: z.coerce.number().positive().max(3650).optional(),
    minScore: z.coerce.number().min(0).max(1).optional(),
    excludeIds: z.array(z.string()).max(100).optional(),
    includeFacts: z.coerce.boolean().optional(),
    // PR-12 新增
    dateString: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "format YYYY-MM-DD").optional(),
    excludeRecentEcho: z.coerce.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const {
    assistantId, query, source, category, minQuality, topK, sessionId,
    memoryType, fromMs, toMs, withinDays, minScore, excludeIds, includeFacts,
    dateString, excludeRecentEcho,
  } = parsed.data;

  try {
    const memories = await retrieveMemory({
      assistantId,
      sessionId: sessionId || "",
      query,
      topK,
      source,
      category: category || null,
      minQuality: minQuality || null,
      memoryType: memoryType || null,
      fromMs: fromMs ?? null,
      toMs: toMs ?? null,
      withinDays: withinDays ?? null,
      minScore: minScore ?? null,
      excludeIds: excludeIds || null,
      includeFacts: includeFacts === true,
      dateString: dateString || null,
      excludeRecentEcho: excludeRecentEcho !== false, // 默认 true
    });
    return res.json({
      ok: true,
      query,
      source,
      count: memories.length,
      memories: memories.map((m) => ({
        id: m.id,
        content: m.content,
        memoryType: m.memoryType,
        category: m.category,
        quality: m.quality,
        createdAt: m.createdAt,
        score: Number(m.score.toFixed(4)),
        ...(includeFacts ? { facts: m.facts || [] } : {}),
      })),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Memory 修正/删除工具端点（v2，支持 6 个 action）。
 *
 * 用例：客户端 LLM 用 memory-recall 拿一批 memory，对错误/低质数据精细化修正。
 *
 *   action: 'delete'         级联删单条（memory_item + 衍生 + 源 conversation_turn）
 *   action: 'delete_batch'   传 memoryIds[] 批量级联删
 *   action: 'update'         就地改 content + 触发重 embed；conversation_turn 不动
 *   action: 'set_quality'    重新打 A-E 质量等级（标低让它不再被检索但保留行）
 *   action: 'add_fact'       给某条 memory 加 fact（key/value/confidence）
 *   action: 'remove_fact'    删 fact（指定 factKey；省略则删该 memory 全部 facts）
 *
 * 所有动作都会写 memory_audit_log。assistantId 强校验防跨角色误删。
 */
router.post("/tool/memory-correct", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    action: z.enum(["delete", "delete_batch", "update", "set_quality", "add_fact", "remove_fact"]),
    // 单条动作用 memoryId
    memoryId: z.string().min(1).optional(),
    // 批量动作用 memoryIds
    memoryIds: z.array(z.string().min(1)).min(1).max(50).optional(),
    // update
    newContent: z.string().min(1).optional(),
    // set_quality
    quality: z.enum(["A", "B", "C", "D", "E"]).optional(),
    // add_fact / remove_fact
    factKey: z.string().min(1).max(60).optional(),
    factValue: z.string().min(1).max(200).optional(),
    factConfidence: z.coerce.number().min(0).max(1).optional(),
    // 共用
    reason: z.string().max(500).optional(),
    actor: z.string().max(40).optional(), // 默认 'ai'，可传 'user'/'system'
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const p = parsed.data;
  const sharedOpts = { assistantId: p.assistantId, reason: p.reason || null, actor: p.actor || "ai" };

  try {
    switch (p.action) {
      case "delete": {
        if (!p.memoryId) return res.status(400).json({ ok: false, error: "delete_requires_memoryId" });
        const result = deleteMemoryItemCascade(p.memoryId, p.assistantId, sharedOpts);
        if (!result.found) {
          return res.status(404).json({ ok: false, error: result.reason || "memory_not_found", memoryId: p.memoryId });
        }
        return res.json({ ok: true, action: "delete", memoryId: p.memoryId, deleted: result.deleted });
      }
      case "delete_batch": {
        if (!p.memoryIds || p.memoryIds.length === 0) {
          return res.status(400).json({ ok: false, error: "delete_batch_requires_memoryIds" });
        }
        const result = deleteMemoryItemsBatch(p.memoryIds, p.assistantId, sharedOpts);
        return res.json({
          ok: true,
          action: "delete_batch",
          totalDeleted: result.totalDeleted,
          totalRequested: p.memoryIds.length,
          details: result.details,
        });
      }
      case "update": {
        if (!p.memoryId) return res.status(400).json({ ok: false, error: "update_requires_memoryId" });
        if (!p.newContent) return res.status(400).json({ ok: false, error: "update_requires_newContent" });
        const result = updateMemoryItemContent(p.memoryId, p.newContent, sharedOpts);
        if (!result.found) {
          return res.status(404).json({ ok: false, error: result.reason || "memory_not_found", memoryId: p.memoryId });
        }
        return res.json({ ok: true, action: "update", memoryId: p.memoryId, updated: result.updated });
      }
      case "set_quality": {
        if (!p.memoryId) return res.status(400).json({ ok: false, error: "set_quality_requires_memoryId" });
        if (!p.quality) return res.status(400).json({ ok: false, error: "set_quality_requires_quality" });
        const result = setMemoryQuality(p.memoryId, p.quality, sharedOpts);
        if (!result.found) {
          return res.status(404).json({ ok: false, error: result.reason || "memory_not_found", memoryId: p.memoryId });
        }
        return res.json({
          ok: true,
          action: "set_quality",
          memoryId: p.memoryId,
          oldGrade: result.oldGrade,
          newGrade: result.newGrade,
        });
      }
      case "add_fact": {
        if (!p.memoryId) return res.status(400).json({ ok: false, error: "add_fact_requires_memoryId" });
        if (!p.factKey || !p.factValue) {
          return res.status(400).json({ ok: false, error: "add_fact_requires_factKey_and_factValue" });
        }
        const result = addFact({
          memoryId: p.memoryId,
          factKey: p.factKey,
          factValue: p.factValue,
          confidence: p.factConfidence ?? 0.8,
          opts: sharedOpts,
        });
        if (!result.added) {
          return res.status(result.reason === "memory_not_found" ? 404 : 400).json({
            ok: false,
            error: result.reason || "add_fact_failed",
          });
        }
        return res.json({
          ok: true,
          action: "add_fact",
          memoryId: p.memoryId,
          factKey: p.factKey,
          replacedExisting: result.replacedExisting,
        });
      }
      case "remove_fact": {
        if (!p.memoryId) return res.status(400).json({ ok: false, error: "remove_fact_requires_memoryId" });
        const result = removeFact({
          memoryId: p.memoryId,
          factKey: p.factKey || null,
          opts: sharedOpts,
        });
        if (result.reason === "memory_not_found") {
          return res.status(404).json({ ok: false, error: "memory_not_found" });
        }
        return res.json({
          ok: true,
          action: "remove_fact",
          memoryId: p.memoryId,
          factKey: p.factKey || "*",
          removed: result.removed,
        });
      }
      default:
        return res.status(400).json({ ok: false, error: "unknown_action" });
    }
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

// FTS 关键词搜索：ops/调试用，非 tool 调用
router.post("/admin/search-fts", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    q: z.string().min(1),
    scope: z.enum(["conversation", "memory", "both"]).default("both"),
    limit: z.coerce.number().int().positive().max(50).default(20),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, q, scope, limit } = parsed.data;

  try {
    const hits = [];
    if (scope === "conversation" || scope === "both") {
      const rows = searchConversation({ assistantId, q, limit });
      for (const row of rows) {
        hits.push({
          kind: "conversation",
          id: row.id,
          content: row.content,
          score: row.score,
          role: row.role,
          sessionId: row.session_id,
          createdAt: row.created_at,
        });
      }
    }
    if (scope === "memory" || scope === "both") {
      const rows = searchMemory({ assistantId, q, limit });
      for (const row of rows) {
        hits.push({
          kind: "memory",
          id: row.id,
          content: row.content,
          score: row.score,
          memoryType: row.memory_type,
          createdAt: row.created_at,
        });
      }
    }
    hits.sort((a, b) => a.score - b.score);
    if (scope === "both" && hits.length > limit) hits.length = limit;
    return res.json({ ok: true, hits });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post("/character/catchup", authMiddleware, async (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    lastInteractionAt: z.number().int().min(0),
    now: z.number().int().min(0).optional(),
    maxEvents: z.number().int().min(1).max(8).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  try {
    const result = await runCatchup({
      assistantId: parsed.data.assistantId,
      lastInteractionAt: parsed.data.lastInteractionAt,
      now: parsed.data.now,
      maxEvents: parsed.data.maxEvents,
    });
    return res.json({ ok: result.ok !== false, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post("/proactive/regenerate-plans", authMiddleware, async (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1).optional(),
    // force=true 时跳过 trigger 评估、忽略 allow_proactive_message 开关，
    // 用 manual_request trigger 强制生成一条 plan，scheduled_at = now + 2min
    force: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  try {
    const result = await generatePlans({
      assistantId: parsed.data.assistantId || null,
      force: parsed.data.force === true,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.get("/proactive/plans", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().trim().min(1).optional(),
    status: z.enum(["pending", "sent", "cancelled", "failed", "all"]).default("pending"),
    limit: z.coerce.number().int().positive().max(500).optional(),
  });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const { assistantId, status, limit } = parsed.data;
  let rows;
  if (status === "all") {
    const params = [];
    let sql = "SELECT * FROM proactive_plans WHERE 1=1";
    if (assistantId) {
      sql += " AND assistant_id = ?";
      params.push(assistantId);
    }
    sql += " ORDER BY scheduled_at DESC";
    if (limit) {
      sql += " LIMIT ?";
      params.push(limit);
    } else {
      sql += " LIMIT 200";
    }
    rows = db.prepare(sql).all(...params);
  } else if (status === "pending") {
    rows = listPendingPlans({ assistantId });
    if (limit) rows = rows.slice(0, limit);
  } else {
    rows = listPlansByStatus({ assistantId, status });
    if (limit) rows = rows.slice(0, limit);
  }
  return res.json({
    ok: true,
    count: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      assistantId: r.assistant_id,
      userId: r.user_id,
      triggerReason: r.trigger_reason,
      intent: r.intent,
      draftTitle: r.draft_title,
      draftBody: r.draft_body,
      anchorTopic: r.anchor_topic,
      rationale: r.rationale,
      scheduledAt: r.scheduled_at,
      status: r.status,
      cancelledReason: r.cancelled_reason,
      sentAt: r.sent_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
  });
});

router.delete("/proactive/plans/:id", authMiddleware, (req, res) => {
  const schema = z.object({ reason: z.string().max(120).optional() });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const plan = findPlanById(req.params.id);
  if (!plan) return res.status(404).json({ ok: false, error: "plan_not_found" });
  const cancelled = cancelPlanById(req.params.id, parsed.data.reason || "manual");
  return res.json({ ok: true, cancelled, planId: req.params.id });
});

module.exports = router;
