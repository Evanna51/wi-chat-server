/**
 * reflection.test.js — Phase 3 (CC-3) 测试套件
 *
 * 覆盖：
 *   Suite 1  insertReflection / getLatestReflection / listReflections
 *   Suite 2  shouldTriggerEventReflection: trust drop / unresolved / silence / cooldown
 *   Suite 3  characterContextBuilder 注入 reflection 段（fresh / stale）
 *   Suite 4  rejection paths (invalid type / missing summary fallback)
 *
 * 不测：reflectFor 的 LLM 路径（同 episodeBuilder，留给生产观测）
 */

const { db } = require("../src/db");
const ref = require("../src/services/character/reflectionService");
const cs = require("../src/services/characterStateService");
const idsvc = require("../src/services/character/identityService");
const dyn = require("../src/services/character/relationshipDynamicsService");
const { buildCharacterContext } = require("../src/services/character/characterContextBuilder");
const { v7: uuidv7 } = require("uuid");

let passed = 0;
let failed = 0;
const TS = `t_r_${Date.now()}_${process.pid}`;

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

function makeAid(suffix) { return `${TS}_${suffix}`; }

function setupAssistant(aid) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO assistant_profile (assistant_id, character_name, character_background, allow_auto_life, allow_proactive_message, assistant_type, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?)"
  ).run(aid, aid, "", "character", now, now);
  cs.ensureDefaultState(aid);
  idsvc.ensureDefaultIdentity(aid);
  dyn.ensureRelationshipState(aid);
}

function insertSyntheticEvent(assistantId, deltaJsonObj, atMs) {
  db.prepare(
    `INSERT INTO relationship_event (id, assistant_id, event_type, intensity, source_turn_id, delta_json, description, created_at)
     VALUES (?, ?, 'trust_broken', 0.9, NULL, ?, NULL, ?)`
  ).run(uuidv7(), assistantId, JSON.stringify(deltaJsonObj), atMs);
}

function cleanupAll() {
  db.prepare("DELETE FROM relationship_event WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM relationship_reflection WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM relationship_state WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM character_identity WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM character_state WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM assistant_profile WHERE assistant_id LIKE ?").run(`${TS}_%`);
}

// ── Suite 1: insertReflection / getLatestReflection / listReflections ──
console.log("\n[Suite 1] reflection insert / read");
{
  const aid = makeAid("ins");
  setupAssistant(aid);
  const now = Date.now();

  const id1 = ref.insertReflection({
    assistantId: aid,
    reflectionType: "manual",
    summary: "第一段反思",
    emotionalTrend: "improving",
    relationshipDirection: "deepening",
    userNeeds: ["被肯定"],
    concerns: ["ta 焦虑"],
    opportunities: ["主动祝贺"],
    sourceData: { ts: now },
    windowStart: now - 7 * 24 * 3600 * 1000,
    windowEnd: now,
    now: now - 60 * 1000,
  });
  assert(typeof id1 === "string" && id1.length > 0, "insertReflection returns id");

  const id2 = ref.insertReflection({
    assistantId: aid,
    reflectionType: "weekly",
    summary: "第二段更新的反思",
    emotionalTrend: "stable",
    relationshipDirection: "stable",
    userNeeds: [],
    concerns: [],
    opportunities: [],
    sourceData: {},
    windowStart: now - 7 * 24 * 3600 * 1000,
    windowEnd: now,
    now,
  });

  const latest = ref.getLatestReflection(aid);
  assert(latest && latest.id === id2, "getLatest returns newest");
  assert(latest.reflectionType === "weekly", "latest is the weekly one");

  const all = ref.listReflections(aid);
  assert(all.length === 2, "listReflections returns 2");

  const onlyWeekly = ref.listReflections(aid, { type: "weekly" });
  assert(onlyWeekly.length === 1 && onlyWeekly[0].id === id2, "type filter works");

  // 字段完整性
  assert(Array.isArray(latest.userNeeds) && Array.isArray(latest.concerns), "JSON fields parsed");

  // 不合法 reflection_type 被拒绝
  let threw = false;
  try {
    ref.insertReflection({
      assistantId: aid, reflectionType: "bogus_type", summary: "x",
      windowStart: now, windowEnd: now,
    });
  } catch (e) { threw = /invalid reflection_type/.test(e.message); }
  assert(threw, "invalid reflection_type rejected");

  // 不合法 emotionalTrend 被 fallback 到 stable
  const fid = ref.insertReflection({
    assistantId: aid,
    reflectionType: "manual",
    summary: "fallback test",
    emotionalTrend: "bogus_trend",
    relationshipDirection: "bogus_dir",
    userNeeds: [],
    concerns: [],
    opportunities: [],
    sourceData: {},
    windowStart: now,
    windowEnd: now,
  });
  const fr = ref.listReflections(aid).find((r) => r.id === fid);
  assert(fr.emotionalTrend === "stable" && fr.relationshipDirection === "stable", "invalid enums fall back to stable");
}

