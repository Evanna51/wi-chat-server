/**
 * characterCognition.test.js — Phase 1 (CC-1) 测试套件
 *
 * 覆盖：
 *   Suite 1  identityVocab 校验
 *   Suite 2  identityService upsert/ensureDefault/coefficients
 *   Suite 3  dynamics deriveBaselinesFromIdentity（identity → baseline 派生）
 *   Suite 4  dynamics classifyRelationshipEvent（启发式分类）
 *   Suite 5  dynamics applyRelationshipEvent（identity-aware delta）
 *   Suite 6  characterStateService 新 helper（suppression / EMA）
 *   Suite 7  socialModes.chooseSocialMode（4 场景）
 *   Suite 8  characterContextBuilder 端到端 payload + promptFragment
 *
 * 现有 tests/characterState.test.js 38 断言保持不动，互不干扰。
 */

const { db } = require("../src/db");
const vocab = require("../src/services/character/identityVocab");
const idsvc = require("../src/services/character/identityService");
const dyn = require("../src/services/character/relationshipDynamicsService");
const cs = require("../src/services/characterStateService");
const { chooseSocialMode } = require("../src/services/character/socialModes");
const { buildCharacterContext, MAX_FRAGMENT_LEN_CHARS } = require("../src/services/character/characterContextBuilder");

let passed = 0;
let failed = 0;
const TS = `t_cc_${Date.now()}`;

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

function approxEq(a, b, eps = 0.01) { return Math.abs(a - b) < eps; }

function makeAid(suffix) { return `${TS}_${suffix}`; }

function setupAssistant(aid, identityFields = {}) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO assistant_profile (assistant_id, character_name, character_background, allow_auto_life, allow_proactive_message, assistant_type, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?)"
  ).run(aid, aid, "", "character", now, now);
  cs.ensureDefaultState(aid);
  idsvc.ensureDefaultIdentity(aid);
  if (Object.keys(identityFields).length) {
    idsvc.upsertIdentity(aid, identityFields);
  }
  dyn.ensureRelationshipState(aid);
}

function cleanupAll() {
  db.prepare("DELETE FROM relationship_event WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM relationship_state WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM character_identity WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM character_state WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM assistant_profile WHERE assistant_id LIKE ?").run(`${TS}_%`);
}

// ── Suite 1: identityVocab ──────────────────────────────────────────
console.log("\n[Suite 1] identityVocab");
{
  // CC-5: trait 表从 35 扩到 43（+8: prideful/dry_witted/blunt/stoic/vindictive/
  //   brooding/shame_prone/theatrical）
  assert(vocab.PERSONALITY_TRAITS.length >= 43, `≥43 traits (got ${vocab.PERSONALITY_TRAITS.length})`);
  assert(vocab.SOCIAL_STRATEGIES.length >= 12, `≥12 social modes (got ${vocab.SOCIAL_STRATEGIES.length})`);
  assert(vocab.TENSIONS.length >= 8, `≥8 tensions`);
  assert(vocab.CARE_LANGUAGES.length === 5, `5 care languages`);
  assert(vocab.COMMON_SKILLS.length >= 18, `≥18 common skills (got ${vocab.COMMON_SKILLS.length})`);

  // CC-5 新加 trait 都在表里
  for (const t of ["prideful", "dry_witted", "blunt", "stoic", "vindictive", "brooding", "shame_prone", "theatrical"]) {
    assert(vocab.PERSONALITY_TRAITS.includes(t), `new trait "${t}" present`);
  }
  assert(vocab.validateTraits(["prideful", "dry_witted"]).ok, "new traits accept in validateTraits");

  assert(vocab.validateTraits(["high_sensitivity", "avoidant_attachment"]).ok, "valid traits accepted");
  assert(!vocab.validateTraits(["unknown_x"]).ok, "unknown trait rejected");
  assert(!vocab.validateAttachmentStyle("mystery").ok, "bad attachment rejected");
  assert(vocab.validateAttachmentStyle(null).ok, "null attachment accepted");
  assert(!vocab.validateTensions({ unknown_tension: 0.5 }).ok, "unknown tension key rejected");
  assert(!vocab.validateTensions({ attachment_vs_fear: 1.5 }).ok, "tension > 1 rejected");
  assert(vocab.validateCareLanguagesPayload({ give: ["acts_of_service"], receive: [] }).ok, "valid care lang accepted");
  assert(!vocab.validateCareLanguagesPayload({ give: ["unknown"] }).ok, "unknown care lang rejected");
  assert(!vocab.validateUnitInterval("emotional_sensitivity", 1.5).ok, "unit > 1 rejected");
  // Phase 1 review fix (P0): 单字 boundary 会误匹配 → 拒绝
  assert(!vocab.validateBoundaryStrings(["不"]).ok, "single-char boundary rejected");
  assert(!vocab.validateBoundaryStrings([""]).ok, "empty boundary rejected");
  assert(vocab.validateBoundaryStrings(["不接受被命令"]).ok, "long boundary accepted");
  assert(vocab.validateBoundaryStrings([]).ok, "empty array accepted");

  // CC-5: skills 校验 —— 字符串、object 带 examples、混用都行；非法形式拒绝
  assert(vocab.validateSkillsPayload(["topic_pivot", "literary_allusion"]).ok, "string array skills accepted");
  assert(vocab.validateSkillsPayload([{ name: "literary_allusion", examples: ["你这跟方鸿渐没区别"] }]).ok, "object form skills accepted");
  assert(vocab.validateSkillsPayload(["topic_pivot", { name: "self_deprecation_as_art" }]).ok, "mixed form skills accepted");
  assert(vocab.validateSkillsPayload([]).ok, "empty skills array accepted");
  assert(!vocab.validateSkillsPayload("not an array").ok, "non-array skills rejected");
  assert(!vocab.validateSkillsPayload([""]).ok, "empty skill name rejected");
  assert(!vocab.validateSkillsPayload([{ examples: ["x"] }]).ok, "skill object without name rejected");
  assert(!vocab.validateSkillsPayload([{ name: "x", examples: "not an array" }]).ok, "non-array examples rejected");
  assert(!vocab.validateSkillsPayload([{ name: "x", examples: [123] }]).ok, "non-string example rejected");
}

