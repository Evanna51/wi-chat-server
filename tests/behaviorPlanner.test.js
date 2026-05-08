/**
 * behaviorPlanner.test.js — Phase 4 (CC-4) 测试套件
 *
 * 覆盖 14 个 intent 的触发条件 + 边界（silenceHours=0 → none / 极短窗口）+ 优先级竞争。
 */

const { db } = require("../src/db");
const cs = require("../src/services/characterStateService");
const idsvc = require("../src/services/character/identityService");
const dyn = require("../src/services/character/relationshipDynamicsService");
const ps = require("../src/services/character/persistentTopicService");
const ref = require("../src/services/character/reflectionService");
const bp = require("../src/services/character/behaviorPlanner");

let passed = 0;
let failed = 0;
const TS = `t_b_${Date.now()}_${process.pid}`;

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

function makeAid(suffix) { return `${TS}_${suffix}`; }

function setupAssistant(aid, identityFields = {}) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO assistant_profile (assistant_id, character_name, character_background, allow_auto_life, allow_proactive_message, assistant_type, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?)"
  ).run(aid, aid, "", "character", now, now);
  cs.ensureDefaultState(aid);
  idsvc.ensureDefaultIdentity(aid);
  if (Object.keys(identityFields).length) idsvc.upsertIdentity(aid, identityFields);
  dyn.ensureRelationshipState(aid);
}

function setSilenceHours(aid, hours) {
  const ts = Date.now() - hours * 3600 * 1000;
  db.prepare("UPDATE character_state SET last_user_message_at = ? WHERE assistant_id = ?").run(ts, aid);
}

