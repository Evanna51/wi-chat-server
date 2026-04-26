const {
  db,
  insertConversationTurn,
  insertMemoryItem,
  insertOutboxEvent,
  findConversationTurnById,
  findMemoryItemBySourceTurnId,
} = require("../db");
const { ingestInteraction } = require("./memoryIngestService");

const MIN_VALID_TS = Date.parse("2020-01-01T00:00:00Z"); // 1577836800000
const FUTURE_TOLERANCE_MS = 86_400_000; // now + 1 天
const VALID_ROLES = new Set(["user", "assistant"]);

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
        if (typeof turn.content !== "string" || turn.content.length === 0) {
          rejected += 1;
          details.push({ id: turn.id, status: "rejected", reason: "empty_content" });
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

        // 命中已存在 → skipped
        const existingTurn = findConversationTurnById(turn.id);
        if (existingTurn) {
          skipped += 1;
          const detail = { id: turn.id, status: "skipped", reason: "already_exists" };
          if (reasons.length) detail.reason = `${detail.reason};${reasons.join(",")}`;
          details.push(detail);
          continue;
        }

        const result = ingestInteraction({
          db,
          assistantId: turn.assistantId,
          sessionId: turn.sessionId,
          role: turn.role,
          content: turn.content,
          now: createdAt,
          turnId: turn.id,
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
          const detail = { id: turn.id, status: "accepted" };
          if (reasons.length) detail.reason = reasons.join(",");
          details.push(detail);
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

  return { accepted, skipped, rejected, details, deviceId: deviceId || null };
}

module.exports = { ingestTurnsBatch };