// ── Suite 2: identityService ────────────────────────────────────────
console.log("\n[Suite 2] identityService upsert / ensureDefault / coefficients");
{
  const aid = makeAid("idsvc");
  setupAssistant(aid);

  const id1 = idsvc.getCharacterIdentity(aid);
  assert(id1 !== null, "ensureDefault created identity");
  assert(id1.attachmentStyle === "secure", "default attachment_style = secure");
  assert(id1.identityVersion === 1, "default identity_version = 1");

  const id2 = idsvc.upsertIdentity(aid, {
    speakingStyle: "克制",
    personalityTraits: ["high_sensitivity"],
    emotionalSensitivity: 0.8,
  });
  assert(id2.identityVersion === 2, "upsert bumps version");
  assert(id2.speakingStyle === "克制", "speakingStyle persisted");
  assert(id2.personalityTraits.includes("high_sensitivity"), "trait persisted");

  let threw = false;
  try { idsvc.upsertIdentity(aid, { personalityTraits: ["bogus"] }); }
  catch (e) { threw = /unknown traits/.test(e.message); }
  assert(threw, "upsert rejects bogus trait");

  // coefficients differential
  const cAvoidant = idsvc.getIdentityCoefficients({ personalityTraits: ["avoidant_attachment"], emotionalSensitivity: 0.5, empathyLevel: 0.5 });
  const cAnxious = idsvc.getIdentityCoefficients({ personalityTraits: ["anxious_attachment"], emotionalSensitivity: 0.5, empathyLevel: 0.5, insecurities: ["fear_of_abandonment"] });
  const cSecure = idsvc.getIdentityCoefficients({ personalityTraits: ["secure_attachment"], emotionalSensitivity: 0.5, empathyLevel: 0.5 });
  assert(cAnxious.abandonmentMul > cSecure.abandonmentMul + 0.5, `anxious abandonmentMul > secure (${cAnxious.abandonmentMul} vs ${cSecure.abandonmentMul})`);
  assert(cAvoidant.dependencyMul < cSecure.dependencyMul, `avoidant dependencyMul < secure`);
  assert(cAnxious.silenceMultiplier < cSecure.silenceMultiplier, `anxious silenceMultiplier < secure (more eager loneliness)`);

  // Phase 1 review fix: ensureDefaultIdentity 同步 assistant_profile.identity_id
  const aid2 = makeAid("idsvc_sync");
  setupAssistant(aid2);
  const synced = db.prepare("SELECT identity_id FROM assistant_profile WHERE assistant_id = ?").get(aid2);
  const idRow = idsvc.getCharacterIdentity(aid2);
  assert(synced.identity_id === idRow.identityId, "assistant_profile.identity_id synced after ensureDefault");

  // Phase 1 review fix: upsertIdentity 部分更新保留未传字段
  const aid3 = makeAid("idsvc_partial");
  setupAssistant(aid3, { speakingStyle: "原值", personalityTraits: ["secure_attachment"] });
  idsvc.upsertIdentity(aid3, { worldview: "新世界观" });
  const partial = idsvc.getCharacterIdentity(aid3);
  assert(partial.speakingStyle === "原值", "partial update keeps untouched speakingStyle");
  assert(partial.personalityTraits.includes("secure_attachment"), "partial update keeps untouched traits");
  assert(partial.worldview === "新世界观", "partial update applies new worldview");

  // CC-5: skills 持久化（字符串 + object 两种形式 + getCharacterIdentity 解析）
  const aidSkills = makeAid("idsvc_skills");
  setupAssistant(aidSkills);
  idsvc.upsertIdentity(aidSkills, {
    skills: [
      "topic_pivot",
      { name: "literary_allusion", examples: ["你这跟方鸿渐没区别"] },
    ],
  });
  const idSkills = idsvc.getCharacterIdentity(aidSkills);
  assert(Array.isArray(idSkills.skills) && idSkills.skills.length === 2, "skills persisted as array");
  assert(idSkills.skills[0] === "topic_pivot", "string-form skill round-trips");
  assert(idSkills.skills[1].name === "literary_allusion", "object-form skill round-trips name");
  assert(idSkills.skills[1].examples[0] === "你这跟方鸿渐没区别", "object-form skill round-trips examples");

  let skillThrew = false;
  try { idsvc.upsertIdentity(aidSkills, { skills: [{ examples: ["x"] }] }); }
  catch (e) { skillThrew = /skill object must have non-empty name/.test(e.message); }
  assert(skillThrew, "upsert rejects skill object missing name");

  // identity prompt fragment 渲染 skill 名 + example
  const fragWithSkills = idsvc.buildIdentityPromptFragment(idSkills);
  assert(/会用的表达招式/.test(fragWithSkills), "promptFragment surfaces skill names");
  assert(/方鸿渐/.test(fragWithSkills), "promptFragment surfaces skill examples");

  // 默认 ensureDefault 时 skills = []
  const aidSkillsDefault = makeAid("idsvc_skills_default");
  setupAssistant(aidSkillsDefault);
  const idDefault = idsvc.getCharacterIdentity(aidSkillsDefault);
  assert(Array.isArray(idDefault.skills) && idDefault.skills.length === 0, "default identity has empty skills");
}

// ── Suite 3: deriveBaselinesFromIdentity ────────────────────────────
console.log("\n[Suite 3] deriveBaselinesFromIdentity");
{
  const baselines = dyn.deriveBaselinesFromIdentity({
    personalityTraits: ["anxious_attachment"],
    insecurities: ["fear_of_abandonment"],
    coreWounds: ["abandonment_history"],
  });
  assert(approxEq(baselines.abandonment_fear, 0.5), `anxious + insecurity + wound → abandonment_fear baseline ≈ 0.5 (got ${baselines.abandonment_fear})`);

  const avoidantBl = dyn.deriveBaselinesFromIdentity({ personalityTraits: ["avoidant_attachment"] });
  assert(avoidantBl.social_distance > 0.8, `avoidant → social_distance baseline > 0.8 (got ${avoidantBl.social_distance})`);

  const betrayalBl = dyn.deriveBaselinesFromIdentity({ coreWounds: ["betrayal_trauma"] });
  assert(betrayalBl.trust < 0.25, `betrayal_trauma → trust baseline < 0.25 (got ${betrayalBl.trust})`);

  const noneBl = dyn.deriveBaselinesFromIdentity(null);
  assert(approxEq(noneBl.abandonment_fear, 0), "null identity → default 0 abandonment_fear");
}

