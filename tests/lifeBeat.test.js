/**
 * lifeBeat.test.js — character life beat 系统测试套件
 *
 * 覆盖 Phase 1+2 的核心组件（migration 035，docs/character-life-beat-plan.md）：
 *   Suite 1  db.js life_beat CRUD（insert/list/mark/expire/has）
 *   Suite 2  lifePlannerService 边界（不打 LLM）
 *   Suite 3  lifeBeatTickService 决策树
 *   Suite 4  characterContextBuilder 当前 beat 注入 + 时态/类型分支
 *
 * 命名空间：t_cc_lb_*（落进 clean-test-data.js 的 t_cc_ 清理范围）。
 * 不打 LLM —— Suite 3 通过 mock 验证 isChatActive / processBeat 决策树，不调 nextPush
 * 实际的 LLM 路径。
 */

const dbModule = require("../src/db");
const { db } = dbModule;
const cs = require("../src/services/characterStateService");
const idsvc = require("../src/services/character/identityService");
const dyn = require("../src/services/character/relationshipDynamicsService");
const planner = require("../src/services/character/lifePlannerService");
const tick = require("../src/services/character/lifeBeatTickService");
const ctx = require("../src/services/character/characterContextBuilder");

let passed = 0;
let failed = 0;
const TS = `t_cc_lb_${Date.now()}_${process.pid}`;

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

function makeAid(suffix) { return `${TS}_${suffix}`; }

function setupAssistant(aid, { allowProactive = 1, allowAutoLife = 1 } = {}) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO assistant_profile (assistant_id, character_name, character_background, allow_auto_life, allow_proactive_message, assistant_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(aid, aid, "普通上班族", allowAutoLife, allowProactive, "character", now, now);
  cs.ensureDefaultState(aid);
  idsvc.ensureDefaultIdentity(aid);
  dyn.ensureRelationshipState(aid);
}

