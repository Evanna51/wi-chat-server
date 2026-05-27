/**
 * 监听 'turn.user.batch'：更新 character_state（mood / totalTurns）。
 *
 * 之前散落在 routes/sync.js applyStateUpdatesForProfileAssistants 里。
 *
 * 注：仅当该 assistant 有 profile 时才更新（profile 缺失视为非角色 assistant，
 * 不维护情绪态）。
 */
const { db, upsertCharacterState } = require("../db");
const {
  ensureDefaultState,
  onUserMessage: onUserMessageState,
} = require("../services/characterStateService");
const { getAssistantProfile } = require("../db");

function register(turnEvents) {
  turnEvents.on("turn.user.batch", ({ assistantId, stats }) => {
    if (!stats || !stats.userTurnCount) return;
    try {
      const profile = getAssistantProfile(assistantId);
      if (!profile) return;

      ensureDefaultState(assistantId);
      const current = db
        .prepare("SELECT total_turns FROM character_state WHERE assistant_id = ?")
        .get(assistantId);
      const newTotal = (current?.total_turns || 0) + stats.userTurnCount;

      upsertCharacterState(assistantId, {
        total_turns: newTotal,
        last_user_message_at: stats.lastUserAt,
      });

      if (stats.lastUserContent) {
        onUserMessageState(assistantId, {
          content: stats.lastUserContent,
          now: stats.lastUserAt,
        });
      }
    } catch (e) {
      console.error("[subscriber:characterStateUpdater]", assistantId, e.message);
    }
  });
}

module.exports = { register };