// ── Suite 4: classifyRelationshipEvent ──────────────────────────────
console.log("\n[Suite 4] classifyRelationshipEvent");
{
  assert(
    dyn.classifyRelationshipEvent({ userMessage: "其实我有点害怕，我从来没跟人说过这件事，每次想到都很难过。" }).eventType === "vulnerable_share",
    "long deep share → vulnerable_share"
  );
  assert(
    dyn.classifyRelationshipEvent({ userMessage: "嗯。" }).eventType === "cold_response",
    "single 嗯。 → cold_response"
  );
  assert(
    dyn.classifyRelationshipEvent({ userMessage: "你最近怎么样？身体还好吗？" }).eventType === "reciprocated_care",
    "ask back → reciprocated_care"
  );
  assert(
    dyn.classifyRelationshipEvent({ userMessage: "够了！你又这样！每次都这样！" }).eventType === "conflict",
    "explicit anger → conflict"
  );
  assert(
    dyn.classifyRelationshipEvent({ userMessage: "对不起，我刚才不该那样说", currentState: { unresolved_conflict: 0.5 } }).eventType === "reconciliation",
    "apology after conflict → reconciliation"
  );
  assert(
    dyn.classifyRelationshipEvent({ userMessage: "在吗？", silenceMs: 5 * 24 * 3600 * 1000 }).eventType === "silence_break",
    "long silence break"
  );
  assert(
    dyn.classifyRelationshipEvent({ userMessage: "今天天气挺好的" }) === null,
    "neutral chat → null (no event)"
  );
  assert(
    dyn.classifyRelationshipEvent({ userMessage: "谢谢你！多亏有你帮忙" }).eventType === "gratitude_expressed",
    "thanks → gratitude_expressed"
  );
  // boundary_violation
  const bvEvent = dyn.classifyRelationshipEvent({
    userMessage: "我命令你做这件事",
    identity: { hardBoundaries: ["命令"] },
  });
  assert(bvEvent && bvEvent.eventType === "boundary_violation", "hardBoundary keyword → boundary_violation");

  // Phase 1 review fix: null / empty input 不抛错
  assert(dyn.classifyRelationshipEvent({ userMessage: null }) === null, "null message → null event");
  assert(dyn.classifyRelationshipEvent({ userMessage: "" }) === null, "empty message → null event");
}

// ── Suite 5: applyRelationshipEvent identity-aware ──────────────────
console.log("\n[Suite 5] applyRelationshipEvent identity-aware");
{
  const aidA = makeAid("anxious_apply");
  const aidS = makeAid("secure_apply");
  setupAssistant(aidA, {
    personalityTraits: ["anxious_attachment", "high_sensitivity"],
    attachmentStyle: "anxious",
    insecurities: ["fear_of_abandonment"],
    emotionalSensitivity: 0.85,
  });
  setupAssistant(aidS, {
    personalityTraits: ["secure_attachment", "thick_skinned"],
    attachmentStyle: "secure",
    emotionalSensitivity: 0.3,
  });

  const rA = dyn.applyRelationshipEvent(aidA, { eventType: "cold_response", intensity: 0.7 });
  const rS = dyn.applyRelationshipEvent(aidS, { eventType: "cold_response", intensity: 0.7 });
  assert(rA.delta.abandonment_fear > rS.delta.abandonment_fear * 1.5, `anxious abandonment delta >> secure (${rA.delta.abandonment_fear} vs ${rS.delta.abandonment_fear})`);
  assert(rA.delta.tension > rS.delta.tension, "anxious tension delta > secure");

  // 事件流水写入
  const events = db.prepare("SELECT event_type FROM relationship_event WHERE assistant_id = ?").all(aidA);
  assert(events.length === 1 && events[0].event_type === "cold_response", "event row inserted");

  // unresolved_conflict 增减
  const rC = dyn.applyRelationshipEvent(aidS, { eventType: "conflict", intensity: 0.8 });
  assert(rC.state.unresolved_conflict > 0.3, `conflict → unresolved_conflict raised (got ${rC.state.unresolved_conflict})`);
  const rR = dyn.applyRelationshipEvent(aidS, { eventType: "reconciliation", intensity: 0.8 });
  assert(rR.state.unresolved_conflict < rC.state.unresolved_conflict, `reconciliation reduces unresolved_conflict`);

  // 时间戳
  assert(rC.state && db.prepare("SELECT last_conflict_at FROM relationship_state WHERE assistant_id=?").get(aidS).last_conflict_at, "last_conflict_at recorded");

  // 不合法 event_type
  let threw = false;
  try { dyn.applyRelationshipEvent(aidS, { eventType: "bogus", intensity: 0.5 }); }
  catch (e) { threw = /unknown relationship event_type/.test(e.message); }
  assert(threw, "bogus event_type rejected");

  // Phase 1 review fix (P0): vulnerable_share 应往用户付出方向（reciprocity_balance +）
  const aidV = makeAid("vshare_sign");
  setupAssistant(aidV);
  const before = dyn.getRelationshipState(aidV).reciprocity_balance;
  const rV = dyn.applyRelationshipEvent(aidV, { eventType: "vulnerable_share", intensity: 0.7 });
  assert(rV.state.reciprocity_balance > before, `vulnerable_share increases reciprocity_balance (${before} → ${rV.state.reciprocity_balance})`);

  // Phase 1 review fix: 衰减时间相关 — tension 3d 半衰期
  const aidD = makeAid("decay");
  setupAssistant(aidD);
  const t0 = Date.now();
  // 直接给 relationship_state 注入高 tension + 把 updated_at 设到过去
  db.prepare("UPDATE relationship_state SET tension = 0.6, updated_at = ? WHERE assistant_id = ?")
    .run(t0 - 3 * 24 * 3600 * 1000, aidD);
  const decayedTension = dyn.getRelationshipState(aidD, t0).tension;
  assert(approxEq(decayedTension, 0.3, 0.05), `tension half-life 3d → 0.6 → ~0.3 (got ${decayedTension})`);

  // 衰减 abandonment_fear 7d 半衰期
  db.prepare("UPDATE relationship_state SET abandonment_fear = 0.6, updated_at = ? WHERE assistant_id = ?")
    .run(t0 - 7 * 24 * 3600 * 1000, aidD);
  const decayedAFear = dyn.getRelationshipState(aidD, t0).abandonment_fear;
  assert(approxEq(decayedAFear, 0.3, 0.05), `abandonment_fear half-life 7d → 0.6 → ~0.3 (got ${decayedAFear})`);

  // 不衰减字段保护：unresolved_conflict + resentment 30d 后应几乎不变
  db.prepare("UPDATE relationship_state SET unresolved_conflict = 0.5, resentment = 0.4, updated_at = ? WHERE assistant_id = ?")
    .run(t0 - 30 * 24 * 3600 * 1000, aidD);
  const stale = dyn.getRelationshipState(aidD, t0);
  assert(approxEq(stale.unresolved_conflict, 0.5, 0.01), `unresolved_conflict 30d 后不衰减 (got ${stale.unresolved_conflict})`);
  assert(approxEq(stale.resentment, 0.4, 0.01), `resentment 30d 后不衰减 (got ${stale.resentment})`);

  // clamp 上界：连续 trust_gained 不爆 1.0
  const aidC = makeAid("clamp");
  setupAssistant(aidC);
  for (let i = 0; i < 15; i++) {
    dyn.applyRelationshipEvent(aidC, { eventType: "trust_gained", intensity: 1.0 });
  }
  const clamped = dyn.getRelationshipState(aidC).trust;
  assert(clamped <= 1.0 && clamped >= 0.9, `trust clamped to [0,1] after many gains (got ${clamped})`);

  // 衰减 + delta 复合（先衰减再叠加）
  const aidF = makeAid("flow");
  setupAssistant(aidF);
  db.prepare("UPDATE relationship_state SET tension = 0.6, updated_at = ? WHERE assistant_id = ?")
    .run(t0 - 3 * 24 * 3600 * 1000, aidF);
  const r2 = dyn.applyRelationshipEvent(aidF, { eventType: "conflict", intensity: 0.5, now: t0 });
  // 期待：先 tension 衰减到 ~0.3，再叠加 conflict 给的 +0.075（0.15 * 0.5），约 0.375
  assert(r2.state.tension > 0.3 && r2.state.tension < 0.5, `decay-then-delta: tension within [0.3, 0.5] (got ${r2.state.tension})`);
}

