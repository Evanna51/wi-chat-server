/**
 * personaExtraction subscriber — 监听 'profile.setup_prompt.changed'，
 * 异步用本地 LLM 提炼 setup_prompt → identity + lore，写回 DB。
 *
 * 失败处理：写 extraction_status='failed' + extraction_error，下次 setup_prompt
 * 改动会重试。caller / admin UI 可通过 GET /api/character/extract 同步重试。
 */

const { profileEvents } = require("../events/profileEvents");
const { extractPersona } = require("../services/character/personaExtractor");
const { upsertIdentity } = require("../services/character/identityService");
const { db } = require("../db");

function register() {
  profileEvents.on("profile.setup_prompt.changed", ({ assistantId, setupPrompt, assistantType }) => {
    // writer / general 类不参与提炼
    if (assistantType && assistantType !== "character") return;
    if (!setupPrompt || !setupPrompt.trim()) return;

    setImmediate(async () => {
      const tag = `[personaExtraction] ${assistantId}`;
      try {
        console.log(`${tag} starting extract (setup_prompt=${setupPrompt.length} chars)`);
        const result = await extractPersona(setupPrompt, {
          callOpts: { scopeKey: assistantId },
        });

        if (result.error) {
          console.warn(`${tag} extract error: ${result.error}`);
          db.prepare(
            `UPDATE assistant_profile SET extraction_status = 'failed',
             extraction_error = ?, updated_at = ? WHERE assistant_id = ?`
          ).run(result.error, Date.now(), assistantId);
          return;
        }

        // 1) upsert identity（identityService 内部 validate；失败时降级 lore-only 写）
        let identitySaved = true;
        try {
          if (result.identity && Object.keys(result.identity).length > 0) {
            upsertIdentity(assistantId, result.identity);
          }
        } catch (e) {
          identitySaved = false;
          console.warn(`${tag} upsertIdentity failed: ${e.message}`);
        }

        // 2) 更新 lore + status
        const newStatus = identitySaved ? "ready" : "failed";
        const errMsg = identitySaved ? "" : "identity_save_error";
        db.prepare(
          `UPDATE assistant_profile SET lore = ?, extraction_status = ?,
           extraction_error = ?, extracted_at = ?, updated_at = ?
           WHERE assistant_id = ?`
        ).run(
          result.lore || "",
          newStatus,
          errMsg,
          Date.now(),
          Date.now(),
          assistantId
        );

        console.log(`${tag} extract ${newStatus} (lore=${result.lore?.length || 0} chars, identity_keys=${Object.keys(result.identity || {}).length})`);
      } catch (e) {
        console.error(`${tag} unexpected error:`, e);
        try {
          db.prepare(
            `UPDATE assistant_profile SET extraction_status = 'failed',
             extraction_error = ?, updated_at = ? WHERE assistant_id = ?`
          ).run(String(e.message || e), Date.now(), assistantId);
        } catch (_) {}
      }
    });
  });
}

module.exports = { register };
