/**
 * Memory 工具端点：
 *   POST /api/tool/memory-recall    Agentic RAG 搜索（user / character / knowledge）
 *   POST /api/tool/memory-correct   修正/删除/打标记 6 个 action
 *   POST /api/tool/web-search       Web 搜索（Tavily / 当前新闻 / 热点）
 *   POST /api/admin/search-fts      FTS 关键词搜索（dormant）
 *
 * 拆分自原 src/routes/api.js（2026-05-23）。
 */

const express = require("express");
const { z } = require("zod");
const { searchConversation, searchMemory } = require("../../db");
const { retrieveMemory } = require("../../services/memoryRetrievalService");
const { runWebSearch } = require("../../services/webSearchService");
const {
  deleteMemoryItemCascade,
  deleteMemoryItemsBatch,
  updateMemoryItemContent,
  setMemoryQuality,
  addFact,
  removeFact,
  setMemoryPinned,
} = require("../../services/memoryEditService");
const { authMiddleware } = require("./_middleware");

const router = express.Router();

/**
 * Agentic RAG 搜索端点：给 app 端 LLM 的 search_memory tool 直接调用。
 *
 * - 默认 source='user'，只搜用户说过的话（user_turn）；适用于绝大多数召回场景
 * - source='character' 只搜角色自生成的叙事（life_event/work_event），条目极少，
 *   仅在明确需要角色内心独白/日记时使用；用户提到"你记得吗"不等于 source=character
 * - 无 decision 逻辑（与 /tool/memory-context 区分）：LLM 已决定要查，server 直接执行
 */
router.post("/tool/memory-recall", authMiddleware, async (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    query: z.string().min(1),
    source: z.enum(["user", "character", "knowledge", "all"]).default("user"),
    category: z.enum([
      "chitchat", "personal_experience", "relationship_info", "knowledge",
      "goals_plans", "preferences", "decisions_reflections", "wellbeing", "ideas",
    ]).optional(),
    minQuality: z.enum(["A", "B", "C", "D", "E"]).optional(),
    topK: z.coerce.number().int().positive().max(20).default(5),
    sessionId: z.string().optional(),
    // PR-11 新增过滤维度。值与 ALLOWED_MEMORY_TYPES (src/db.js) 同步。
    memoryType: z.enum([
      "user_turn", "life_event", "work_event", "knowledge",
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
    // PR-14 新增（仅在指定 kb_name 知识空间内搜）
    kbName: z.string().min(1).max(100).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const {
    assistantId, query, source, category, minQuality, topK, sessionId,
    memoryType, fromMs, toMs, withinDays, minScore, excludeIds, includeFacts,
    dateString, excludeRecentEcho, kbName,
  } = parsed.data;

  // kbName 隐含 source='knowledge'：用户传 kbName 时显然只想搜知识库，
  // 不应该被默认 source='user' 过滤掉
  const effectiveSource = kbName ? "knowledge" : source;

  try {
    const memories = await retrieveMemory({
      assistantId,
      sessionId: sessionId || "",
      query,
      topK,
      source: effectiveSource,
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
      kbName: kbName || null,
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
 *   action: 'pin' / 'unpin'  pin / unpin
 *
 * 所有动作都会写 memory_audit_log。assistantId 强校验防跨角色误删。
 */
router.post("/tool/memory-correct", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    action: z.enum(["delete", "delete_batch", "update", "set_quality", "add_fact", "remove_fact", "pin", "unpin"]),
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
    factImportance: z.coerce.number().min(0).max(1).optional(),
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
          importance: p.factImportance ?? 0.5,
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
      case "pin":
      case "unpin": {
        if (!p.memoryId) return res.status(400).json({ ok: false, error: `${p.action}_requires_memoryId` });
        const result = setMemoryPinned(p.memoryId, p.action === "pin", sharedOpts);
        if (!result.found) {
          return res.status(404).json({ ok: false, error: result.reason || "memory_not_found" });
        }
        return res.json({
          ok: true,
          action: p.action,
          memoryId: p.memoryId,
          isPinned: result.isPinned,
          changed: result.changed,
        });
      }
      default:
        return res.status(400).json({ ok: false, error: "unknown_action" });
    }
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

/**
 * POST /api/tool/web-search
 *
 * 给客户端 chat LLM 的 `web_search` tool 调用。Tavily 后端，每角色每自然日 3 次配额
 * （webSearchService 已经处理 quota + journal 记录，本端点透传）。
 *
 * 用例：
 *   - 用户问"今天天气怎么样" / "最近 X 事件"
 *   - 用户问角色不可能从 memory 知道的当前事实
 *   - 角色想分享一条热点 / 新闻给用户（cognition router 可决定开 web_search tool）
 *
 * 不做：百科 / 词典 / 计算 / 编程问题（让 chat LLM 自己答；web_search 是"找当前事实"工具）。
 *
 * 失败语义：返回 ok:false + reason（empty_query / daily_cap_exceeded / api_key_missing /
 *           provider_error / no_results）。客户端要把 reason 当作"工具空命中"语义化展示给 chat LLM。
 */
router.post("/tool/web-search", authMiddleware, async (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    query: z.string().min(1).max(200),
    topic: z.enum(["general", "news"]).default("news"),
    maxResults: z.coerce.number().int().positive().max(10).default(5),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, query, topic, maxResults } = parsed.data;

  try {
    const result = await runWebSearch({ assistantId, query, topic, maxResults });
    if (!result.ok) {
      // 失败也返 200 + ok:false —— tool call 语义上"成功调到了，只是没结果"
      return res.json({
        ok: false,
        query,
        reason: result.reason,
        used: result.used,
        cap: result.cap,
        error: result.error,
      });
    }
    return res.json({
      ok: true,
      query: result.query,
      count: result.results.length,
      answer: result.answer || null,
      results: result.results.map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: typeof r.score === "number" ? Number(r.score.toFixed(3)) : null,
        publishedDate: r.publishedDate || null,
      })),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

/**
 * POST /api/admin/search-fts
 *
 * @dormant 暂未使用 — admin UI 用 /api/search（browse router），不调这个。
 * 注：migration 020_drop_conversation_fts.sql 已经砍掉 conversation_turns_fts 表，
 * 这个端点现在依赖的 FTS 后端可能不全。如未来复活需要先确认 FTS 表是否存在。
 *
 * 用途：FTS 关键词搜索 — ops / 调试用，非 tool 调用。
 */
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

module.exports = router;