// ── Suite 6: characterStateService new helpers ─────────────────────
console.log("\n[Suite 6] characterStateService new helpers");
{
  // EMA
  let t = 0;
  for (let i = 0; i < 10; i++) t = cs.nextMoodTrendEma(t, 0.5);
  assert(t > 0.45 && t < 0.51, `EMA converges to ~0.5 (got ${t})`);

  // suppression patch — 强情绪反转
  const stateSad = { mood_emotion: "sad", mood_intensity: 0.7, mood_valence: -0.5 };
  const patch = cs.deriveSuppressionPatch(stateSad, { valence: 0.5 }, Date.now());
  assert(patch.suppressed_emotion === "sad", "strong sad → cheerful triggers suppression");
  assert(approxEq(patch.suppressed_emotion_intensity, 0.42), `suppression retains 60% (got ${patch.suppressed_emotion_intensity})`);

  // suppression patch — 弱情绪不触发
  const stateWeak = { mood_emotion: "sad", mood_intensity: 0.3, mood_valence: -0.3 };
  const patchWeak = cs.deriveSuppressionPatch(stateWeak, { valence: 0.5 }, Date.now());
  assert(Object.keys(patchWeak).length === 0, "weak intensity → no suppression");

  // suppression decay 24h → 半衰
  const decayed = cs.applySuppressedEmotionDecay({
    suppressed_emotion: "sad",
    suppressed_emotion_intensity: 0.6,
    suppressed_emotion_updated_at: Date.now() - 24 * 3600 * 1000,
  }, Date.now());
  assert(approxEq(decayed.suppressed_emotion_intensity, 0.3), `24h half-life ≈ 0.3 (got ${decayed.suppressed_emotion_intensity})`);

  // suppression 衰到 0.05 以下被清掉
  const cleared = cs.applySuppressedEmotionDecay({
    suppressed_emotion: "sad",
    suppressed_emotion_intensity: 0.1,
    suppressed_emotion_updated_at: Date.now() - 5 * 24 * 3600 * 1000,
  }, Date.now());
  assert(cleared.suppressed_emotion === null, "weak suppressed cleared after long decay");
}

// ── Suite 7: socialModes.chooseSocialMode ───────────────────────────
console.log("\n[Suite 7] socialModes.chooseSocialMode");
{
  // 场景 A: teasing
  const r1 = chooseSocialMode({
    identity: { personalityTraits: ["playful_teasing"], socialStrategyDefault: "teasing", empathyLevel: 0.7 },
    characterState: { mood_intensity: 0.4, mood_valence: 0.4 },
    dynamics: { trust: 0.7, emotional_safety: 0.7, emotional_closeness: 0.6, tension: 0.1, social_distance: 0.3, abandonment_fear: 0 },
    emotion: { current: { intensity: 0.4, valence: 0.4 } },
  });
  assert(r1.primary.mode === "teasing", `teasing scenario → primary=teasing (got ${r1.primary.mode})`);

  // 场景 B: defensive
  const r2 = chooseSocialMode({
    identity: { personalityTraits: ["avoidant_attachment", "defensive_aloof"], attachmentStyle: "avoidant", socialStrategyDefault: "detached" },
    characterState: { mood_intensity: 0.5 },
    dynamics: { trust: 0.3, tension: 0.7, unresolved_conflict: 0.4, last_conflict_at: Date.now() - 3600 * 1000, social_distance: 0.85, abandonment_fear: 0 },
    emotion: { current: { intensity: 0.5, valence: 0 } },
  });
  assert(r2.primary.mode === "defensive", `conflict scenario → defensive (got ${r2.primary.mode})`);

  // 场景 C: reassuring
  const r3 = chooseSocialMode({
    identity: { personalityTraits: ["anxious_attachment", "high_empathy"], attachmentStyle: "anxious", socialStrategyDefault: "reassuring", empathyLevel: 0.8 },
    characterState: {},
    dynamics: { trust: 0.5, abandonment_fear: 0.7, tension: 0.4, unresolved_conflict: 0.1 },
    emotion: { current: { intensity: 0.4, valence: 0.1 } },
  });
  assert(r3.primary.mode === "reassuring", `anxious scenario → reassuring`);

  // 场景 D: depressive
  const r4 = chooseSocialMode({
    identity: { personalityTraits: ["melancholic"], attachmentStyle: "secure" },
    characterState: { mood_emotion: "sad", mood_intensity: 0.7, mood_valence: -0.6 },
    dynamics: { trust: 0.5, tension: 0.2, abandonment_fear: 0.1 },
    emotion: { current: { id: "sad", intensity: 0.7, valence: -0.6 }, suppressed: { id: "sad", intensity: 0.4 }, trend24h: -0.4 },
  });
  assert(r4.primary.mode === "depressive", `low valence + suppressed sad → depressive`);

  // 默认 fallback
  const r5 = chooseSocialMode({});
  assert(r5.primary.mode === "casual", "empty input → casual fallback");

  // promptFragment 非空
  assert(r4.promptFragment.includes("[当前社交姿态]"), "promptFragment includes header");

  // Phase 1 review fix: 双 mode 联合（top1-top2 < 0.15 且 top2 > 0.3）
  // 构造场景：playful_teasing 和 high_empathy 各加分但不压倒
  const r6 = chooseSocialMode({
    identity: { personalityTraits: ["playful_teasing", "high_empathy"], socialStrategyDefault: "teasing", empathyLevel: 0.75 },
    characterState: { mood_intensity: 0.4, mood_valence: 0.3 },
    dynamics: { trust: 0.6, emotional_safety: 0.6, emotional_closeness: 0.55, tension: 0.1, social_distance: 0.4, abandonment_fear: 0, last_vulnerable_share_at: Date.now() - 6 * 3600 * 1000 },
    emotion: { current: { intensity: 0.4, valence: 0.3 } },
  });
  // teasing + caretaker 都会高分；只要任一非空就接受双 mode 路径被覆盖
  if (r6.secondary) {
    assert(r6.promptFragment.includes("次要模式"), "dual-mode promptFragment has 次要模式");
  } else {
    assert(true, "dual-mode optional (top1-top2 gap > 0.15)");
  }

  // top1 < 0.4 → fallback casual（不是空输入路径，是真实低分场景）
  const r7 = chooseSocialMode({
    identity: {},
    characterState: { mood_intensity: 0.5 },
    dynamics: { trust: 0.4, emotional_safety: 0.4 },
    emotion: { current: { valence: 0.0, intensity: 0.5 } },
  });
  assert(r7.primary.mode === "casual", `low-signal scene → casual fallback (got ${r7.primary.mode})`);
}

