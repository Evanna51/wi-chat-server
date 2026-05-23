/**
 * 主动消息 plan endpoints：
 *   POST   /api/proactive/regenerate-plans  手动跑一轮 generatePlans
 *   GET    /api/proactive/plans             列查 plans（按 status 过滤）
 *   DELETE /api/proactive/plans/:id         手动 cancel 一条 pending plan
 *
 * 拆分自原 src/routes/api.js（2026-05-23）。
 */

const express = require("express");
const { z } = require("zod");
const { db } = require("../../db");
const {
  generatePlans,
  listPendingPlans,
  listPlansByStatus,
  cancelPlanById,
  findPlanById,
} = require("../../services/proactive");
const { authMiddleware } = require("./_middleware");

const router = express.Router();

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