function setDynamics(aid, fields) {
  const setSql = Object.keys(fields).map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE relationship_state SET ${setSql} WHERE assistant_id = @aid`).run({ ...fields, aid });
}

function cleanupAll() {
  db.prepare("DELETE FROM relationship_event WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM relationship_reflection WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM relationship_state WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM persistent_topic WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM character_identity WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM character_state WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM assistant_profile WHERE assistant_id LIKE ?").run(`${TS}_%`);
}

// ── Suite 1: 高优先级触发 ───────────────────────────────────────
console.log("\n[Suite 1] high-priority intents");
{
  // reassure_after_conflict (priority 100)
  const aid1 = makeAid("conflict");
  setupAssistant(aid1);
  setSilenceHours(aid1, 24);
  setDynamics(aid1, { unresolved_conflict: 0.6, abandonment_fear: 0.3 });
  const r1 = bp.evaluate(aid1);
  assert(r1.intent === "reassure_after_conflict", `unresolved=0.6 → ${r1.intent}`);
  assert(r1.urgency === "high", "high urgency");
  assert(r1.suggestedSocialMode === "reassuring", "suggested mode = reassuring");

  // reassure_abandonment_fear (priority 95)
  const aid2 = makeAid("abandonment");
  setupAssistant(aid2);
  setSilenceHours(aid2, 24);
  setDynamics(aid2, { abandonment_fear: 0.7, unresolved_conflict: 0.1 });
  const r2 = bp.evaluate(aid2);
  assert(r2.intent === "reassure_abandonment_fear", `aFear=0.7 → ${r2.intent}`);

  // pursue_reflection_opportunity (priority 85)
  const aid3 = makeAid("reflect_opp");
  setupAssistant(aid3);
  setSilenceHours(aid3, 24);
  ref.insertReflection({
    assistantId: aid3,
    reflectionType: "manual",
    summary: "test",
    emotionalTrend: "stable",
    relationshipDirection: "stable",
    userNeeds: [],
    concerns: [],
    opportunities: ["下周比赛是主动祝福的好时机"],
    sourceData: {},
    windowStart: Date.now() - 7 * 24 * 3600 * 1000,
    windowEnd: Date.now(),
  });
  const r3 = bp.evaluate(aid3);
  assert(r3.intent === "pursue_reflection_opportunity", `reflection.opp → ${r3.intent}`);
  assert(/下周比赛/.test(r3.contentHint), "opportunity in contentHint");
}

// ── Suite 2: 中等优先级 ────────────────────────────────────────
console.log("\n[Suite 2] medium-priority intents");
{
  // reciprocate_vulnerable_share (priority 80)
  const aid = makeAid("vshare");
  setupAssistant(aid);
  setSilenceHours(aid, 24);
  const now = Date.now();
  setDynamics(aid, { last_vulnerable_share_at: now - 6 * 3600 * 1000 });
  const r = bp.evaluate(aid);
  assert(r.intent === "reciprocate_vulnerable_share", `recent vshare → ${r.intent}`);
  assert(r.suggestedSocialMode === "caretaker", "caretaker mode");

  // confess_suppressed_feeling (priority 70)
  const aid2 = makeAid("confess");
  setupAssistant(aid2);
  setSilenceHours(aid2, 24);
  db.prepare("UPDATE character_state SET suppressed_emotion = ?, suppressed_emotion_intensity = ? WHERE assistant_id = ?")
    .run("sad", 0.5, aid2);
  const r2 = bp.evaluate(aid2);
  assert(r2.intent === "confess_suppressed_feeling", `suppressed → ${r2.intent}`);
  assert(r2.suggestedSocialMode === "confessional", "confessional mode");

  // follow_up_unresolved_topic (priority 75)
  const aid3 = makeAid("topic_unresolved");
  setupAssistant(aid3);
  setSilenceHours(aid3, 24);
  const oldTs = Date.now() - 10 * 24 * 3600 * 1000;
  ps.createTopic(aid3, { topic: "母亲关系", aliases: ["妈"], status: "unresolved", importance: 0.7 });
  db.prepare("UPDATE persistent_topic SET last_discussed_at = ? WHERE assistant_id = ?").run(oldTs, aid3);
  const r3 = bp.evaluate(aid3);
  assert(r3.intent === "follow_up_unresolved_topic", `10d-old unresolved topic → ${r3.intent}`);
}

// ── Suite 3: 低优先级 + 兜底 ──────────────────────────────────
console.log("\n[Suite 3] low-priority + life check");
{
  const aid = makeAid("share_topic");
  setupAssistant(aid);
  setSilenceHours(aid, 24);
  ps.createTopic(aid, { topic: "钢琴学习", aliases: ["钢琴"], status: "growing", importance: 0.6 });
  db.prepare("UPDATE persistent_topic SET last_discussed_at = ? WHERE assistant_id = ?")
    .run(Date.now() - 4 * 24 * 3600 * 1000, aid);
  const r = bp.evaluate(aid);
  assert(r.intent === "share_topic_progress", `growing topic 4d → ${r.intent}`);

  // life_check_in 兜底
  const aid2 = makeAid("life");
  setupAssistant(aid2);
  setSilenceHours(aid2, 12);
  const r2 = bp.evaluate(aid2);
  assert(r2.intent === "life_check_in", `12h silence + 无信号 → ${r2.intent}`);

  // playful_check_in
  const aid3 = makeAid("playful");
  setupAssistant(aid3, {
    personalityTraits: ["playful_teasing"],
    socialStrategyDefault: "teasing",
  });
  setSilenceHours(aid3, 12);
  setDynamics(aid3, { emotional_closeness: 0.7 });
  db.prepare("UPDATE character_state SET mood_valence = 0.5 WHERE assistant_id = ?").run(aid3);
  const r3 = bp.evaluate(aid3);
  assert(r3.intent === "playful_check_in", `playful_teasing + valence>0.2 → ${r3.intent}`);
  assert(r3.suggestedSocialMode === "teasing", "teasing mode");
}

// ── Suite 4: none / 边界 ──────────────────────────────────────
console.log("\n[Suite 4] none / edge cases");
{
  // 用户半小时内刚发过 → none
  const aid = makeAid("recent_user");
  setupAssistant(aid);
  setSilenceHours(aid, 0.2); // 12 分钟前
  const r = bp.evaluate(aid);
  assert(r.intent === "none", `silenceHours=0.2 → none (${r.intent})`);
  assert(/刚说过话/.test(r.contentHint), "contentHint mentions recent user activity");

  // 没 character_state → null
  const aidMissing = `${TS}_no_state`;
  const r2 = bp.evaluate(aidMissing);
  assert(r2 === null, "no character_state → null");

  // buildIntentPromptFragment for non-none
  const fragNone = bp.buildIntentPromptFragment({ intent: "none" });
  assert(fragNone === "", "none intent → empty fragment");

  const aid3 = makeAid("frag");
  setupAssistant(aid3);
  setSilenceHours(aid3, 24);
  setDynamics(aid3, { abandonment_fear: 0.7 });
  const r3 = bp.evaluate(aid3);
  const frag = bp.buildIntentPromptFragment(r3);
  assert(/\[这次主动发消息的意图\]/.test(frag), "fragment header");
  assert(frag.includes(r3.intent), "fragment includes intent name");
  assert(/建议姿态/.test(frag), "suggested mode in fragment");
  assert(/紧迫度/.test(frag), "urgency in fragment");
}

// ── Suite 5: 优先级竞争 ───────────────────────────────────────
console.log("\n[Suite 5] priority competition");
{
  // 同时满足多个：unresolved (100) + vshare (80) + suppressed (70) → 应该选 100
  const aid = makeAid("multi");
  setupAssistant(aid);
  setSilenceHours(aid, 24);
  const now = Date.now();
  setDynamics(aid, {
    unresolved_conflict: 0.7,
    last_vulnerable_share_at: now - 6 * 3600 * 1000,
    abandonment_fear: 0.7,
  });
  db.prepare("UPDATE character_state SET suppressed_emotion = ?, suppressed_emotion_intensity = 0.5 WHERE assistant_id = ?")
    .run("sad", aid);
  const r = bp.evaluate(aid);
  assert(r.intent === "reassure_after_conflict", `top priority wins (got ${r.intent})`);
  assert(r.scores.reassure_after_conflict === 100, "score = 100");
  assert(r.scores.reassure_abandonment_fear === 95, "competing intents also scored");
  assert(r.scores.reciprocate_vulnerable_share === 80, "vshare scored");
}

cleanupAll();
console.log("\n──────────────────────────────────────────────────");
console.log(`结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