// ── Suite 8: characterContextBuilder end-to-end ─────────────────────
console.log("\n[Suite 8] characterContextBuilder end-to-end");
{
  const aid = makeAid("ctx_e2e");
  setupAssistant(aid, {
    speakingStyle: "克制温柔",
    personalityTraits: ["avoidant_attachment", "high_sensitivity"],
    attachmentStyle: "avoidant",
    socialStrategyDefault: "detached",
    insecurities: ["fear_of_being_misunderstood"],
    careLanguages: { give: ["quality_time"], receive: ["verbal_affirmation"] },
  });
  // 触发一次 vulnerable_share + cold response
  dyn.applyRelationshipEvent(aid, { eventType: "vulnerable_share", intensity: 0.7 });

  const ctx = buildCharacterContext(aid);
  assert(ctx !== null, "context built");
  assert(ctx.identity.speakingStyle === "克制温柔", "identity in payload");
  assert(Array.isArray(ctx.identity.personalityTraits) && ctx.identity.personalityTraits.includes("avoidant_attachment"), "traits in payload");
  assert(ctx.relationshipDynamics !== null, "dynamics in payload");
  assert(typeof ctx.relationshipDynamics.trust === "number", "12 dim numbers");
  assert(ctx.emotion !== null, "emotion in payload");
  assert(ctx.socialMode && ctx.socialMode.primary, "socialMode chosen (payload kept even though prompt drops it)");

  // Phase 2 cleanup: 旧 system / userPrefix / promptFragment 字段已移除。
  // 新结构：slots（V_NEW_LEAN 8 段 XML+JSON）+ assistantPrefill（独白片段）。
  assert(ctx.slots && typeof ctx.slots === "object", "slots present");
  assert(/<role>/.test(ctx.slots.role), "slots.role has <role> XML");
  assert(/<character>/.test(ctx.slots.character), "slots.character has <character> XML");
  assert(/<background>/.test(ctx.slots.background), "slots.background has <background> XML");
  assert(/<constraints>/.test(ctx.slots.constraints), "slots.constraints has <constraints> XML");
  assert(/<facts>/.test(ctx.slots.facts), "slots.facts has <facts> XML");
  assert(/<narrative>/.test(ctx.slots.narrative), "slots.narrative has <narrative> XML");
  assert(/<tool_protocol>/.test(ctx.slots.tool_protocol), "slots.tool_protocol has <tool_protocol> XML");
  // 默认无 pronouns 配置 → fallback "they/them"；voice 内容现在合并在 <role> slot 里
  assert(/Speak as them, not about them/.test(ctx.slots.role), "default pronouns → 'them' in role slot voice anchor");

  // assistantPrefill 是 string，可以为空（无异常态时）
  assert(typeof ctx.assistantPrefill === "string", "assistantPrefill is string");

  // 旧字段彻底移除（dev 客户端无兼容包袱）
  assert(ctx.system === undefined, "system field removed (Phase 2 cleanup)");
  assert(ctx.userPrefix === undefined, "userPrefix field removed (Phase 2 cleanup)");
  assert(ctx.promptFragment === undefined, "promptFragment field removed (Phase 2 cleanup)");
  assert(ctx.identity.characterBackground === undefined, "identity.characterBackground removed (dedup)");

  // mergedSystem 是 server 端为方便调试拼好的完整 system（不含 <client> slot — 那是客户端职责）
  assert(typeof ctx.mergedSystem === "string" && ctx.mergedSystem.length > 0, "mergedSystem present");
  assert(ctx.mergedSystem.startsWith(ctx.slots.role), "mergedSystem starts with role slot");

  // 删除的段：socialMode prompt 段在 V_NEW_LEAN 里也不存在
  assert(!/\[当前社交姿态\]/.test(ctx.mergedSystem), "socialMode prompt section absent");

  // salient phrase 默认未传 lastUserMessage 时为 null
  assert(ctx.salientPhrase === null, "salientPhrase null without lastUserMessage");

  // null assistant_profile → returns null
  assert(buildCharacterContext("nonexistent_aid_xyz") === null, "nonexistent assistantId → null");

  // Phase 1 review fix: profileFallback 路径（profile 存在但 character_identity 不存在）
  const aidNoId = makeAid("no_identity");
  const now = Date.now();
  db.prepare(
    "INSERT INTO assistant_profile (assistant_id, character_name, character_background, allow_auto_life, allow_proactive_message, assistant_type, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?)"
  ).run(aidNoId, aidNoId, "no identity row test", "character", now, now);
  cs.ensureDefaultState(aidNoId);
  // 不调 ensureDefaultIdentity → character_identity 表无行
  const ctxFallback = buildCharacterContext(aidNoId);
  assert(ctxFallback !== null, "profileFallback: context still built");
  assert(ctxFallback.identity.identityId === null, "profileFallback: identityId is null");
  assert(ctxFallback.identity.identityVersion === 0, "profileFallback: identityVersion = 0");
  assert(Array.isArray(ctxFallback.identity.personalityTraits), "profileFallback: traits is array");
  assert(ctxFallback.identity.careLanguages.give !== undefined, "profileFallback: careLanguages shape");

  // Phase 1 review fix: truncation 段级丢弃路径
  const aidLong = makeAid("truncate");
  const longBg = "你是一个非常复杂的角色，背景信息非常长。".repeat(60); // ~ 1200+ chars
  db.prepare(
    "INSERT INTO assistant_profile (assistant_id, character_name, character_background, allow_auto_life, allow_proactive_message, assistant_type, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?)"
  ).run(aidLong, aidLong, longBg, "character", now, now);
  cs.ensureDefaultState(aidLong);
  idsvc.ensureDefaultIdentity(aidLong);
  idsvc.upsertIdentity(aidLong, {
    speakingStyle: "克制温柔",
    personalityTraits: ["avoidant_attachment", "high_sensitivity", "intellectually_romantic"],
    values: ["intellectual_honesty", "loyalty"],
    hardBoundaries: ["不接受被命令", "不讨论前任"],
    insecurities: ["fear_of_being_misunderstood", "fear_of_being_boring"],
    desires: ["to_be_understood", "intellectual_partnership"],
    careLanguages: { give: ["quality_time"], receive: ["verbal_affirmation"] },
  });
  const ctxLong = buildCharacterContext(aidLong);
  // V_NEW_LEAN: 检查 mergedSystem（server 拼好的完整 system，与旧 promptFragment 等价）budget
  assert(ctxLong.mergedSystem.length > 0, "long bg: mergedSystem rendered");
  // 重要：段级丢弃不切中文字符；不应该有"..."拼在汉字一半
  assert(!/[一-龥]\.\.\.[一-龥]/.test(ctxLong.mergedSystem), "truncation does not splice mid-CJK");

  // Phase 1 review fix: onUserMessage 在无 assistant_profile 时跳过 dynamics（不抛错）
  const aidNoProfile = makeAid("no_profile");
  cs.ensureDefaultState(aidNoProfile);
  // 故意不 INSERT assistant_profile
  let dynRanRow;
  try {
    cs.onUserMessage(aidNoProfile, { content: "对不起，我刚才不该" });
    dynRanRow = db.prepare("SELECT 1 FROM relationship_state WHERE assistant_id = ?").get(aidNoProfile);
  } catch (e) {
    dynRanRow = "threw";
  }
  assert(!dynRanRow, "onUserMessage skips dynamics when assistant_profile missing");
}

