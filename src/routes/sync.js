const express = require("express");
const { z } = require("zod");
const { upsertAssistantProfile } = require("../db");
const { ingestTurnsBatch } = require("../services/syncIngestService");
const { turnEvents } = require("../events/turnEvents");
const config = require("../config");

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

const pushSchema = z.object({
  deviceId: z.string().min(1),
  turns: z
    .array(
      z.object({
        id: z.string().min(1),
        assistantId: z.string().min(1),
        sessionId: z.string().min(1),
        // 5 种 role：
        //   user / assistant       —— 语义对话，进 memory pipeline
        //   tool_call / tool_result —— 工具调用日志（OpenAI 风格）
        //   system                 —— 系统/审计事件
        // 后三种仅写 conversation_turns，不进 memory_items / 不索引 / 不分类
        role: z.enum(["user", "assistant", "tool_call", "tool_result", "system"]),
        // semantic role 业务层强制非空；tool_call 行 content 通常为 ""，
        // 故此处只做 string 类型校验，长度按 role 在 syncIngestService 里判断
        content: z.string(),
        createdAt: z.number().int().min(0),
        // tool_call 行的 OpenAI 风格 tool_calls 数组 JSON
        toolCallsJson: z.string().optional(),
        // tool_result 行：指向触发它的 assistant tool_call id + 被调用的 tool 名
        toolCallId: z.string().optional(),
        toolName: z.string().optional(),
      })
    )
    .min(1)
    .max(200),
});

/**
 * 给每个有 user-role turn 的 assistant 发一条 'turn.user.batch' 事件。
 * 订阅者（src/subscribers/）异步处理 cancel pending plans / character_state /
 * scheduleNextPushPlan。emit 是 sync 调用，但每个 subscriber 自己 setImmediate
 * 长任务，不阻塞 HTTP 响应。
 */
function emitUserBatchEvents(perAssistantStats, { cause, userId = null } = {}) {
  for (const [assistantId, stats] of perAssistantStats) {
    if (!assistantId || stats.userTurnCount <= 0) continue;
    turnEvents.emitUserBatch({
      assistantId,
      userId,
      cause,
      stats: {
        userTurnCount: stats.userTurnCount,
        lastUserAt: stats.lastUserAt,
        lastUserContent: stats.lastUserContent,
      },
    });
  }
}

