/**
 * 角色日记 / 周记 endpoints。
 *
 * 拆分自原 src/routes/api.js（2026-05-23）。
 *
 *   GET    /api/character/journal?assistantId=&period=daily|weekly&limit=
 *   GET    /api/character/journal/:id
 *   GET    /api/character/journal/settings?assistantId=
 *   PATCH  /api/character/journal/settings   body={ assistantId, enableDaily?, enableWeekly? }
 *   POST   /api/character/journal/generate   body={ assistantId, periodType, force? }
 *
 * 路由顺序敏感：/settings 和 /generate 是静态 path，必须先于 /:id 注册，
 * 否则会被 /:id 通配吞掉（Express 按注册顺序匹配）。
 */

const express = require("express");
const { z } = require("zod");
const { getAssistantProfile } = require("../../db");
const {
  generateJournalFor,
  listJournalEntries,
  getJournalEntryById,
  updateJournalSettings,
} = require("../../services/character/journalService");
const { authMiddleware } = require("./_middleware");

const router = express.Router();

router.get("/character/journal", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().trim().min(1),
    period: z.enum(["daily", "weekly"]).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, period, limit = 20 } = parsed.data;
  const entries = listJournalEntries({ assistantId, periodType: period, limit }).map((e) => ({
    id: e.id,
    assistantId: e.assistant_id,
    periodType: e.period_type,
    periodStart: e.period_start,
    periodEnd: e.period_end,
    entryDate: e.entry_date,
    content: e.content,
    createdAt: e.created_at,
  }));
  return res.json({ ok: true, entries });
});

router.get("/character/journal/settings", authMiddleware, (req, res) => {
  const schema = z.object({ assistantId: z.string().trim().min(1) });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const profile = getAssistantProfile(parsed.data.assistantId);
  if (!profile) return res.status(404).json({ ok: false, error: "assistant_not_found" });
  return res.json({
    ok: true,
    settings: {
      assistantId: profile.assistant_id,
      enableDaily: profile.enable_daily_journal === 1,
      enableWeekly: profile.enable_weekly_journal === 1,
    },
  });
});

router.patch("/character/journal/settings", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().trim().min(1),
    enableDaily: z.boolean().optional(),
    enableWeekly: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, enableDaily, enableWeekly } = parsed.data;
  if (enableDaily === undefined && enableWeekly === undefined) {
    return res.status(400).json({ ok: false, error: "no_fields_to_update" });
  }
  const profile = updateJournalSettings({ assistantId, enableDaily, enableWeekly });
  if (!profile) return res.status(404).json({ ok: false, error: "assistant_not_found" });
  return res.json({
    ok: true,
    settings: {
      assistantId: profile.assistant_id,
      enableDaily: profile.enable_daily_journal === 1,
      enableWeekly: profile.enable_weekly_journal === 1,
    },
  });
});

router.post("/character/journal/generate", authMiddleware, async (req, res) => {
  const schema = z.object({
    assistantId: z.string().trim().min(1),
    periodType: z.enum(["daily", "weekly"]),
    force: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, periodType, force = false } = parsed.data;
  try {
    const result = await generateJournalFor({ assistantId, periodType, force });
    return res.json({ ok: true, result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

// 单条详情放在末尾：/settings 和 /generate 是静态 path，要先匹配；
// 放最前面会被 /:id 通配吞掉
router.get("/character/journal/:id", authMiddleware, (req, res) => {
  const e = getJournalEntryById(req.params.id);
  if (!e) return res.status(404).json({ ok: false, error: "journal_entry_not_found" });
  return res.json({
    ok: true,
    entry: {
      id: e.id,
      assistantId: e.assistant_id,
      periodType: e.period_type,
      periodStart: e.period_start,
      periodEnd: e.period_end,
      entryDate: e.entry_date,
      content: e.content,
      createdAt: e.created_at,
    },
  });
});

module.exports = router;