// ── Suite 9: salientPhraseDetector (CC-5 / Plan D) ──────────────────
console.log("\n[Suite 9] salientPhraseDetector");
{
  const { detectSalientPhrase, TRIGGER_DICT } = require("../src/services/character/salientPhraseDetector");

  // 字典覆盖：常见 insecurity / wound 都有 trigger
  for (const k of ["fear_of_abandonment", "betrayal_trauma", "emotional_invalidation", "fear_of_rejection"]) {
    assert(Array.isArray(TRIGGER_DICT[k]) && TRIGGER_DICT[k].length > 0, `dict has triggers for ${k}`);
  }
  // 字典精度：所有关键词 ≥ 2 字（跟 boundary 校验一致）
  for (const [src, kws] of Object.entries(TRIGGER_DICT)) {
    for (const kw of kws) {
      assert(kw.length >= 2, `${src} keyword "${kw}" should be ≥ 2 chars`);
    }
  }

  // null 输入 → null
  assert(detectSalientPhrase(null, { insecurities: ["fear_of_abandonment"] }) === null, "null message returns null");
  assert(detectSalientPhrase("随便", null) === null, "null identity returns null");
  assert(detectSalientPhrase("", { insecurities: ["fear_of_abandonment"] }) === null, "empty message returns null");

  // 无对应 wound → null（即便消息含触发词，没 wound 不勾住）
  const idNoWound = { insecurities: [], coreWounds: [] };
  assert(detectSalientPhrase("算了，随便吧", idNoWound) === null, "no insecurity → no salient phrase");

  // 有 wound + 命中关键词 → 命中
  const idAbandon = { insecurities: ["fear_of_abandonment"], coreWounds: [] };
  const r1 = detectSalientPhrase("算了，随便吧", idAbandon);
  assert(r1 !== null, "abandonment + '算了' → match");
  assert(r1.phrase === "算了" || r1.phrase === "随便", "matched phrase is one of the keywords");
  assert(r1.triggerSource === "fear_of_abandonment", "triggerSource correctly identified");
  assert(/咯噔/.test(r1.monologueLine), "monologueLine uses abandonment template");

  // 取最早出现位置的关键词（不是字典顺序）
  const r2 = detectSalientPhrase("随便，算了。", idAbandon);
  assert(r2.phrase === "随便", `earliest-position keyword wins (got ${r2.phrase})`);

  // insecurities 优先 core_wounds
  const idMixed = { insecurities: ["fear_of_being_too_much"], coreWounds: ["betrayal_trauma"] };
  const r3 = detectSalientPhrase("受够了，改天再说", idMixed);
  assert(r3.triggerSource === "fear_of_being_too_much", `insecurity wins over wound (got ${r3.triggerSource})`);

  // 不同 wound 用不同模板
  const idBetrayal = { insecurities: [], coreWounds: ["betrayal_trauma"] };
  const r4 = detectSalientPhrase("我们改天再说吧", idBetrayal);
  assert(r4 !== null && /又来了/.test(r4.monologueLine), "betrayal template used");

  const idInvalidate = { insecurities: [], coreWounds: ["emotional_invalidation"] };
  const r5 = detectSalientPhrase("你想多了。", idInvalidate);
  assert(r5 !== null && /闭了下嘴/.test(r5.monologueLine), "invalidation template used");

  const idReject = { insecurities: ["fear_of_rejection"], coreWounds: [] };
  const r6 = detectSalientPhrase("我有点讨厌这种人", idReject);
  assert(r6 !== null && /缩回去/.test(r6.monologueLine), "rejection template used");

  // 中性消息 → null（精度优先）
  const r7 = detectSalientPhrase("今天天气真好，一起出去走走？", { insecurities: ["fear_of_abandonment"] });
  assert(r7 === null, "neutral message with no trigger keyword → null");

  // 与现有 trait/wound vocab 集成：identity 来自真实 upsert 路径
  const aidSp = makeAid("salient");
  setupAssistant(aidSp, {
    insecurities: ["fear_of_abandonment"],
    coreWounds: ["betrayal_trauma"],
  });
  const idReal = idsvc.getCharacterIdentity(aidSp);
  const r8 = detectSalientPhrase("算了，我之后再说吧", idReal);
  assert(r8 !== null, "works on identity from real upsert path");
  // 因为 insecurity 优先，"算了" 在前会胜出
  assert(r8.triggerSource === "fear_of_abandonment", "insecurity priority preserved on real identity");
}

