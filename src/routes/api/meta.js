/**
 * meta endpoints：/health、/assistant-profile/upsert、/relationship/state。
 *
 * 拆分自原 src/routes/api.js（2026-05-23）。
 */

const express = require("express");
const { z } = require("zod");
const {
  upsertAssistantProfile,
  countAllowAutoLifeAssistants,
} = require("../../db");
const { ensureDefaultState } = require("../../services/characterStateService");
const { buildRelationshipStatePayload } = require("../../services/relationshipStateView");
const { authMiddleware } = require("./_middleware");

const router = express.Router();
let didWarnAutoLifeCount = false;

router.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
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

  // Phase 3: setup_prompt 改了 → emit profile.setup_prompt.changed，
  // personaExtraction subscriber 异步跑 LLM 提炼（不阻塞 HTTP 响应）。
  if (row._setupPromptChanged) {
    const { profileEvents } = require("../../events/profileEvents");
    profileEvents.emitSetupPromptChanged({
      assistantId: row.assistant_id,
      setupPrompt: row.setup_prompt || row.character_background || "",
      assistantType: row.assistant_type || "",
    });
  }

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
      // Phase 3 字段
      setupPrompt: row.setup_prompt || "",
      lore: row.lore || "",
      extractionStatus: row.extraction_status || "skipped",
      extractedAt: row.extracted_at || 0,
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

/**
 * GET /api/relationship/state?assistantId=xxx
 *
 * @dormant 暂未使用 — 当前 Android / admin UI 都不调。
 *
 * 用途：返回角色实时态（mood + 关系 + 精力）的轻量快照。
 * 与 POST /api/character/context 的关系：context 响应里 `characterState` 字段已经包含
 * 同一份 payload，客户端实际从那里 fan-out。这个端点保留是因为未来如果要"只刷新状态、
 * 不重拉整个 character bootstrap"会需要它。
 *
 * 行为：character_state 行不存在时 ensureDefaultState 兜底，永远返回结构完整 payload。
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

module.exports = router;
