const {
  db,
  insertConversationTurn,
  insertMemoryItem,
  insertOutboxEvent,
  findConversationTurnById,
  findConversationTurnByLogicalKey,
  findMemoryItemBySourceTurnId,
} = require("../db");
const { ingestInteraction, SEMANTIC_ROLES } = require("./memoryIngestService");
const { deleteConversationTurnCascade } = require("./memoryEditService");
const { classifyAndPersist } = require("./memoryClassificationService");

const MIN_VALID_TS = Date.parse("2020-01-01T00:00:00Z"); // 1577836800000
const FUTURE_TOLERANCE_MS = 86_400_000; // now + 1 天

// 接受 5 种 role：
//   user / assistant       —— 进 memory pipeline
//   tool_call / tool_result / system —— 仅写 conversation_turns，日志型
const VALID_ROLES = new Set(["user", "assistant", "tool_call", "tool_result", "system"]);

/**
 * 批量幂等写入 phone 离线缓存的 turns。
 *
 * 行为：
 * - 入参 turns 已经在路由层做过 zod 校验，这里只补充语义/时序/sanity 校验
 * - 单事务内对每条做 try/catch，单条失败不影响整批 commit
 * - 时间戳异常（< 2020-01-01 或 > now+1d）会被矫正为 Date.now()，details 里 reason: "clock_corrected"
 *   依然算 accepted（数据落库），只是带备注
 * - 同 id 重复推送：第二次起 ingestInteraction 内部 SELECT-then-skip，记 skipped
 * - 内层抛错：catch 后写入 rejected，错误信息进 reason
 *
 * 返回：{ accepted, skipped, rejected, details: [{ id, status, reason? }] }
 */