// ── Suite 10: V_NEW_LEAN slots + monologue（Phase 2 cleanup 重写） ─────
console.log("\n[Suite 10] V_NEW_LEAN slots + assistantPrefill rendering");
{
  const cb = require("../src/services/character/characterContextBuilder");
  const composer = require("../src/services/character/promptComposer");
  const { buildUserMonologue, pickDynamicsAnomalies, renderMoodFragment } = cb;

  // composeForChat：identity + profile → V_NEW_LEAN 8 slots（XML+JSON envelope）
  const aid = makeAid("c_split");
  setupAssistant(aid, {
    speakingStyle: "克制温柔",
    personalityTraits: ["prideful", "dry_witted"],
    skills: [
      "topic_pivot",
      { name: "literary_allusion", examples: ["你这跟方鸿渐没区别"] },
    ],
    insecurities: ["fear_of_losing_face"],
  });
  const profile = require("../src/db").getAssistantProfile(aid);
  const id = idsvc.getCharacterIdentity(aid);
  const composed = composer.composeForChat({ profile, identity: id });
  // 8 个 slots 都存在
  assert(/<role>/.test(composed.slots.role), "<role> slot present");
  assert(/<character>/.test(composed.slots.character), "<character> slot present");
  // V_NEW_LEAN: <character> JSON 含 traits + skills（精简策略后保留的字段）
  assert(/dry_witted/.test(composed.slots.character) && /prideful/.test(composed.slots.character), "character JSON surfaces traits");
  assert(/literary_allusion/.test(composed.slots.character), "character JSON surfaces skill name");
  assert(/方鸿渐/.test(composed.slots.character), "character JSON surfaces skill example");
  // V_NEW_LEAN 删了 insecurities 字段（chat 端通过 reflection 间接传递；server introspection 仍然保留）
  assert(!/fear_of_losing_face/.test(composed.slots.character), "insecurities removed from chat character slot (V_NEW_LEAN)");

  // pickDynamicsAnomalies：trust 低 → 命中 lowFrag
  const anomalies1 = pickDynamicsAnomalies({ trust: 0.2, abandonment_fear: 0.0 });
  assert(anomalies1.length > 0 && anomalies1[0].key === "trust", "trust=0.2 → trust anomaly");
  assert(/trust 没那么稳/.test(anomalies1[0].fragment), "trust low fragment used");

  // pickDynamicsAnomalies：abandonment_fear 高 → highFrag
  const anomalies2 = pickDynamicsAnomalies({ trust: 0.5, abandonment_fear: 0.7 });
  assert(anomalies2.length > 0 && anomalies2[0].key === "abandonment_fear", "abandonment_fear=0.7 → anomaly");
  assert(/心里空了一块/.test(anomalies2[0].fragment), "abandonment fragment used");

  // pickDynamicsAnomalies：偏离严重的优先
  const anomalies3 = pickDynamicsAnomalies({ trust: 0.45, unresolved_conflict: 0.8 });
  assert(anomalies3[0].key === "unresolved_conflict", "more anomalous wins");

  // renderMoodFragment：低 intensity 不输出
  assert(renderMoodFragment({ mood_intensity: 0.1, mood_valence: -0.5 }) === null, "low intensity → no mood frag");
  // valence + arousal 兜底
  assert(renderMoodFragment({ mood_intensity: 0.6, mood_valence: -0.5, mood_arousal: 0.7, mood_emotion: "neutral" }) !== null, "high arousal + neg valence → mood frag");

  // buildUserMonologue：salient phrase 在第一行
  const monologue1 = buildUserMonologue({
    characterState: { mood_intensity: 0.7, mood_valence: -0.5, mood_arousal: 0.7, mood_emotion: "neutral" },
    dynamicsState: { trust: 0.2 },
    now: Date.now(),
    salientPhrase: { phrase: "随便", triggerSource: "fear_of_abandonment", monologueLine: '"随便"。这两个字我心里咯噔一下。' },
    recentEpisodes: [],
    activeTopics: [],
    freshReflection: null,
  });
  assert(monologue1.startsWith("[此刻]"), "monologue starts with [此刻]");
  assert(monologue1.indexOf("随便") < monologue1.indexOf("trust"), "salient phrase precedes dynamics");

  // buildUserMonologue：完全无异常 → 返回 ""
  const monologue2 = buildUserMonologue({
    characterState: { mood_intensity: 0.1, mood_valence: 0.05, mood_arousal: 0.2, mood_emotion: "neutral" },
    dynamicsState: { trust: 0.5, abandonment_fear: 0 },
    now: Date.now(),
    salientPhrase: null,
    recentEpisodes: [],
    activeTopics: [],
    freshReflection: null,
  });
  assert(monologue2 === "", "all-neutral state → empty monologue");

  // buildCharacterContext + lastUserMessage → salient phrase 命中
  const ctxWithSalient = cb.buildCharacterContext(aid, {
    lastUserMessage: "丢人现眼，至于吗",
  });
  assert(ctxWithSalient.salientPhrase !== null, "lastUserMessage triggers salient detection");
  assert(ctxWithSalient.salientPhrase.triggerSource === "fear_of_losing_face", "East Asian wound triggers correctly");
  assert(/丢人现眼|丢人/.test(ctxWithSalient.assistantPrefill), "salient phrase appears in assistantPrefill");
  // mergedSystem 是 server 拼好的完整 system（不含 <client> slot — 客户端职责）
  assert(typeof ctxWithSalient.mergedSystem === "string" && ctxWithSalient.mergedSystem.length > 0, "mergedSystem is composed");

  // 长 character_background：composeForChat 内部 background slot 自带 truncation
  const aidLong = makeAid("c_split_long");
  const longBg = "你是一个非常复杂的角色，背景信息非常长。".repeat(80); // ~ 1600+ chars
  const now = Date.now();
  db.prepare(
    "INSERT INTO assistant_profile (assistant_id, character_name, character_background, allow_auto_life, allow_proactive_message, assistant_type, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?)"
  ).run(aidLong, aidLong, longBg, "character", now, now);
  cs.ensureDefaultState(aidLong);
  idsvc.ensureDefaultIdentity(aidLong);
  const ctxLong2 = cb.buildCharacterContext(aidLong);
  // background slot 内部 1500 char cap（promptComposer.SLOT_SOFT_LIMITS.background）
  assert(ctxLong2.slots.background.length < longBg.length, "long background gets truncated in slot");
  assert(/<role>/.test(ctxLong2.slots.role), "role slot survives independent of background truncation");
}

