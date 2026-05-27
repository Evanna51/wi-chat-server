/**
 * /api/character/* 路由 —— 角色认知层全部端点。
 *
 * 拆分自原 src/routes/api.js（2026-05-23）。包含：
 *   - identity / extract / lore / vocab        人格底色
 *   - episodes / topics                        长期记忆叙事
 *   - reflection                                关系反思
 *   - behavior-intent / attention-1h           行为决策
 *   - context                                   chat hot path（inspect 端点）
 *   - life-plan/today                           当日 beat 时间表（debug）
 *   - admin/character/build-episodes / reflect 手动触发 LLM 任务
 *
 * 已废弃端点：
 *   - POST /character/catchup —— 取代为 daily-life-plan + life-beat-tick（migration 035）。
 *     调用方会收到 410 Gone + Deprecation header；详见 docs/character-life-beat-plan.md。
 */

const express = require("express");
const { z } = require("zod");
const { db, getAssistantProfile } = require("../../db");
const { buildCharacterContext } = require("../../services/character/characterContextBuilder");
const {
  getCharacterIdentity,
  upsertIdentity,
} = require("../../services/character/identityService");
const identityVocab = require("../../services/character/identityVocab");
const { extractPersona } = require("../../services/character/personaExtractor");
const {
  listEpisodes,
  getEpisodeById,
  buildEpisodesFor,
} = require("../../services/character/episodeBuilder");
const {
  listActiveTopics,
  listAllTopics,
  createTopic,
  transitionStatus,
  setImportance,
  VALID_STATUSES,
} = require("../../services/character/persistentTopicService");
const {
  getLatestReflection,
  listReflections,
  reflectFor,
} = require("../../services/character/reflectionService");
const {
  evaluate: evaluateBehaviorIntent,
  INTENT_DEFINITIONS,
} = require("../../services/character/behaviorPlanner");
const { buildAttention1h } = require("../../services/character/attentionWindow");
const {
  generateLifePlanFor,
  hasLifePlanForDate,
} = require("../../services/character/lifePlannerService");
const { listLifeBeatsForDate } = require("../../db");
const { authMiddleware } = require("./_middleware");

const router = express.Router();

// ── Identity CRUD (T-CC-07) ─────────────────────────────────────────
//
// GET  /api/character/identity?assistantId=
// POST /api/character/identity/upsert  body={ assistantId, ...fields }
// GET  /api/character/identity/vocab    返回所有受控词表（供 admin UI）
//
// 校验：upsertIdentity 内部用 identityVocab.validate*，非法字段抛错 → 400。

router.get("/character/identity", authMiddleware, (req, res) => {
  const schema = z.object({ assistantId: z.string().trim().min(1) });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const identity = getCharacterIdentity(parsed.data.assistantId);
  return res.json({ ok: true, identity: identity || null });
});

router.post("/character/identity/upsert", authMiddleware, (req, res) => {
  // identity 字段集合大，不在这里逐个 zod —— 让 service 层 validate*** 兜底。
  // 仅 assistantId 必填校验。
  const schema = z.object({ assistantId: z.string().trim().min(1) }).passthrough();
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, ...fields } = parsed.data;
  try {
    const identity = upsertIdentity(assistantId, fields);
    return res.json({ ok: true, identity });
  } catch (error) {
    const msg = error?.message || String(error);
    return res.status(/identity validation/i.test(msg) ? 400 : 500).json({ ok: false, error: msg });
  }
});

router.get("/character/identity/vocab", authMiddleware, (_req, res) => {
  return res.json({
    ok: true,
    personalityTraits: identityVocab.PERSONALITY_TRAITS,
    attachmentStyles: identityVocab.ATTACHMENT_STYLES,
    socialStrategies: identityVocab.SOCIAL_STRATEGIES,
    careLanguages: identityVocab.CARE_LANGUAGES,
    tensions: identityVocab.TENSIONS,
    commonInsecurities: identityVocab.COMMON_INSECURITIES,
    commonCoreWounds: identityVocab.COMMON_CORE_WOUNDS,
    commonDesires: identityVocab.COMMON_DESIRES,
    commonSkills: identityVocab.COMMON_SKILLS,
    pronounPresets: identityVocab.PRONOUN_PRESETS,
  });
});

