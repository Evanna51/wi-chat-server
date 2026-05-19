const express = require("express");
const { z } = require("zod");
const {
  db,
  upsertAssistantProfile,
  getAssistantProfile,
  countAllowAutoLifeAssistants,
  searchConversation,
  searchMemory,
} = require("../db");
const { retrieveMemory } = require("../services/memoryRetrievalService");
const { runCatchup } = require("../services/catchupService");
const { ensureDefaultState } = require("../services/characterStateService");
const { buildRelationshipStatePayload } = require("../services/relationshipStateView");
const { buildCharacterContext } = require("../services/character/characterContextBuilder");
const {
  getCharacterIdentity,
  upsertIdentity,
  listAllIdentities,
} = require("../services/character/identityService");
const identityVocab = require("../services/character/identityVocab");
const { extractPersona } = require("../services/character/personaExtractor");
// Phase 2: narrative + topics
const {
  listEpisodes,
  getEpisodeById,
  buildEpisodesFor,
} = require("../services/character/episodeBuilder");
const {
  listActiveTopics,
  listAllTopics,
  createTopic,
  transitionStatus,
  setImportance,
  VALID_STATUSES,
} = require("../services/character/persistentTopicService");
// Phase 3: reflection
const {
  getLatestReflection,
  listReflections,
  reflectFor,
} = require("../services/character/reflectionService");
// Phase 4: behavior planner
const {
  evaluate: evaluateBehaviorIntent,
  INTENT_DEFINITIONS,
} = require("../services/character/behaviorPlanner");
// 2026-05-10: behavior-intent 端点 + attention-1h debug 端点共用
const { buildAttention1h } = require("../services/character/attentionWindow");
const {
  deleteMemoryItemCascade,
  deleteMemoryItemsBatch,
  updateMemoryItemContent,
  setMemoryQuality,
  addFact,
  removeFact,
  setMemoryPinned,
  getCoreMemories,
  getCoreFacts,
} = require("../services/memoryEditService");
const {
  upsertKnowledgeItem,
  listKnowledgeItems,
  listKnowledgeBases,
} = require("../services/knowledgeService");
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
    const { profileEvents } = require("../events/profileEvents");
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

// 注：原 HTTP 轮询通道（/register-local-inbox, /pull-messages, /ack-message）
// 与 /report-interaction 均已于 2026-05-06 移除。
// 实时推送统一走 WebSocket /api/ws；对话写入统一走 /api/chat/turn（语义化别名 /api/sync/push）。
//
// /api/chat-with-memory 已于 Phase 2 删除（无客户端调用，server 内部也不依赖）。
// 客户端走 /api/chat/context（获取 system prompt 数据）+ 自己调 LLM + /api/chat/turn 上传。

// /api/tool/memory-context 已于 Phase 2 cleanup 删除（决策点：仅 dev 客户端，无兼容包袱）。
// 客户端走 POST /api/chat/context — 内部合并了 memory decision + retrieval。

function safeGetCoreMemories(assistantId) {
  try {
    return getCoreMemories(assistantId, { limit: 8 });
  } catch (e) {
    return [];
  }
}

function safeGetCoreFacts(assistantId) {
  try {
    return getCoreFacts(assistantId, { limit: 15 });
  } catch (e) {
    return [];
  }
}

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

/**
 * POST /api/character/context  (T-CC-06)
 *
 * 把 7 层 character cognition 聚合成单一 payload，并由 server 拼好 promptFragment。
 *   - identity              人格底色（结构化）
 *   - characterState        实时态（mood + 关系 + 精力，复用 buildRelationshipStatePayload）
 *   - emotion               增强的情绪 payload（含 suppressed / trend24h / unresolvedTopic）
 *   - relationshipDynamics  12 维多维动力学 + 6 个事件时间戳
 *   - promptFragment        拼好的 system prompt 段落（identity + state + dynamics narrative）
 *
 * 与 /tool/memory-context 的区分：
 *   memory-context 关心"这条 query 要带哪些 memory"
 *   character/context 关心"这个角色此刻是谁、和用户处于什么关系"
 *   两者并行调用：memory 给具体事实，context 给人格 + 关系叙事
 *
 * 老路径（/relationship/state、/character/bootstrap）暂不下线，给 client 一个 release 的迁移窗口。
 */
/**
 * Identity CRUD (T-CC-07)
 *
 * GET  /api/character/identity?assistantId=
 * POST /api/character/identity/upsert  body={ assistantId, ...fields }
 * GET  /api/character/identity/vocab    返回所有受控词表（供 admin UI）
 *
 * 校验：upsertIdentity 内部用 identityVocab.validate*，非法字段抛错 → 400。
 */
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
 *
 * extract 端点拿到 preview 后，admin UI 让用户 review/修改 identity + lore，
 * 然后分别调 /api/character/identity/upsert 和本端点保存 lore。
 *
 * @body { assistantId: string, lore: string }
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