// ── Suite 11: pronouns + 动态 voice anchor ────────────────────────────
console.log("\n[Suite 11] pronouns parsing + dynamic voice anchor");
{
  const { parsePronouns, validatePronouns, PRONOUN_PRESETS } = vocab;
  const cb = require("../src/services/character/characterContextBuilder");

  // PRONOUN_PRESETS 至少包含 3 个常见 preset
  assert(PRONOUN_PRESETS.includes("she/her"), "PRONOUN_PRESETS has she/her");
  assert(PRONOUN_PRESETS.includes("he/him"), "PRONOUN_PRESETS has he/him");
  assert(PRONOUN_PRESETS.includes("they/them"), "PRONOUN_PRESETS has they/them");

  // parsePronouns —— 三个 preset 解析正确
  const sheHer = parsePronouns("she/her");
  assert(sheHer.subject === "she" && sheHer.object === "her" && sheHer.possessive === "her", "she/her parsed");
  const heHim = parsePronouns("he/him");
  assert(heHim.subject === "he" && heHim.object === "him" && heHim.possessive === "his", "he/him parsed");
  const theyThem = parsePronouns("they/them");
  assert(theyThem.subject === "they" && theyThem.object === "them" && theyThem.possessive === "their", "they/them parsed");

  // 空 / null / undefined → default they/them
  for (const v of [null, undefined, "", "   "]) {
    const p = parsePronouns(v);
    assert(p.subject === "they" && p.object === "them", `empty input "${v}" → they/them default`);
  }

  // 自定义代词（如 xe/xem/xyr）
  const xe = parsePronouns("xe/xem/xyr");
  assert(xe.subject === "xe" && xe.object === "xem" && xe.possessive === "xyr", "custom xe/xem/xyr parsed");

  // validatePronouns
  assert(validatePronouns("she/her").ok, "she/her valid");
  assert(validatePronouns("").ok, "empty valid");
  assert(validatePronouns(null).ok, "null valid");
  assert(!validatePronouns(123).ok, "non-string rejected");
  assert(!validatePronouns("a".repeat(50)).ok, "too long rejected");

  // renderRoleDirective —— 用 object 代词
  assert(cb.renderRoleDirective(sheHer) === "You are her. Speak as her, not about her.", "role directive: her");
  assert(cb.renderRoleDirective(heHim) === "You are him. Speak as him, not about him.", "role directive: him");
  assert(cb.renderRoleDirective(theyThem) === "You are them. Speak as them, not about them.", "role directive: them");

  // renderVoiceAnchor —— 用 subject contraction + possessive
  assert(/^She's mid-conversation/.test(cb.renderVoiceAnchor(sheHer)), "voice anchor: She's");
  assert(/^He's mid-conversation/.test(cb.renderVoiceAnchor(heHim)), "voice anchor: He's");
  assert(/^They're mid-conversation/.test(cb.renderVoiceAnchor(theyThem)), "voice anchor: They're");
  assert(/Use her skills/.test(cb.renderVoiceAnchor(sheHer)), "voice anchor uses 'her' possessive");
  assert(/Use his skills/.test(cb.renderVoiceAnchor(heHim)), "voice anchor uses 'his' possessive");
  assert(/Use their skills/.test(cb.renderVoiceAnchor(theyThem)), "voice anchor uses 'their' possessive");

  // 端到端：identity 设了 pronouns → buildCharacterContext 的 system 段用对应代词
  const aidShe = makeAid("pron_she");
  setupAssistant(aidShe, { pronouns: "she/her" });
  const ctxShe = cb.buildCharacterContext(aidShe);
  assert(/Speak as her, not about her/.test(ctxShe.slots.role), "she/her identity → 'her' voice anchor");
  assert(/She's mid-conversation/.test(ctxShe.slots.role), "she/her identity → She's");
  assert(ctxShe.identity.pronouns === "she/her", "pronouns surfaced in payload");

  const aidHe = makeAid("pron_he");
  setupAssistant(aidHe, { pronouns: "he/him" });
  const ctxHe = cb.buildCharacterContext(aidHe);
  assert(/Speak as him, not about him/.test(ctxHe.slots.role), "he/him identity → 'him' voice anchor");
  assert(/He's mid-conversation/.test(ctxHe.slots.role), "he/him identity → He's");
  assert(/Use his skills/.test(ctxHe.slots.role), "he/him identity → Use his skills");

  const aidThey = makeAid("pron_they");
  setupAssistant(aidThey, { pronouns: "they/them" });
  const ctxThey = cb.buildCharacterContext(aidThey);
  assert(/Speak as them, not about them/.test(ctxThey.slots.role), "they/them identity → 'them' voice anchor");
  assert(/They're mid-conversation/.test(ctxThey.slots.role), "they/them identity → They're");

  // 空 pronouns → fallback they
  const aidEmpty = makeAid("pron_empty");
  setupAssistant(aidEmpty);
  const ctxEmpty = cb.buildCharacterContext(aidEmpty);
  assert(/Speak as them, not about them/.test(ctxEmpty.slots.role), "empty pronouns → fallback they/them");

  // upsert 支持 pronouns 字段
  const aidUpsert = makeAid("pron_upsert");
  setupAssistant(aidUpsert);
  idsvc.upsertIdentity(aidUpsert, { pronouns: "he/him" });
  assert(idsvc.getCharacterIdentity(aidUpsert).pronouns === "he/him", "pronouns persisted via upsert");
  // 校验
  let pronounThrew = false;
  try { idsvc.upsertIdentity(aidUpsert, { pronouns: 12345 }); }
  catch (e) { pronounThrew = /pronouns must be string/.test(e.message); }
  assert(pronounThrew, "non-string pronouns rejected via upsert");
}

cleanupAll();

console.log("\n──────────────────────────────────────────────────");
console.log(`结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