/**
 * POST /api/character/extract — Phase 3: setup_prompt → identity + lore（同步 dry-run）。
 *
 * 用本地 LLM 提炼用户写的角色 prompt，返回结构化 identity 字段 + 净化后的 lore。
 * 端点**不写库** —— 让 admin UI 拿到 preview 后让用户 review/修改，再调
 * /api/character/identity/upsert + /api/character/lore/save 保存。
 *
 * 也可直接传 assistantId 让 server 从 DB 拿 setup_prompt（admin UI 简化路径）。
 *
 * @body { setupPrompt?: string, assistantId?: string }
 *   两者至少传一个；都传时 setupPrompt 优先（让 admin 在 UI 里改完未保存就能 preview）。
 */
router.post("/character/extract", authMiddleware, async (req, res) => {
  const schema = z.object({
    setupPrompt: z.string().optional(),
    assistantId: z.string().trim().min(1).optional(),
  }).refine((d) => d.setupPrompt || d.assistantId, {
    message: "either setupPrompt or assistantId required",
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });

  let { setupPrompt, assistantId } = parsed.data;

  // 没传 setupPrompt → 从 DB 拿
  if (!setupPrompt && assistantId) {
    const profile = getAssistantProfile(assistantId);
    if (!profile) return res.status(404).json({ ok: false, error: "assistant_profile_not_found" });
    setupPrompt = profile.setup_prompt || profile.character_background || "";
  }
  if (!setupPrompt || !setupPrompt.trim()) {
    return res.status(400).json({ ok: false, error: "empty_setup_prompt" });
  }

  const start = Date.now();
  try {
    const result = await extractPersona(setupPrompt, {
      callOpts: { scopeKey: assistantId || null },
    });
    return res.json({
      ok: !result.error,
      assistantId: assistantId || null,
      identity: result.identity,
      lore: result.lore,
      error: result.error || null,
      extractionMs: Date.now() - start,
      // raw LLM 输出 — 调试用，前端可隐藏
      raw: result.raw,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

/**
 * POST /api/character/lore/save — 写 assistant_profile.lore（净化后的叙事段）。
 */
router.post("/character/lore/save", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().trim().min(1),
    lore: z.string(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, lore } = parsed.data;
  try {
    const r = db
      .prepare(
        "UPDATE assistant_profile SET lore = ?, extraction_status = 'ready', extracted_at = ?, updated_at = ? WHERE assistant_id = ?"
      )
      .run(lore, Date.now(), Date.now(), assistantId);
    if (r.changes === 0) {
      return res.status(404).json({ ok: false, error: "assistant_profile_not_found" });
    }
    return res.json({ ok: true, assistantId, loreLen: lore.length });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

// ── Phase 2: narrative episodes (T-CC2-07) ──────────────────────────

router.get("/character/episodes", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().trim().min(1),
    limit: z.coerce.number().int().positive().max(100).optional(),
    minImportance: z.coerce.number().min(0).max(1).optional(),
  });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, limit = 20, minImportance = 0 } = parsed.data;
  return res.json({ ok: true, episodes: listEpisodes(assistantId, { limit, minImportance }) });
});

/**
 * GET /api/character/episodes/:id
 *
 * @dormant 暂未使用 — admin UI 只调列表 /character/episodes，未做详情页。
 */
router.get("/character/episodes/:id", authMiddleware, (req, res) => {
  const ep = getEpisodeById(req.params.id);
  if (!ep) return res.status(404).json({ ok: false, error: "episode_not_found" });
  return res.json({ ok: true, episode: ep });
});

router.post("/admin/character/build-episodes", authMiddleware, async (req, res) => {
  const schema = z.object({ assistantId: z.string().trim().min(1) });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  try {
    const result = await buildEpisodesFor(parsed.data.assistantId, { source: "admin" });
    return res.json({ ok: true, result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

// ── Phase 2: persistent topics ──────────────────────────────────────

router.get("/character/topics", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().trim().min(1),
    status: z.enum([...VALID_STATUSES]).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    includeInactive: z.coerce.boolean().optional(),
  });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, status, limit = 20, includeInactive = false } = parsed.data;
  const topics = includeInactive
    ? listAllTopics(assistantId, { limit })
    : listActiveTopics(assistantId, { limit, statuses: status ? [status] : undefined });
  return res.json({ ok: true, topics });
});

/**
 * POST /api/character/topics/upsert
 *
 * @dormant 暂未使用 — hot path 不创建新 topic（topic 由对话流程自动浮现）。
 */
router.post("/character/topics/upsert", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().trim().min(1),
    topic: z.string().trim().min(1),
    aliases: z.array(z.string()).optional(),
    emotionalAssociation: z.string().optional(),
    status: z.enum([...VALID_STATUSES]).optional(),
    importance: z.number().min(0).max(1).optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  try {
    const created = createTopic(parsed.data.assistantId, parsed.data);
    return res.json({ ok: true, topic: created });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || String(error) });
  }
});

/**
 * POST /api/character/topics/:id/status
 *
 * @dormant 暂未使用 — topic 状态机目前由内部服务推进，未暴露 admin 手动入口。
 */
router.post("/character/topics/:id/status", authMiddleware, (req, res) => {
  const schema = z.object({ status: z.enum([...VALID_STATUSES]) });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  try {
    return res.json({ ok: true, topic: transitionStatus(req.params.id, parsed.data.status) });
  } catch (error) {
    return res.status(/not found/.test(error.message) ? 404 : 400).json({ ok: false, error: error.message });
  }
});

/**
 * POST /api/character/topics/:id/importance
 *
 * @dormant 暂未使用 — importance 由内部信号自动调。
 */
router.post("/character/topics/:id/importance", authMiddleware, (req, res) => {
  const schema = z.object({ importance: z.number().min(0).max(1) });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  try {
    return res.json({ ok: true, topic: setImportance(req.params.id, parsed.data.importance) });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

// ── Phase 3: relationship reflection (T-CC3-05) ─────────────────────

/**
 * GET /api/character/reflection?assistantId=
 *
 * @dormant 暂未使用 — admin UI 用复数版 /character/reflections（时间线）。
 */
router.get("/character/reflection", authMiddleware, (req, res) => {
  const schema = z.object({ assistantId: z.string().trim().min(1) });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const r = getLatestReflection(parsed.data.assistantId);
  return res.json({ ok: true, reflection: r || null });
});

router.get("/character/reflections", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().trim().min(1),
    type: z.enum(["weekly", "event_triggered", "manual"]).optional(),
    limit: z.coerce.number().int().positive().max(50).optional(),
  });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, type = null, limit = 20 } = parsed.data;
  return res.json({ ok: true, reflections: listReflections(assistantId, { limit, type }) });
});

