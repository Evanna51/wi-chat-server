/**
 * 角色状态机单测
 * 用法: node tests/characterState.test.js
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
const { TAXONOMY, resolveEmotion } = require("../src/services/emotionTaxonomy");

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

function makeAid(suffix) { return `${TS}_${suffix}`; }

function injectState(assistantId, fields) {
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
  ensureDefaultState(aid, { familiarityHint: 36 });
  const s = getRawState(aid);
  assert(s !== null, "row exists");
  assert(s.relationship_level === 3, `level from familiarity 36 = 3 (got ${s.relationship_level})`);
  assert(s.mood_emotion === "calm", `default emotion = calm (got ${s.mood_emotion})`);
  assert(s.mood_updated_at > 0, "mood_updated_at set");
}

// ── Suite 2: onUserMessage — heuristic two-tier signals ───────────────────────
console.log("\n[Suite 2] onUserMessage heuristics (two-tier)");
{
  const aid = makeAid("heuristic");
  ensureDefaultState(aid);
  const before = getRawState(aid);

  // Tier-1: deep share + Tier-2: 感谢 → touched
  onUserMessage(aid, { content: "其实最近压力很大，只有你知道这件事，感谢你一直陪着我", now: Date.now() });
  const afterDeep = getRawState(aid);
  assert(afterDeep.intimacy_score > before.intimacy_score, "deep-share → intimacy up");
  assert(afterDeep.mood_emotion === "touched", `deep-share + 感谢 → touched (got ${afterDeep.mood_emotion})`);

  // Tier-1: negative + Tier-2: default → disappointed
  onUserMessage(aid, { content: "算了，不聊了，bye", now: Date.now() + 1000 });
  const afterNeg = getRawState(aid);
  assert(afterNeg.mood_emotion === "disappointed", `negative signal → disappointed (got ${afterNeg.mood_emotion})`);
}

// ── Suite 3: silence detection — 7d → lonely + level decay ───────────────────
console.log("\n[Suite 3] silence detection");
{
  const aid = makeAid("silence");
  ensureDefaultState(aid, { familiarityHint: 60 });
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000 - 1000;
  injectState(aid, {
    last_user_message_at: sevenDaysAgo,
    relationship_level: 5,
    mood_emotion: "calm",
    mood_intensity: 0.3,
  });
  onUserMessage(aid, { content: "hi", now: Date.now() });
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
  injectState(aid, {
    mood_emotion: "angry",
    mood_valence: -0.70,
    mood_arousal:  0.85,
    mood_intensity: 0.9,
    mood_updated_at: now - 24 * 60 * 60 * 1000,
  });
  const effective = getEffectiveState(aid, now);
  assert(effective.mood_valence > -0.70, `valence decayed towards baseline (${effective.mood_valence.toFixed(3)} > -0.7)`);
  assert(effective.mood_intensity < 0.9, `intensity decayed (${effective.mood_intensity.toFixed(3)} < 0.9)`);
}

// ── Suite 5: relationship level from intimacy score ───────────────────────────
console.log("\n[Suite 5] relationship level from score");
{
  const aid = makeAid("levels");
  ensureDefaultState(aid);
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

// ── Suite 6: buildStatePromptFragment — zh/en format ─────────────────────────
console.log("\n[Suite 6] buildStatePromptFragment");
{
  const aid = makeAid("prompt");
  ensureDefaultState(aid);
  injectState(aid, {
    mood_emotion: "cheerful",
    mood_intensity: 0.7,
    mood_valence: 0.65,
    mood_arousal: 0.55,
    relationship_level: 4,
    energy: 0.8,
    mood_updated_at: Date.now(),
    focus_topic: "工作压力",
    focus_depth: 2,
  });
  const fragment = buildStatePromptFragment(aid);
  assert(fragment.includes("[角色当前状态]"), "fragment has header");
  assert(fragment.includes("cheerful"), "fragment includes emotion en name");
  assert(fragment.includes("愉快"), "fragment includes emotion zh name");
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

// ── Suite 8: extended taxonomy — positive secondary emotions ─────────────────
console.log("\n[Suite 8] extended taxonomy — positive secondary heuristics");
{
  const aid = makeAid("ext_pos");
  ensureDefaultState(aid);

  // 成功 → accomplished
  onUserMessage(aid, { content: "终于做到了！成功了！太棒了", now: Date.now() });
  const s1 = getRawState(aid);
  assert(s1.mood_emotion === "accomplished", `成功 → accomplished (got ${s1.mood_emotion})`);
  assert(s1.mood_valence > 0, `accomplished valence > 0 (got ${s1.mood_valence})`);

  // 谢谢 no deep share → thankful (no "一直/最近" etc.)
  injectState(aid, { mood_emotion: "calm", mood_intensity: 0.3 });
  onUserMessage(aid, { content: "谢谢你！感谢你帮了我好多忙！", now: Date.now() + 100 });
  const s2 = getRawState(aid);
  assert(s2.mood_emotion === "thankful", `感谢 no deep-share → thankful (got ${s2.mood_emotion})`);

  // 哈哈哈！！ → elated
  injectState(aid, { mood_emotion: "calm", mood_intensity: 0.3 });
  onUserMessage(aid, { content: "哈哈哈真的太好了！！！开心开心", now: Date.now() + 200 });
  const s3 = getRawState(aid);
  assert(s3.mood_emotion === "elated", `哈哈+!! → elated (got ${s3.mood_emotion})`);
}

// ── Suite 9: extended taxonomy — negative secondary emotions ─────────────────
console.log("\n[Suite 9] extended taxonomy — negative secondary heuristics");
{
  const aid = makeAid("ext_neg");
  ensureDefaultState(aid);

  // 孤独 → lonely (negative signal tier-2: 孤独)
  onUserMessage(aid, { content: "今晚好孤独，没人陪我", now: Date.now() });
  const s1 = getRawState(aid);
  assert(s1.mood_emotion === "lonely", `孤独 → lonely (got ${s1.mood_emotion})`);
  assert(s1.mood_valence < 0, `lonely valence < 0 (got ${s1.mood_valence})`);

  // 难过/悲伤 → sad  (negative signal beats deep-share)
  injectState(aid, { mood_emotion: "calm", mood_intensity: 0.3 });
  onUserMessage(aid, { content: "好难过，真的很悲伤，心情差透了", now: Date.now() + 100 });
  const s2 = getRawState(aid);
  assert(s2.mood_emotion === "sad", `难过+悲伤 → sad (got ${s2.mood_emotion})`);

  // 生气/心烦 → frustrated
  injectState(aid, { mood_emotion: "calm", mood_intensity: 0.3 });
  onUserMessage(aid, { content: "烦死了，生气！算了", now: Date.now() + 200 });
  const s3 = getRawState(aid);
  assert(s3.mood_emotion === "frustrated", `生气/烦死 → frustrated (got ${s3.mood_emotion})`);
}

// ── Suite 10: extended taxonomy — deep share secondary emotions ───────────────
console.log("\n[Suite 10] extended taxonomy — deep share refinement");
{
  const aid = makeAid("ext_deep");
  ensureDefaultState(aid);

  // 想你 + deep share → longing
  onUserMessage(aid, { content: "最近一直在想你，很想你", now: Date.now() });
  const s1 = getRawState(aid);
  assert(s1.mood_emotion === "longing", `想你 deep-share → longing (got ${s1.mood_emotion})`);
  assert(s1.mood_valence > 0, `longing valence > 0 (got ${s1.mood_valence})`);

  // 担心 + deep share → worried
  injectState(aid, { mood_emotion: "calm", mood_intensity: 0.3 });
  onUserMessage(aid, { content: "有点担心你，最近感觉你压力很大", now: Date.now() + 100 });
  const s2 = getRawState(aid);
  assert(s2.mood_emotion === "worried", `担心 deep-share → worried (got ${s2.mood_emotion})`);
}

// ── Suite 11: taxonomy integrity ──────────────────────────────────────────────
console.log("\n[Suite 11] taxonomy integrity");
{
  const base      = TAXONOMY.filter((e) => !e.parent);
  const secondary = TAXONOMY.filter((e) => !!e.parent);
  assert(base.length === 27, `27 base emotions (got ${base.length})`);
  assert(secondary.length >= 90, `≥90 secondary emotions (got ${secondary.length})`);
  assert(TAXONOMY.length >= 117 && TAXONOMY.length <= 130, `total 117–130 (got ${TAXONOMY.length})`);

  // Every secondary has a valid parent
  const allIds = new Set(TAXONOMY.map((e) => e.id));
  const orphans = secondary.filter((e) => !allIds.has(e.parent));
  assert(orphans.length === 0, `no orphaned secondaries (found ${orphans.length})`);

  // resolveEmotion fallback
  const fallback = resolveEmotion("nonexistent_emotion_xyz");
  assert(fallback.id === "neutral", `unknown id falls back to neutral (got ${fallback.id})`);

  // All emotions have valid valence/arousal ranges
  const outOfRange = TAXONOMY.filter(
    (e) => e.valence < -1 || e.valence > 1 || e.arousal < 0 || e.arousal > 1
  );
  assert(outOfRange.length === 0, `all emotions in valid valence/arousal range`);
}

// ── Cleanup & summary ─────────────────────────────────────────────────────────
cleanup();
console.log(`\n${"─".repeat(50)}`);
console.log(`结果: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