function ingestTurnsBatch({ deviceId, turns }) {
  const details = [];
  let accepted = 0;
  let skipped = 0;
  let rejected = 0;
  // 给路由层用：本批次每个 assistantId 接受的 user-role turn 数 / 最新一条 user 内容 + 时间。
  // 路由层据此决定是否触发 character_state 更新（仅对有 profile 的 assistant）。
  const perAssistant = new Map();
  // 收集本批次新生成的 user-turn memory，事务 commit 后 setImmediate 异步触发分类 + 抽事实
  const newUserMemories = [];

  // 按 createdAt ASC 排序，让 memory_edges 时序正确
  const sorted = [...turns].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const nowMs = Date.now();

  const tx = db.transaction((arr) => {
    for (const turn of arr) {
      try {
        // 业务层 sanity check（zod 已经卡了基本结构）
        if (!turn || typeof turn !== "object") {
          rejected += 1;
          details.push({ id: String(turn?.id || ""), status: "rejected", reason: "invalid_turn" });
          continue;
        }
        if (!VALID_ROLES.has(turn.role)) {
          rejected += 1;
          details.push({ id: turn.id, status: "rejected", reason: `invalid_role:${turn.role}` });
          continue;
        }
        if (typeof turn.content !== "string") {
          rejected += 1;
          details.push({ id: turn.id, status: "rejected", reason: "content_not_string" });
          continue;
        }
        // semantic role 必须有内容；log-only role (tool_call / tool_result / system) 允许空
        if (SEMANTIC_ROLES.has(turn.role) && turn.content.length === 0) {
          rejected += 1;
          details.push({ id: turn.id, status: "rejected", reason: "empty_content" });
          continue;
        }
        // tool_call 必须带 toolCallsJson；tool_result 必须带 toolCallId + toolName
        if (turn.role === "tool_call" && !turn.toolCallsJson) {
          rejected += 1;
          details.push({ id: turn.id, status: "rejected", reason: "tool_call_missing_payload" });
          continue;
        }
        if (turn.role === "tool_result" && (!turn.toolCallId || !turn.toolName)) {
          rejected += 1;
          details.push({ id: turn.id, status: "rejected", reason: "tool_result_missing_metadata" });
          continue;
        }

        let createdAt = Number(turn.createdAt);
        const reasons = [];
        if (
          !Number.isFinite(createdAt) ||
          createdAt < MIN_VALID_TS ||
          createdAt > nowMs + FUTURE_TOLERANCE_MS
        ) {
          createdAt = Date.now();
          reasons.push("clock_corrected");
        }

        // 1. 同 turnId 命中已存在 → skipped（最快路径）
        const existingTurn = findConversationTurnById(turn.id);
        if (existingTurn) {
          skipped += 1;
          const detail = { id: turn.id, status: "skipped", reason: "already_exists" };
          if (reasons.length) detail.reason = `${detail.reason};${reasons.join(",")}`;
          details.push(detail);
          continue;
        }

        // 2. 逻辑去重：客户端可能给同一条消息生成不同 turnId（重新安装、缓存丢失等场景），
        //    用 (assistantId, sessionId, role, createdAt) 做逻辑 key 兜底。
        //
        //    分两种情况：
        //    (a) content 完全相同 → 真正的"无意义重复"，skip（保护 server 端通过 memory-correct
        //        修正过的 memory，不让 phone 端旧内容把它再覆盖回去）
        //    (b) content 不同 → 同一时刻同一 role 的不同内容，视为客户端编辑后的新版本，
        //        级联删旧行再以新 id 写入（"后面覆盖前面"）
        const logicalDup = findConversationTurnByLogicalKey({
          assistantId: turn.assistantId,
          sessionId: turn.sessionId,
          role: turn.role,
          createdAt,
        });
        let replacedOldId = null;
        if (logicalDup && logicalDup.id !== turn.id) {
          const existingFull = findConversationTurnById(logicalDup.id);
          const sameContent =
            existingFull &&
            existingFull.content === turn.content &&
            (existingFull.tool_calls_json || null) === (turn.toolCallsJson || null) &&
            (existingFull.tool_call_id || null) === (turn.toolCallId || null) &&
            (existingFull.tool_name || null) === (turn.toolName || null);

          if (sameContent) {
            skipped += 1;
            const detail = {
              id: turn.id,
              status: "skipped",
              reason: `logical_duplicate_of:${logicalDup.id}`,
            };
            if (reasons.length) detail.reason = `${detail.reason};${reasons.join(",")}`;
            details.push(detail);
            continue;
          }

          replacedOldId = logicalDup.id;
          deleteConversationTurnCascade(logicalDup.id);
          reasons.push(`replaced_old:${logicalDup.id}`);
        }

        const result = ingestInteraction({
          db,
          assistantId: turn.assistantId,
          sessionId: turn.sessionId,
          role: turn.role,
          content: turn.content,
          now: createdAt,
          turnId: turn.id,
          toolCallsJson: turn.toolCallsJson || null,
          toolCallId: turn.toolCallId || null,
          toolName: turn.toolName || null,
          insertConversationTurn,
          insertMemoryItem,
          insertOutboxEvent,
          findMemoryItemBySourceTurnId,
        });

        if (result.skipped) {
          // memory_item 已存在但 turn 是新插入（罕见，比如 turn 被人手动清空又重推）
          skipped += 1;
          const detail = { id: turn.id, status: "skipped", reason: "memory_already_exists" };
          if (reasons.length) detail.reason = `${detail.reason};${reasons.join(",")}`;
          details.push(detail);
        } else {
          accepted += 1;
          const status = replacedOldId ? "replaced" : "accepted";
          const detail = { id: turn.id, status };
          if (reasons.length) detail.reason = reasons.join(",");
          details.push(detail);
          // 累计 user-role 统计；只 accepted 的 user 行才计数
          if (turn.role === "user") {
            const stats = perAssistant.get(turn.assistantId) || {
              userTurnCount: 0,
              lastUserContent: null,
              lastUserAt: 0,
            };
            stats.userTurnCount += 1;
            if (createdAt >= stats.lastUserAt) {
              stats.lastUserContent = turn.content;
              stats.lastUserAt = createdAt;
            }
            perAssistant.set(turn.assistantId, stats);
            // 收集 memoryId 给后续异步分类，跳过 logOnly / dedup 路径
            if (result?.memoryId && !result.skipped && !result.logOnly) {
              newUserMemories.push({ memoryId: result.memoryId, content: turn.content });
            }
          }
        }
      } catch (error) {
        rejected += 1;
        details.push({
          id: turn?.id || "",
          status: "rejected",
          reason: String(error && error.message ? error.message : error),
        });
      }
    }
  });

  tx(sorted);

  // 异步触发分类 + 抽事实（每条独立 setImmediate 避免阻塞，单条失败不互相影响）。
  // 串行而非并行，避免本地 LLM endpoint 同时收到 N 个请求。
  if (newUserMemories.length > 0) {
    setImmediate(async () => {
      for (const item of newUserMemories) {
        try {
          await classifyAndPersist(item.memoryId, item.content);
        } catch (e) {
          // non-blocking; cron backfill will retry NULL category rows
        }
      }
    });
  }

  return {
    accepted,
    skipped,
    rejected,
    details,
    deviceId: deviceId || null,
    perAssistantStats: perAssistant,
  };
}

module.exports = { ingestTurnsBatch };