// ── Suite 2: shouldTriggerEventReflection ───────────────────────
console.log("\n[Suite 2] shouldTriggerEventReflection");
{
  const aid = makeAid("trig");
  setupAssistant(aid);
  const now = Date.now();

  // 起初无任何条件 → null
  assert(ref.shouldTriggerEventReflection(aid, { now }) === null, "no events → null");

  // trust drop > 0.15 in 1h
  insertSyntheticEvent(aid, { trust: -0.10 }, now - 30 * 60 * 1000);
  insertSyntheticEvent(aid, { trust: -0.10 }, now - 10 * 60 * 1000);
  const r = ref.shouldTriggerEventReflection(aid, { now });
  assert(r !== null && /trust_dropped/.test(r), `trust drop trigger: ${r}`);

  // cooldown：写一条 event_triggered reflection → 6h 内不再触发
  ref.insertReflection({
    assistantId: aid,
    reflectionType: "event_triggered",
    summary: "test cooldown",
    emotionalTrend: "stable",
    relationshipDirection: "stable",
    userNeeds: [],
    concerns: [],
    opportunities: [],
    sourceData: {},
    windowStart: now,
    windowEnd: now,
    triggerReason: r,
    now: now - 60 * 1000,
  });
  assert(ref.shouldTriggerEventReflection(aid, { now }) === null, "cooldown blocks within 6h");

  // unresolved_conflict ≥ 0.5 也会触发（先把上一条 event_triggered 拉到 7h 前绕开 cooldown）
  db.prepare("UPDATE relationship_reflection SET created_at = ? WHERE assistant_id = ? AND reflection_type = ?")
    .run(now - 7 * 60 * 60 * 1000, aid, "event_triggered");
  db.prepare("UPDATE relationship_state SET unresolved_conflict = 0.6 WHERE assistant_id = ?").run(aid);
  // 清掉 trust event 防干扰
  db.prepare("DELETE FROM relationship_event WHERE assistant_id = ?").run(aid);
  const r2 = ref.shouldTriggerEventReflection(aid, { now });
  assert(r2 !== null && /unresolved_conflict/.test(r2), `unresolved_conflict trigger: ${r2}`);

  // silence > 14d
  db.prepare("UPDATE relationship_state SET unresolved_conflict = 0 WHERE assistant_id = ?").run(aid);
  db.prepare("UPDATE character_state SET last_user_message_at = ? WHERE assistant_id = ?")
    .run(now - 16 * 24 * 3600 * 1000, aid);
  // 又写一条最新 cooldown 之外的 event_triggered？不需要：上一条已经 7h 前了
  const r3 = ref.shouldTriggerEventReflection(aid, { now });
  assert(r3 !== null && /silence/.test(r3), `silence trigger: ${r3}`);
}

// ── Suite 3: characterContextBuilder reflection inject ─────────
console.log("\n[Suite 3] characterContextBuilder reflection injection");
{
  const aid = makeAid("ctx");
  setupAssistant(aid);
  const now = Date.now();

  // 初始 ctx 没 reflection
  let ctx = buildCharacterContext(aid);
  assert(!ctx.latestReflection, "no reflection initially");
  assert(!/最近觉得/.test(ctx.assistantPrefill || ""), "no reflection line in assistantPrefill initially");

  // 插一条 fresh reflection
  ref.insertReflection({
    assistantId: aid,
    reflectionType: "manual",
    summary: "fresh reflection content here for testing",
    emotionalTrend: "improving",
    relationshipDirection: "deepening",
    userNeeds: ["被理解"],
    concerns: ["ta 太累"],
    opportunities: ["主动陪伴"],
    sourceData: {},
    windowStart: now - 7 * 24 * 3600 * 1000,
    windowEnd: now,
    now,
  });
  ctx = buildCharacterContext(aid);
  assert(ctx.latestReflection && ctx.latestReflection.summary.includes("fresh"), "latestReflection in payload");
  // CC-5.C: reflection 不再有结构化 prompt 段，改成 assistantPrefill 独白里一行 "最近觉得：..."
  assert(/最近觉得/.test(ctx.assistantPrefill), "assistantPrefill has reflection monologue line");
  assert(/fresh reflection/.test(ctx.assistantPrefill), "reflection summary surfaced in assistantPrefill");

  // 老 reflection (15d 前) 不应被注入
  db.prepare("DELETE FROM relationship_reflection WHERE assistant_id = ?").run(aid);
  ref.insertReflection({
    assistantId: aid,
    reflectionType: "manual",
    summary: "stale reflection",
    emotionalTrend: "stable",
    relationshipDirection: "stable",
    userNeeds: [],
    concerns: [],
    opportunities: [],
    sourceData: {},
    windowStart: now - 30 * 24 * 3600 * 1000,
    windowEnd: now - 15 * 24 * 3600 * 1000,
    now: now - 15 * 24 * 3600 * 1000,
  });
  const ctxStale = buildCharacterContext(aid);
  assert(!ctxStale.latestReflection, "stale reflection (>14d) excluded from payload");
  assert(!/最近觉得/.test(ctxStale.assistantPrefill || ""), "stale reflection excluded from assistantPrefill");
}

// ── Suite 4: text clipping ─────────────────────────────────────
console.log("\n[Suite 4] text clipping & list size cap");
{
  const aid = makeAid("clip");
  setupAssistant(aid);
  const now = Date.now();
  const longSummary = "很长的反思".repeat(200); // 1200 chars
  const id = ref.insertReflection({
    assistantId: aid,
    reflectionType: "manual",
    summary: longSummary,
    emotionalTrend: "stable",
    relationshipDirection: "stable",
    userNeeds: Array(20).fill("need"),       // 20 items
    concerns: Array(15).fill("concern"),
    opportunities: Array(15).fill("opp"),
    sourceData: {},
    windowStart: now,
    windowEnd: now,
  });
  const r = ref.listReflections(aid).find((x) => x.id === id);
  assert(r.summary.length <= 600 + 3, `summary clipped to ≤603 chars (got ${r.summary.length})`);
  assert(r.userNeeds.length === 8, `userNeeds capped at 8 (got ${r.userNeeds.length})`);
  assert(r.concerns.length === 6, `concerns capped at 6 (got ${r.concerns.length})`);
  assert(r.opportunities.length === 6, `opportunities capped at 6 (got ${r.opportunities.length})`);
}

cleanupAll();
console.log("\n──────────────────────────────────────────────────");
console.log(`结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
