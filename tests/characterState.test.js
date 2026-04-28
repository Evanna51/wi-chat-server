/**
 * 角色状态机单测
 * 用法: node tests/characterState.test.js
 *
 * 依赖实际 SQLite DB（以 TEST_ASSISTANT_* 前缀的临时 assistantId，测完清理）。
 */
const { db } = require("../src/db");
const {
  ensureDefaultState,
  getRawState,
  getEffectiveState,
  onUserMessage,
  applyMoodEvent,
  buildStatePromptFragment,
  LEVEL_THRESHOLDS,
} = require("../src/services/characterStateService");

const TS = `test_cs_${Date.now()}`;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

function cleanup() {
  db.prepare("DELETE FROM character_state WHERE assistant_id LIKE 'test_cs_%'").run();
}

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeAid(suffix) {
  return `${TS}_${suffix}`;
}

function injectState(assistantId, fields) {
  const now = Date.now();
  ensureDefaultState(assistantId);
  db.prepare(
    `UPDATE character_state SET ${Object.keys(fields).map((k) => `${k}=@${k}`).join(",")}
     WHERE assistant_id=@_id`
  ).run({ ...fields, _id: assistantId });
}

// ── Suite 1: ensureDefaultState ───────────────────────────────────────────────
console.log("\n[Suite 1] ensureDefaultState");
{
  const aid = makeAid("default");
  ensureDefaultState(aid, { familiarityHint: 36 }); // should be level 3
  const s = getRawState(aid);
  assert(s !== null, "row exists");
  assert(s.relationship_level === 3, `level from familiarity 36 = 3 (got ${s.relationship_level})`);
  assert(s.mood_emotion === "calm", `default emotion = calm (got ${s.mood_emotion})`);
  assert(s.mood_updated_at > 0, "mood_updated_at set");
}

// ── Suite 2: onUserMessage — heuristic signals ────────────────────────────────
console.log("\n[Suite 2] onUserMessage heuristics");
{
  const aid = makeAid("heuristic");
  ensureDefaultState(aid);
  const before = getRawState(aid);

  // Positive long deep-share message
  onUserMessage(aid, { content: "其实最近压力很大，只有你知道这件事，感谢你一直陪着我", now: Date.now() });
  const after = getRawState(aid);
  assert(after.intimacy_score > before.intimacy_score, "positive deep-share → intimacy up");
  assert(after.mood_emotion === "loving", `deep-share → emotion loving (got ${after.mood_emotion})`);

  // Negative cold message
  onUserMessage(aid, { content: "算了，不聊了，bye", now: Date.now() + 1000 });
  const afterNeg = getRawState(aid);
  assert(afterNeg.mood_emotion === "disappointed", `negative signal → disappointed (got ${afterNeg.mood_emotion})`);
}

// ── Suite 3: silence detection — 7d → lonely + level decay ───────────────────
console.log("\n[Suite 3] silence detection");
{
  const aid = makeAid("silence");
  ensureDefaultState(aid, { familiarityHint: 60 }); // level 5
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000 - 1000;
  injectState(aid, {
    last_user_message_at: sevenDaysAgo,
    relationship_level: 5,
    mood_emotion: "calm",
    mood_intensity: 0.3,
  });

  // Simulate a new incoming message after 7d silence
  const now = Date.now();
  onUserMessage(aid, { content: "hi", now });
  const s = getRawState(aid);
  assert(s.mood_emotion === "lonely", `7d silence → mood lonely (got ${s.mood_emotion})`);
  assert(s.relationship_level < 5, `7d silence with level 5 → level decay (got ${s.relationship_level})`);
}

// ── Suite 4: mood decay (time-based) ─────────────────────────────────────────
console.log("\n[Suite 4] mood decay");
{
  const aid = makeAid("decay");
  ensureDefaultState(aid);
  const now = Date.now();
  // Set intense anger 24h ago
  injectState(aid, {
    mood_emotion: "angry",
    mood_valence: -0.7,
    mood_arousal: 0.8,
    mood_intensity: 0.9,
    mood_updated_at: now - 24 * 60 * 60 * 1000,
  });
  const effective = getEffectiveState(aid, now);
  // After 4x half-lives (24h = 4 × 6h), decay factor ≈ 0.0625
  assert(effective.mood_valence > -0.7, `valence decayed towards baseline (${effective.mood_valence.toFixed(3)} > -0.7)`);
  assert(effective.mood_intensity < 0.9, `intensity decayed (${effective.mood_intensity.toFixed(3)} < 0.9)`);
}

// ── Suite 5: relationship level from intimacy score ───────────────────────────
console.log("\n[Suite 5] relationship level from score");
{
  const aid = makeAid("levels");
  ensureDefaultState(aid);
  // Simulate many positive interactions
  for (let i = 0; i < 40; i++) {
    onUserMessage(aid, {
      content: "其实最近感触很深，想和你分享一件重要的事，只有你能理解我。今天发生了很多，感谢你",
      now: Date.now() + i * 1000,
    });
  }
  const s = getRawState(aid);
  assert(s.relationship_level >= 1, `many positive msgs → level ≥ 1 (got ${s.relationship_level})`);
  assert(s.intimacy_score > 0, `intimacy_score > 0 (got ${s.intimacy_score})`);
}

// ── Suite 6: buildStatePromptFragment ────────────────────────────────────────
console.log("\n[Suite 6] buildStatePromptFragment");
{
  const aid = makeAid("prompt");
  ensureDefaultState(aid);
  injectState(aid, {
    mood_emotion: "happy",
    mood_intensity: 0.7,
    mood_valence: 0.6,
    mood_arousal: 0.6,
    relationship_level: 4,
    energy: 0.8,
    mood_updated_at: Date.now(),
    focus_topic: "工作压力",
    focus_depth: 2,
  });
  const fragment = buildStatePromptFragment(aid);
  assert(fragment.includes("[角色当前状态]"), "fragment has header");
  assert(fragment.includes("happy"), "fragment includes emotion");
  assert(fragment.includes("朋友"), "fragment includes relationship name");
  assert(fragment.includes("工作压力"), "fragment includes focus topic");
}

// ── Suite 7: applyMoodEvent ───────────────────────────────────────────────────
console.log("\n[Suite 7] applyMoodEvent");
{
  const aid = makeAid("event");
  ensureDefaultState(aid);
  applyMoodEvent(aid, { emotion: "excited", intensityDelta: 0.4, intimacyDelta: 2.0 });
  const s = getRawState(aid);
  assert(s.mood_emotion === "excited", `applyMoodEvent → excited (got ${s.mood_emotion})`);
  assert(s.mood_valence === 0.8, `excited valence = 0.8 (got ${s.mood_valence})`);
  assert(s.intimacy_score >= 2.0, `intimacy delta applied (got ${s.intimacy_score})`);
}

// ── Cleanup & summary ─────────────────────────────────────────────────────────
cleanup();
console.log(`\n${"─".repeat(50)}`);
console.log(`结果: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
