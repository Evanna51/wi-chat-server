/**
 * 知识库 endpoints。
 *
 * 拆分自原 src/routes/api.js（2026-05-23）。
 *
 * @dormant 整组暂未使用 — knowledge 写入路径（手动 + AI 主动）都未启用。
 *
 * memory_type='knowledge' 的条目独立于对话流，设计上：AI 可主动 add（值得长期保留的事实），
 * 用户/管理员也可手动维护（角色设定、世界观、长期偏好等）；检索通过 memory-recall 加
 * source='knowledge' / kbName='xxx' 过滤。但当前 admin UI 没做 knowledge 编辑页，
 * AI 也没启用 knowledge-add tool，所以四个端点 (upsert/list/bases/tool-knowledge-add)
 * 全部 dormant。未来知识库功能上线时直接复用，schema 保持稳定。
 */

const express = require("express");
const { z } = require("zod");
const {
  upsertKnowledgeItem,
  listKnowledgeItems,
  listKnowledgeBases,
} = require("../../services/knowledgeService");
const { authMiddleware } = require("./_middleware");

const router = express.Router();

router.post("/knowledge/upsert", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    kbName: z.string().min(1).max(100),
    content: z.string().min(1).max(8000),
    id: z.string().min(1).optional(),       // 传现有 id 则更新
    tags: z.array(z.string().max(40)).max(20).optional(),
    salience: z.coerce.number().min(0).max(1).optional(),
    quality: z.enum(["A", "B", "C", "D", "E"]).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  try {
    const r = upsertKnowledgeItem({
      assistantId: parsed.data.assistantId,
      kbName: parsed.data.kbName,
      content: parsed.data.content,
      id: parsed.data.id,
      tags: parsed.data.tags,
      salience: parsed.data.salience ?? 0.9,
      quality: parsed.data.quality || "A",
    });
    return res.json({ ok: true, ...r });
  } catch (e) {
    const status =
      e.message === "knowledge_item_not_found"
        ? 404
        : e.message === "assistant_mismatch" || e.message === "not_a_knowledge_item"
        ? 400
        : 500;
    return res.status(status).json({ ok: false, error: e.message });
  }
});

router.get("/knowledge/list", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    kbName: z.string().optional(),
    limit: z.coerce.number().int().positive().max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  try {
    const items = listKnowledgeItems(parsed.data);
    return res.json({ ok: true, count: items.length, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/knowledge/bases", authMiddleware, (req, res) => {
  const schema = z.object({ assistantId: z.string().min(1) });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  try {
    const bases = listKnowledgeBases({ assistantId: parsed.data.assistantId });
    return res.json({ ok: true, bases });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * AI 主动写入知识库（区别于 memory-correct 的修正语义）。
 * 例：用户透露关键事实 → AI 调本接口写入 kbName='user_profile' 知识库。
 */
router.post("/tool/knowledge-add", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    kbName: z.string().min(1).max(100),
    content: z.string().min(1).max(8000),
    tags: z.array(z.string().max(40)).max(20).optional(),
    reason: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  try {
    const r = upsertKnowledgeItem({
      assistantId: parsed.data.assistantId,
      kbName: parsed.data.kbName,
      content: parsed.data.content,
      tags: parsed.data.tags,
      salience: 0.85, // AI 主动写默认 0.85，比用户手动写（0.9）略低
    });
    return res.json({ ok: true, ...r });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