router.post("/push", authMiddleware, (req, res) => {
  // Phase 2: 标 deprecated（语义重命名）。新客户端走 POST /api/chat/turn
  // —— 行为完全一致（内部都调 ingestTurnsBatch），只是命名按"客户端在做什么"。
  res.setHeader("Deprecation", "true");
  res.setHeader("Link", '</api/chat/turn>; rel="successor-version"');

  const parsed = pushSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const { deviceId, turns } = parsed.data;
  try {
    const result = ingestTurnsBatch({ deviceId, turns });
    emitUserBatchEvents(result.perAssistantStats, { cause: "sync.push" });
    return res.json({
      ok: true,
      deviceId,
      accepted: result.accepted,
      skipped: result.skipped,
      rejected: result.rejected,
      details: result.details,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

/**
 * 一次性同步 assistants + turns 的"快照式" endpoint。
 *
 * 设计语义：
 * - assistants[] 走 phone-wins INSERT-OR-REPLACE 语义（characterName / background /
 *   allowAutoLife / allowProactiveMessage 一律以 phone 端值为准）
 * - turns[] 复用 sync-push 全部校验和入库逻辑（含 5 种 role + tool 字段 + 幂等）
 * - 单事务内：assistants 先 upsert，再 turns 入库；任何一步失败整体 500
 * - 对 assistants 中**包含的**且本次有 user-role turn 的 assistantId 触发 character_state
 *   更新（依然只对有 profile 的 assistant 生效，但本接口刚好把 profile upsert 了）
 *
 * 用途：phone 端 daily sync 时一次推完所有角色 + 对话，让 server 端 UI 看到角色卡片
 */
const snapshotSchema = z.object({
  deviceId: z.string().min(1),
  assistants: z
    .array(
      z.object({
        assistantId: z.string().min(1),
        characterName: z.string().min(1),
        characterBackground: z.string().optional(),
        allowAutoLife: z.boolean().optional(),
        allowProactiveMessage: z.boolean().optional(),
        // 角色类型（与 chatbox-Android `MyAssistant.type` 对齐）：
        //   "character" 人物型陪伴 / "writer" 写作助手 / "default" 通用 / 其它自定义
        // 不传 → server 保留旧值；UI 用此字段决定是否显示自驱 / 主动消息开关
        type: z.string().optional(),
      })
    )
    .max(500)
    .optional(),
  turns: z
    .array(
      z.object({
        id: z.string().min(1),
        assistantId: z.string().min(1),
        sessionId: z.string().min(1),
        role: z.enum(["user", "assistant", "tool_call", "tool_result", "system"]),
        content: z.string(),
        createdAt: z.number().int().min(0),
        toolCallsJson: z.string().optional(),
        toolCallId: z.string().optional(),
        toolName: z.string().optional(),
      })
    )
    .max(200)
    .optional(),
});

router.post("/snapshot", authMiddleware, (req, res) => {
  const parsed = snapshotSchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const { deviceId, assistants = [], turns = [] } = parsed.data;
  if (assistants.length === 0 && turns.length === 0) {
    return res.status(400).json({ ok: false, error: "empty_snapshot" });
  }

  try {
    // 1. assistants upsert（phone-wins）
    const profileResults = [];
    for (const a of assistants) {
      try {
        const saved = upsertAssistantProfile({
          assistantId: a.assistantId,
          characterName: a.characterName,
          characterBackground: a.characterBackground || "",
          allowAutoLife: a.allowAutoLife === true,
          allowProactiveMessage: a.allowProactiveMessage === true,
          assistantType: a.type, // undefined → 保留旧值
        });
        profileResults.push({
          assistantId: a.assistantId,
          status: "upserted",
          characterName: saved?.character_name || null,
        });
      } catch (e) {
        profileResults.push({
          assistantId: a.assistantId,
          status: "failed",
          reason: String(e?.message || e),
        });
      }
    }

    // 2. turns 入库（复用 sync-push 全套校验 + 幂等）
    let turnResult = {
      accepted: 0,
      skipped: 0,
      rejected: 0,
      details: [],
      perAssistantStats: new Map(),
    };
    if (turns.length > 0) {
      turnResult = ingestTurnsBatch({ deviceId, turns });
    }

    // 3. 发事件，订阅者处理 cancel / state / next_push
    emitUserBatchEvents(turnResult.perAssistantStats, { cause: "sync.snapshot" });

    return res.json({
      ok: true,
      deviceId,
      assistants: {
        received: assistants.length,
        upserted: profileResults.filter((r) => r.status === "upserted").length,
        failed: profileResults.filter((r) => r.status === "failed").length,
        details: profileResults,
      },
      turns: {
        received: turns.length,
        accepted: turnResult.accepted,
        skipped: turnResult.skipped,
        rejected: turnResult.rejected,
        details: turnResult.details,
      },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

const stateSchema = z.object({
  assistantId: z.string().trim().min(1).optional(),
  deviceId: z.string().trim().min(1).optional(),
});

router.get("/state", authMiddleware, (req, res) => {
  const parsed = stateSchema.safeParse(req.query || {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: parsed.error.message });
  }
  const { assistantId, deviceId } = parsed.data;
  const now = Date.now();
  try {
    const totalRow = db
      .prepare("SELECT COUNT(1) AS c FROM conversation_turns")
      .get();
    let assistantTurnCount = null;
    let lastTurnAt = null;
    if (assistantId) {
      const ar = db
        .prepare("SELECT COUNT(1) AS c FROM conversation_turns WHERE assistant_id = ?")
        .get(assistantId);
      assistantTurnCount = ar?.c || 0;
      const lastRow = db
        .prepare(
          "SELECT MAX(created_at) AS m FROM conversation_turns WHERE assistant_id = ?"
        )
        .get(assistantId);
      lastTurnAt = lastRow?.m || null;
    } else {
      const lastRow = db
        .prepare("SELECT MAX(created_at) AS m FROM conversation_turns")
        .get();
      lastTurnAt = lastRow?.m || null;
    }
    return res.json({
      ok: true,
      now,
      assistantId: assistantId || null,
      deviceId: deviceId || null,
      assistantTurnCount,
      totalTurnCount: totalRow?.c || 0,
      lastTurnAt,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

module.exports = router;