function insertTurn(aid, role, content, createdAt) {
  db.prepare(
    "INSERT OR IGNORE INTO conversation_turns (id, assistant_id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(`turn_${aid}_${createdAt}_${role}`, aid, `s_${aid}`, role, content, createdAt);
}

function cleanupAll() {
  const tables = [
    "character_life_beat", "character_journal", "character_behavior_journal",
    "memory_items", "memory_facts", "memory_vectors", "memory_edges",
    "memory_audit_log", "memory_retrieval_log",
    "proactive_plans", "conversation_turns", "outbox_events",
    "relationship_event", "relationship_state", "character_identity",
    "character_state", "assistant_profile",
  ];
  for (const t of tables) {
    try { db.prepare(`DELETE FROM ${t} WHERE assistant_id LIKE ?`).run(`${TS}_%`); } catch {}
  }
}

(async () => {

// ── Suite 1: db.js life_beat CRUD ───────────────────────────────────
console.log("\n[Suite 1] life_beat CRUD");
{
  const aid = makeAid("crud");
  setupAssistant(aid);
  const now = Date.now();

  const id1 = dbModule.insertLifeBeat({
    assistantId: aid,
    planDate: "2026-05-24",
    scheduledAt: now - 60000,
    activity: "在公司楼下买冰美式",
    beatType: "anchored",
    reachSeed: "ta 上次提想试燕麦拿铁",
    importance: 0.7,
  });
  assert(id1 > 0, `insert returned id > 0 (got ${id1})`);

  // UNIQUE 阻挡同 (assistant, date, scheduled) 重复
  dbModule.insertLifeBeat({
    assistantId: aid, planDate: "2026-05-24", scheduledAt: now - 60000,
    activity: "dup", beatType: "autonomous", importance: 0.3,
  });
  const onlyOne = dbModule.listLifeBeatsForDate({ assistantId: aid, planDate: "2026-05-24" });
  assert(onlyOne.length === 1, `UNIQUE 阻挡重复 (got ${onlyOne.length} rows)`);

  // invalid beat_type 抛错
  let threw = false;
  try {
    dbModule.insertLifeBeat({
      assistantId: aid, planDate: "2026-05-24", scheduledAt: now + 1000,
      activity: "x", beatType: "invalid", importance: 0.5,
    });
  } catch { threw = true; }
  assert(threw, "invalid beat_type 抛错");

  // listPendingLifeBeats 只返到点 + status=pending
  const futureId = dbModule.insertLifeBeat({
    assistantId: aid, planDate: "2026-05-24", scheduledAt: now + 60 * 60 * 1000,
    activity: "future beat", beatType: "autonomous", importance: 0.3,
  });
  const pending = dbModule.listPendingLifeBeats({ now, limit: 50 });
  const pendingForAid = pending.filter((b) => b.assistant_id === aid);
  assert(pendingForAid.length === 1, `pending 只含到点的 (got ${pendingForAid.length})`);
  assert(pendingForAid[0].id === id1, "到点的是 id1");

  // markBeatActivated
  dbModule.markBeatActivated({ beatId: id1, memoryItemId: "fake-mem-id" });
  const after = dbModule.listLifeBeatsForDate({ assistantId: aid, planDate: "2026-05-24" });
  const beat1 = after.find((b) => b.id === id1);
  assert(beat1.status === "activated", `markActivated 改 status (got ${beat1.status})`);
  assert(beat1.memory_item_id === "fake-mem-id", "memory_item_id 写入");
  assert(beat1.activated_at != null, "activated_at 写入");

  // 已 activated → noop
  dbModule.markBeatActivated({ beatId: id1, memoryItemId: "new-mem" });
  const after2 = dbModule.listLifeBeatsForDate({ assistantId: aid, planDate: "2026-05-24" });
  const beat1b = after2.find((b) => b.id === id1);
  assert(beat1b.memory_item_id === "fake-mem-id", "已 activated 的 beat 不被二次覆盖");

  // markBeatSkipped
  dbModule.markBeatSkipped({ beatId: futureId });
  const after3 = dbModule.listLifeBeatsForDate({ assistantId: aid, planDate: "2026-05-24" });
  assert(after3.find((b) => b.id === futureId).status === "skipped", "markSkipped 改 status");

  // getLatestActivatedLifeBeat —— 把 activated_at 移到 10min 前测窗口边界
  db.prepare("UPDATE character_life_beat SET activated_at = ? WHERE id = ?")
    .run(now - 10 * 60 * 1000, id1);
  const latest = dbModule.getLatestActivatedLifeBeat({ assistantId: aid, withinMs: 60 * 60 * 1000, now });
  assert(latest && latest.id === id1, "getLatestActivated 返回 1h 窗内 activated");
  const latestNarrow = dbModule.getLatestActivatedLifeBeat({ assistantId: aid, withinMs: 5 * 60 * 1000, now });
  assert(latestNarrow == null, "withinMs=5min 窗口外（activated_at=10min 前）返回 null");

  // countActivatedAnchoredBeatsSince
  const c1 = dbModule.countActivatedAnchoredBeatsSince({ assistantId: aid, sinceMs: now - 24 * 3600 * 1000 });
  assert(c1 === 1, `count 24h 内 anchored activated = 1 (got ${c1})`);

  // expireStaleLifeBeats
  dbModule.insertLifeBeat({
    assistantId: aid, planDate: "2026-05-23", scheduledAt: now - 24 * 3600 * 1000,
    activity: "yesterday's pending", beatType: "autonomous", importance: 0.3,
  });
  const expired = dbModule.expireStaleLifeBeats({ beforePlanDate: "2026-05-24" });
  assert(expired >= 1, `expired ≥ 1 (got ${expired})`);

  // hasLifePlanForDate
  assert(dbModule.hasLifePlanForDate({ assistantId: aid, planDate: "2026-05-24" }), "hasPlan for today");
  assert(!dbModule.hasLifePlanForDate({ assistantId: aid, planDate: "2026-06-01" }), "no plan for future date");

  // deleteLifeBeatsForDate
  const deleted = dbModule.deleteLifeBeatsForDate({ assistantId: aid, planDate: "2026-05-24" });
  assert(deleted >= 2, `delete returns count (got ${deleted})`);
  assert(!dbModule.hasLifePlanForDate({ assistantId: aid, planDate: "2026-05-24" }), "after delete hasPlan=false");
}

// ── Suite 2: planner 服务边界 ────────────────────────────────────────
console.log("\n[Suite 2] planner service boundaries (no LLM)");
{
  assert(typeof planner.hasLifePlanForDate === "function", "exports hasLifePlanForDate");
  assert(typeof planner.generateLifePlanFor === "function", "exports generateLifePlanFor");
  assert(typeof planner.runDailyLifePlanTick === "function", "exports runDailyLifePlanTick");

  // 不存在的 assistant → no_profile（在 LLM 调用前 short-circuit）
  const out1 = await planner.generateLifePlanFor({ assistantId: `nonexistent_${TS}` });
  assert(out1.ok === false && out1.reason === "no_profile",
    `unknown assistant → no_profile (got ${JSON.stringify(out1)})`);

  // 已有 plan + 非 force → already_planned skip（在 LLM 调用前 short-circuit）
  const aid = makeAid("planned");
  setupAssistant(aid);
  dbModule.insertLifeBeat({
    assistantId: aid, planDate: "2099-01-01", scheduledAt: Date.now() + 10000,
    activity: "fake plan exists", beatType: "autonomous", importance: 0.3,
  });
  const out2 = await planner.generateLifePlanFor({ assistantId: aid, planDate: "2099-01-01" });
  assert(out2.ok === false && out2.skipped === "already_planned",
    `已有 plan + 非 force → already_planned (got ${JSON.stringify(out2)})`);

  // listAutoLifeAssistantProfiles 能扫到 allow_auto_life=1 的角色（runDailyLifePlanTick 的入口）
  const autoLife = dbModule.listAutoLifeAssistantProfiles();
  const inList = autoLife.some((p) => p.assistant_id === aid);
  assert(inList, "allow_auto_life=1 的角色被 listAutoLifeAssistantProfiles 扫到");
}

// ── Suite 3: lifeBeatTickService 决策树 ──────────────────────────────
console.log("\n[Suite 3] tick service decision tree");
{
  // 3.a autonomous beat → 落 memory_type=life_event_autonomous + 不触发 proactive
  const aid_a = makeAid("auto");
  setupAssistant(aid_a);
  const now = Date.now();
  const beatA = dbModule.insertLifeBeat({
    assistantId: aid_a, planDate: "2026-05-24", scheduledAt: now - 1000,
    activity: "在便利店买冰镇汽水", beatType: "autonomous", importance: 0.5,
  });
  // 通过 listPendingLifeBeats 拿到完整 beat row，喂给 processBeat
  const due_a = dbModule.listPendingLifeBeats({ now: now + 1, limit: 10 })
    .filter((b) => b.id === beatA);
  assert(due_a.length === 1, "beat A pending");
  const r_a = await tick.processBeat(due_a[0], { now });
  assert(r_a.status === "activated", "autonomous beat activated");
  assert(r_a.proactive.triggered === false, "autonomous beat 不触发 proactive");
  assert(r_a.proactive.reason === "autonomous_no_trigger", `reason=autonomous_no_trigger (got ${r_a.proactive.reason})`);
  // 验证落进了 memory_items 且 type 正确
  const memRow = db.prepare("SELECT memory_type FROM memory_items WHERE id = ?").get(r_a.memoryItemId);
  assert(memRow?.memory_type === "life_event_autonomous", `memory_type=life_event_autonomous (got ${memRow?.memory_type})`);

  // 3.b anchored + importance < 0.5 → 落 memory_type=life_event 但不触发 proactive
  const aid_b = makeAid("low_imp");
  setupAssistant(aid_b);
  const beatB = dbModule.insertLifeBeat({
    assistantId: aid_b, planDate: "2026-05-24", scheduledAt: now - 1000,
    activity: "路过 她 上次提的咖啡店", beatType: "anchored",
    reachSeed: "ta 上次提那家店", importance: 0.4,
  });
  const due_b = dbModule.listPendingLifeBeats({ now: now + 1, limit: 50 })
    .filter((b) => b.id === beatB);
  const r_b = await tick.processBeat(due_b[0], { now });
  assert(r_b.status === "activated", "low-imp anchored activated");
  assert(r_b.proactive.triggered === false, "imp<0.5 不触发 proactive");
  assert(r_b.proactive.reason === "importance_below_threshold",
    `reason=importance_below_threshold (got ${r_b.proactive.reason})`);
  const memRowB = db.prepare("SELECT memory_type FROM memory_items WHERE id = ?").get(r_b.memoryItemId);
  assert(memRowB?.memory_type === "life_event", `anchored → memory_type=life_event (got ${memRowB?.memory_type})`);

  // 3.c anchored + importance≥0.5 + chat_active → skip proactive
  const aid_c = makeAid("chat_active");
  setupAssistant(aid_c);
  insertTurn(aid_c, "user", "在吗", now - 60 * 1000); // 1min ago → chat 活跃
  assert(tick.isChatActive(aid_c, now) === true, "isChatActive=true 1min 内有 turn");
  const beatC = dbModule.insertLifeBeat({
    assistantId: aid_c, planDate: "2026-05-24", scheduledAt: now - 1000,
    activity: "在公司开会", beatType: "anchored", reachSeed: "x", importance: 0.7,
  });
  const due_c = dbModule.listPendingLifeBeats({ now: now + 1, limit: 50 })
    .filter((b) => b.id === beatC);
  const r_c = await tick.processBeat(due_c[0], { now });
  assert(r_c.status === "activated", "anchored chat-active activated");
  assert(r_c.proactive.triggered === false, "chat active → 不触发 proactive");
  assert(r_c.proactive.reason === "chat_active", `reason=chat_active (got ${r_c.proactive.reason})`);

  // 3.d proactive 禁用 → skip proactive
  const aid_d = makeAid("proac_off");
  setupAssistant(aid_d, { allowProactive: 0 });
  const beatD = dbModule.insertLifeBeat({
    assistantId: aid_d, planDate: "2026-05-24", scheduledAt: now - 1000,
    activity: "公司楼下", beatType: "anchored", reachSeed: "x", importance: 0.7,
  });
  const due_d = dbModule.listPendingLifeBeats({ now: now + 1, limit: 50 })
    .filter((b) => b.id === beatD);
  const r_d = await tick.processBeat(due_d[0], { now });
  assert(r_d.proactive.triggered === false, "proactive disabled → 不触发");
  assert(r_d.proactive.reason === "proactive_disabled",
    `reason=proactive_disabled (got ${r_d.proactive.reason})`);

  // 3.e 24h 软 cap：手动把 anchored count 拉高到 cap+1，再触发
  const aid_e = makeAid("cap");
  setupAssistant(aid_e);
  // 插入 5 个已 activated 的 anchored beat（cap 默认 4）
  for (let i = 0; i < 5; i++) {
    const bid = dbModule.insertLifeBeat({
      assistantId: aid_e, planDate: "2026-05-24", scheduledAt: now - (i + 2) * 60 * 1000,
      activity: `pre activated ${i}`, beatType: "anchored", reachSeed: "x", importance: 0.7,
    });
    dbModule.markBeatActivated({ beatId: bid, memoryItemId: `pre_${i}`, activatedAt: now - (i + 1) * 1000 });
  }
  const count = dbModule.countActivatedAnchoredBeatsSince({
    assistantId: aid_e, sinceMs: now - 24 * 3600 * 1000,
  });
  assert(count === 5, `预置 5 条已 activated anchored (got ${count})`);

  const beatE = dbModule.insertLifeBeat({
    assistantId: aid_e, planDate: "2026-05-24", scheduledAt: now - 100,
    activity: "再来一个", beatType: "anchored", reachSeed: "x", importance: 0.7,
  });
  const due_e = dbModule.listPendingLifeBeats({ now: now + 1, limit: 50 })
    .filter((b) => b.id === beatE);
  const r_e = await tick.processBeat(due_e[0], { now });
  assert(r_e.proactive.triggered === false, "24h cap 命中 → 不触发");
  assert(r_e.proactive.reason === "24h_soft_cap",
    `reason=24h_soft_cap (got ${r_e.proactive.reason})`);

  // 3.f runLifeBeatTickOnce 聚合调用 —— scanned 数量、不抛错
  const r_tick = await tick.runLifeBeatTickOnce({ now: now + 2 });
  assert(typeof r_tick.scanned === "number", "tick 返回 scanned");
  assert(typeof r_tick.activated === "number", "tick 返回 activated");
}

// ── Suite 4: characterContextBuilder beat 注入 ─────────────────────
console.log("\n[Suite 4] context builder beat injection");
{
  const aid = makeAid("ctx");
  setupAssistant(aid);
  const now = Date.now();

  // 没 beat → currentBeat=null，prefill 无 "刚才/此刻"
  let r = ctx.buildCharacterContext(aid, { now });
  assert(r.currentBeat === null, "无 beat → currentBeat=null");
  assert(!/我此刻在|我刚才/.test(r.assistantPrefill || ""), "prefill 无 beat 句");

  // 30min 内 anchored beat + importance 0.6 → "我此刻在 X，想到了你"
  const bid1 = dbModule.insertLifeBeat({
    assistantId: aid, planDate: "2026-05-24", scheduledAt: now - 10 * 60 * 1000,
    activity: "公司楼下买冰美式", beatType: "anchored",
    reachSeed: "ta 上次提想试", importance: 0.6,
  });
  dbModule.markBeatActivated({ beatId: bid1, memoryItemId: "ctx_mem_1", activatedAt: now - 10 * 60 * 1000 });
  r = ctx.buildCharacterContext(aid, { now });
  assert(r.currentBeat && r.currentBeat.activity === "公司楼下买冰美式", "currentBeat in payload");
  assert(/我此刻在公司楼下买冰美式/.test(r.assistantPrefill || ""), "prefill 含'我此刻在...'");
  assert(/想到了你/.test(r.assistantPrefill || ""), "anchored beat 含'想到了你'");

  // activity 以"在"开头不出现双"在"
  dbModule.deleteLifeBeatsForDate({ assistantId: aid, planDate: "2026-05-24" });
  const bid2 = dbModule.insertLifeBeat({
    assistantId: aid, planDate: "2026-05-24", scheduledAt: now - 10 * 60 * 1000,
    activity: "在便利店买饮料", beatType: "anchored",
    reachSeed: "x", importance: 0.6,
  });
  dbModule.markBeatActivated({ beatId: bid2, memoryItemId: "ctx_mem_2", activatedAt: now - 10 * 60 * 1000 });
  r = ctx.buildCharacterContext(aid, { now });
  assert(!/我此刻在在/.test(r.assistantPrefill || ""), "不出现'我此刻在在'双在");
  assert(/我此刻在便利店买饮料/.test(r.assistantPrefill || ""), "'我此刻在' + '在便利店...' 拼合");

  // 1.5h 前 → "我刚才..."
  db.prepare("UPDATE character_life_beat SET activated_at = ? WHERE id = ?")
    .run(now - 1.5 * 60 * 60 * 1000, bid2);
  r = ctx.buildCharacterContext(aid, { now });
  assert(/我刚才/.test(r.assistantPrefill || ""), "1.5h 前 → '我刚才'");
  assert(!/我此刻/.test(r.assistantPrefill || ""), "1.5h 前不应有'我此刻'");

  // autonomous beat：无"想到了你"
  dbModule.deleteLifeBeatsForDate({ assistantId: aid, planDate: "2026-05-24" });
  const bid3 = dbModule.insertLifeBeat({
    assistantId: aid, planDate: "2026-05-24", scheduledAt: now - 5 * 60 * 1000,
    activity: "在地铁上发呆", beatType: "autonomous", importance: 0.5,
  });
  dbModule.markBeatActivated({ beatId: bid3, memoryItemId: "ctx_mem_3", activatedAt: now - 5 * 60 * 1000 });
  r = ctx.buildCharacterContext(aid, { now });
  assert(/我此刻在地铁上发呆/.test(r.assistantPrefill || ""), "autonomous 渲染");
  assert(!/想到了你/.test(r.assistantPrefill || ""), "autonomous 无'想到了你'");

  // 2h+ stale → 窗口外不注入
  db.prepare("UPDATE character_life_beat SET activated_at = ? WHERE id = ?")
    .run(now - 3 * 60 * 60 * 1000, bid3);
  r = ctx.buildCharacterContext(aid, { now });
  assert(r.currentBeat === null, "3h 前 beat 超窗口");

  // importance < 0.4 → 不注入
  db.prepare("UPDATE character_life_beat SET activated_at = ?, importance = 0.3 WHERE id = ?")
    .run(now - 10 * 60 * 1000, bid3);
  r = ctx.buildCharacterContext(aid, { now });
  assert(r.currentBeat === null, "importance<0.4 不注入");
}

// ── Suite 5: healthy_relationship 段（identity.tensions.intimacy_vs_independence） ──
console.log("\n[Suite 5] healthy_relationship fragment");
{
  const render = ctx.renderHealthyRelationshipFragment;

  // 底线段：所有 tension 值共享
  const baseline = [
    "让 她 离不开你", // 目标声明
    "不替 她 决定",
    "跟真人聊的事",
    "「只有你懂我」",
    "温柔地不顺从",
    "你不知道的事就说不知道",
  ];

  function assertBaseline(frag, label) {
    for (const phrase of baseline) {
      assert(frag.includes(phrase), `${label}: 含底线条目「${phrase}」`);
    }
  }

  // identity=null → 走默认 0.5（平衡）
  const fragNull = render(null);
  assertBaseline(fragNull, "null identity");
  assert(/平衡/.test(fragNull), "null identity → 平衡风格尾句");

  // 0.2 偏独立
  const frag02 = render({ tensions: { intimacy_vs_independence: 0.2 } });
  assertBaseline(frag02, "tension=0.2");
  assert(/天性偏独立/.test(frag02), "tension=0.2 → 偏独立风格尾句");
  assert(!/紧密不等于占有/.test(frag02), "tension=0.2 不出现亲密风格句");

  // 0.5 平衡
  const frag05 = render({ tensions: { intimacy_vs_independence: 0.5 } });
  assert(/温柔陪伴/.test(frag05), "tension=0.5 → 平衡风格尾句");

  // 0.7 偏亲密
  const frag07 = render({ tensions: { intimacy_vs_independence: 0.7 } });
  assert(/紧密不等于占有/.test(frag07), "tension=0.7 → 偏亲密风格尾句");

  // 0.9 极亲密 —— 关键：仍守底线 + 警告"让 她 依赖"
  const frag09 = render({ tensions: { intimacy_vs_independence: 0.9 } });
  assertBaseline(frag09, "tension=0.9");
  assert(/正因如此/.test(frag09), "tension=0.9 → 极亲密风格尾句");
  assert(/让 她 依赖/.test(frag09), "tension=0.9 必须警告\"让 她 依赖\"");

  // identity 有 tensions 但没 intimacy_vs_independence → fallback 0.5
  const fragMissing = render({ tensions: { stability_vs_novelty: 0.8 } });
  assert(/温柔陪伴/.test(fragMissing), "其他 tension 存在但缺 intimacy → fallback 平衡");

  // 注入到 chat hot path 的 slots.constraints（产品级 prior，不依赖 layer flag）
  const aid = makeAid("hr_inject");
  setupAssistant(aid);
  const ctxResult = ctx.buildCharacterContext(aid, { now: Date.now() });
  const constraintsSlot = (ctxResult.slots && ctxResult.slots.constraints) || "";
  assert(/<constraints>/.test(constraintsSlot), "constraints slot 有 <constraints> 包裹");
  assert(/让 她 离不开你/.test(constraintsSlot), "constraints slot 含「让 她 离不开你」底线声明");
  assert(/不替 她 决定/.test(constraintsSlot), "constraints slot 含「不替 她 决定」底线");
  assert(/跟真人聊的事/.test(constraintsSlot), "constraints slot 含「跟真人聊的事」底线");

  // admin lean fallback path（buildSystemSegment）也要有
  const profile = require("../src/db").getAssistantProfile(aid);
  const identity = require("../src/services/character/identityService").getCharacterIdentity(aid);
  const sysSeg = ctx.buildSystemSegment({ identity, profile });
  assert(/<healthy_relationship>/.test(sysSeg), "buildSystemSegment 含 <healthy_relationship> 标签");
  assert(/让 她 离不开你/.test(sysSeg), "buildSystemSegment 含底线声明");
}

cleanupAll();
console.log("\n──────────────────────────────────────────────────");
console.log(`结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

})().catch((err) => {
  console.error("test runner error:", err);
  cleanupAll();
  process.exit(1);
});