/**
 * Phase 2: narrative episodes + persistent topics (T-CC2-07)
 *
 * GET  /api/character/episodes?assistantId=&limit=&minImportance=
 * GET  /api/character/episodes/:id
 * POST /api/admin/character/build-episodes  body={ assistantId } 手动触发 LLM 构建
 *
 * GET  /api/character/topics?assistantId=&status=&limit=
 * POST /api/character/topics/upsert      body={ assistantId, topic, ... } 创建（admin / 手工）
 * POST /api/character/topics/:id/status  body={ status } 状态转换
 * POST /api/character/topics/:id/importance body={ importance }
 */
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
 * 用途：单条 episode 详情（含原始 memory link）。未来 admin episode 详情页或客户端
 * "查看完整叙事段"功能会用上。
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
 * 用途：手动创建 topic。未来 admin UI "手工标注话题" 或运营干预场景会用。
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
 * @dormant 暂未使用 — topic 状态机（active/dormant/closed/...）目前由内部服务推进，
 * 未暴露 admin UI 手动转换入口。未来 admin 需要"强制 close 一个话题"会用。
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
 * Phase 3: relationship reflection (T-CC3-05)
 *
 * GET  /api/character/reflection?assistantId=  最新一条
 * GET  /api/character/reflections?assistantId=&type=&limit=  时间线（多条）
 * POST /api/admin/character/reflect  body={ assistantId, reflectionType?, triggerReason? }
 */
/**
 * GET /api/character/reflection?assistantId=
 *
 * @dormant 暂未使用 — admin UI 用复数版 /character/reflections（时间线）。
 * 用途：取最新一条 reflection。未来如果客户端需要"快速读最近一次反思摘要"会用。
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

/**
 * Phase 4: behavior planner intent (T-CC4-03)
 * GET /api/character/behavior-intent?assistantId=        当前主推荐意图（debug / admin）
 * GET /api/character/behavior-intent/vocab               14 个 intent 定义
 * GET /api/character/attention-1h?assistantId=           1h 滚动注意力（debug / admin / chat hot path 共用同一缓存）
 *
 * 2026-05-10: behavior-intent 改 async — 内部 await buildAttention1h，让启发式 intent 评估
 *   能用上 LLM 提炼的现场感（abandonment_focus / unresolved_topic_in_attention 等）。
 *   传 ?withAttention=0 可跳过 attention 入参（保持原启发式行为，便于对比）。
 */
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

/**
 * POST /api/character/topics/:id/importance
 *
 * @dormant 暂未使用 — importance 由内部信号自动调，未暴露 admin 手动调整。
 * 用途：手工调整 topic 重要度（0-1）。未来运营干预或 admin 调试场景会用。
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
 * POST /api/character/context — 角色认知层 inspect 端点（admin / debug 用）。
 *
 * 客户端 chat hot path 不再使用此端点 —— 走 /api/chat/context（含 facts /
 * narrative / prefill / tool_protocol slots）。本端点保留给 admin UI 和 debug
 * 工具看 7 层认知态全貌（identity / characterState / dynamics / emotion /
 * socialMode / activeTopics / recentEpisodes / latestReflection / salientPhrase）
 * + 渲染好的 V_NEW_LEAN slots + assistantPrefill。
 *
 * Phase 2 cleanup：移除旧字段 system / userPrefix / promptFragment，外部统一用
 * slots（结构化）+ assistantPrefill（独白片段）。
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

// /api/character/bootstrap 已于 Phase 2 cleanup 删除（决策点：仅 dev 客户端，无兼容包袱）。
// 客户端走 GET /api/character/{id}（合并 profile + identity + 静态 slots + etag）。

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

// ─────────────────────────── Knowledge base endpoints ──────────────────────
//
// @dormant 整组暂未使用 — knowledge 写入路径（手动 + AI 主动）都未启用。
//
// memory_type='knowledge' 的条目独立于对话流，设计上：AI 可主动 add（值得长期保留的事实），
// 用户/管理员也可手动维护（角色设定、世界观、长期偏好等）；检索通过 memory-recall 加
// source='knowledge' / kbName='xxx' 过滤。但当前 admin UI 没做 knowledge 编辑页，
// AI 也没启用 knowledge-add tool，所以四个端点 (upsert/list/bases/tool-knowledge-add)
// 全部 dormant。未来知识库功能上线时直接复用，schema 保持稳定。
//

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