router.post("/admin/character/reflect", authMiddleware, async (req, res) => {
  const schema = z.object({
    assistantId: z.string().trim().min(1),
    reflectionType: z.enum(["weekly", "event_triggered", "manual"]).optional(),
    triggerReason: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  try {
    const result = await reflectFor(parsed.data.assistantId, {
      reflectionType: parsed.data.reflectionType || "manual",
      triggerReason: parsed.data.triggerReason || null,
    });
    return res.json({ ok: true, result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

// ── Phase 4: behavior planner + attention window ────────────────────
//
// 2026-05-10: behavior-intent 改 async — 内部 await buildAttention1h，让启发式
// intent 评估能用上 LLM 提炼的现场感（abandonment_focus / unresolved_topic 等）。
// 传 ?withAttention=0 可跳过 attention 入参（保持原启发式行为，便于对比）。

router.get("/character/behavior-intent", authMiddleware, async (req, res) => {
  const schema = z.object({
    assistantId: z.string().trim().min(1),
    withAttention: z.coerce.boolean().optional(),
  });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  const { assistantId, withAttention = true } = parsed.data;

  let attention1h = null;
  if (withAttention) {
    try {
      attention1h = await buildAttention1h(assistantId);
    } catch (err) {
      console.warn(`[behavior-intent] attention_1h failed: ${err.message}`);
    }
  }
  const result = evaluateBehaviorIntent(assistantId, { attention1h });
  if (!result) return res.status(404).json({ ok: false, error: "no_character_state" });
  return res.json({ ok: true, ...result, attention1h });
});

router.get("/character/behavior-intent/vocab", authMiddleware, (_req, res) => {
  return res.json({ ok: true, intents: INTENT_DEFINITIONS });
});

router.get("/character/attention-1h", authMiddleware, async (req, res) => {
  const schema = z.object({ assistantId: z.string().trim().min(1) });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.message });
  try {
    const payload = await buildAttention1h(parsed.data.assistantId);
    return res.json({ ok: true, ...payload });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

// ── 角色认知层 inspect 端点（admin / debug 用） ──────────────────────

/**
 * POST /api/character/context
 *
 * 客户端 chat hot path 不再使用此端点 —— 走 /api/chat/context。本端点保留给
 * admin UI 和 debug 工具看 7 层认知态全貌 + 渲染好的 V_NEW_LEAN slots + assistantPrefill。
 */
router.post("/character/context", authMiddleware, (req, res) => {
  const schema = z.object({
    assistantId: z.string().trim().min(1),
    lastUserMessage: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const { assistantId, lastUserMessage } = parsed.data;
  try {
    const ctx = buildCharacterContext(assistantId, { lastUserMessage });
    if (!ctx) {
      return res.status(404).json({ ok: false, error: "assistant_profile_not_found" });
    }
    return res.json({ ok: true, ...ctx });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

// ── DEPRECATED: catchup ─────────────────────────────────────────────
//
// 2026-05-24 起取代为 daily-life-plan + life-beat-tick（migration 035）。
// 保留 410 Gone 让调用方看到明确错误后顺势 cleanup；不静默返回 200。

router.post("/character/catchup", authMiddleware, (req, res) => {
  res.setHeader("Deprecation", "true");
  res.setHeader("Sunset", "Wed, 24 May 2026 00:00:00 GMT");
  res.setHeader("Link", '</api/character/life-plan/today>; rel="successor-version"');
  return res.status(410).json({
    ok: false,
    error: "endpoint_removed",
    message:
      "POST /api/character/catchup 已废弃。角色生活记忆现由后台 daily-life-plan + " +
      "life-beat-tick 自动生成；详见 docs/character-life-beat-plan.md。",
    successor: "GET /api/character/life-plan/today",
  });
});

// ── 当日 life plan（debug / admin 查看） ─────────────────────────────
//
// GET /api/character/life-plan/today?assistantId=...&date=YYYY-MM-DD
//   - date 不传 → 今日（本地时区）
//   - lazy: 若当日完全没有 plan，会触发一次 generateLifePlanFor 兜底生成，
//     再返回。SHORT_TTL 不在这里处理（cron 锁是另一道；同一进程多次并发查
//     可能造成 2 次 LLM 调用，admin debug 场景可接受）。

router.get("/character/life-plan/today", authMiddleware, async (req, res) => {
  const schema = z.object({
    assistantId: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    lazy: z.enum(["0", "1"]).optional(),
  });
  const parsed = schema.safeParse(req.query || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const { assistantId } = parsed.data;
  const planDate = parsed.data.date || (() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  })();
  const lazy = parsed.data.lazy !== "0"; // 默认开

  try {
    let beats = listLifeBeatsForDate({ assistantId, planDate });
    let lazyTriggered = false;
    if (!beats.length && lazy) {
      const r = await generateLifePlanFor({ assistantId, planDate });
      lazyTriggered = !!r.ok;
      beats = listLifeBeatsForDate({ assistantId, planDate });
    }
    return res.json({
      ok: true,
      assistantId,
      planDate,
      lazyTriggered,
      total: beats.length,
      beats: beats.map((b) => ({
        id: b.id,
        scheduledAt: b.scheduled_at,
        activity: b.activity,
        beatType: b.beat_type,
        importance: b.importance,
        reachSeed: b.reach_seed,
        status: b.status,
        activatedAt: b.activated_at,
        memoryItemId: b.memory_item_id,
      })),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;
