/**
 * 记忆分类 + 质量评级单测
 * 用法: node tests/memoryClassification.test.js
 */
const { db } = require("../src/db");
const {
  classifyHeuristic,
  classifyAndPersist,
  backfillUnclassified,
  VALID_CATEGORIES,
  VALID_GRADES,
} = require("../src/services/memoryClassificationService");
const llm = require("../src/llm");
const { FakeProvider } = require("../src/llm/FakeProvider");

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

function cleanup() {
  db.prepare("DELETE FROM memory_items WHERE id LIKE 'test_mc_%' OR assistant_id LIKE 'test_mc_%'").run();
}

function insertTestMemory(suffix, content, opts = {}) {
  const id = `test_mc_${suffix}`;
  const now = Date.now();
  db.prepare(
    `INSERT INTO memory_items
       (id, assistant_id, session_id, source_turn_id, memory_type, content,
        salience, confidence, vector_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0.5, 0.7, 'pending', ?, ?)`
  ).run(
    id,
    `test_mc_aid_${suffix}`,
    `sess_${suffix}`,
    `turn_${suffix}_${now}`,
    opts.memoryType || "user_turn",
    content,
    now, now
  );
  return id;
}

async function main() {
  cleanup();

  // ── Suite 1: 启发式分类 ───────────────────────────────────
  console.log("\n[Suite 1] heuristic classification");
  const r1 = classifyHeuristic("我每周三晚上学钢琴");
  assert(r1?.category === "preferences", `每周/习惯 → preferences (got ${r1?.category})`);
  const r2 = classifyHeuristic("我妈最近老打电话来");
  assert(r2?.category === "relationship_info", `我妈 → relationship_info (got ${r2?.category})`);
  const r3 = classifyHeuristic("最近压力很大睡眠也不好");
  assert(r3?.category === "wellbeing", `压力/睡眠 → wellbeing (got ${r3?.category})`);
  const r4 = classifyHeuristic("嗯");
  assert(r4?.category === "chitchat", `嗯 → chitchat (got ${r4?.category})`);
  assert(r4?.quality === "D", `嗯 → quality D (got ${r4?.quality})`);
  const r5 = classifyHeuristic("我打算明年换工作");
  assert(r5?.category === "goals_plans", `打算 → goals_plans (got ${r5?.category})`);
  const r6 = classifyHeuristic("");
  assert(r6?.category === "chitchat" && r6?.quality === "E", `空消息 → chitchat E`);
  const r7 = classifyHeuristic("这世界真是奇妙啊");
  assert(r7 === null, `无规则命中 → null (got ${r7?.category ?? "null"})`);

  // ── Suite 2: classifyAndPersist 写回 DB ───────────────────
  console.log("\n[Suite 2] classifyAndPersist persistence");
  const id2 = insertTestMemory("persist1", "我喜欢喝乌龙茶");
  const res2 = await classifyAndPersist(id2, "我喜欢喝乌龙茶");
  assert(res2.ok === true, "persist returns ok");
  const row2 = db.prepare("SELECT memory_category, quality_grade, category_method FROM memory_items WHERE id = ?").get(id2);
  assert(row2.memory_category === "preferences", `DB: category=preferences (got ${row2.memory_category})`);
  assert(row2.category_method === "heuristic", `DB: method=heuristic (got ${row2.category_method})`);
  assert(VALID_GRADES.has(row2.quality_grade), `DB: grade in A-E (got ${row2.quality_grade})`);

  // ── Suite 3: non-user_turn 跳过 ─────────────────────────
  console.log("\n[Suite 3] skip non-user_turn memory_type");
  const id3 = insertTestMemory("skip1", "角色生活事件", { memoryType: "life_event" });
  const res3 = await classifyAndPersist(id3, "角色生活事件");
  assert(res3.skipped === "non_user_turn", `life_event 被跳过 (got ${res3.skipped})`);
  const row3 = db.prepare("SELECT memory_category FROM memory_items WHERE id = ?").get(id3);
  assert(row3.memory_category === null, `life_event memory_category 保持 NULL`);

  // ── Suite 4: 已分类幂等跳过 ──────────────────────────
  console.log("\n[Suite 4] idempotent skip already classified");
  const id4 = insertTestMemory("idem1", "我喜欢蓝色");
  await classifyAndPersist(id4, "我喜欢蓝色");
  const res4b = await classifyAndPersist(id4, "我喜欢蓝色");
  assert(res4b.skipped === "already_classified", `重复调用幂等跳过 (got ${res4b.skipped})`);

  // ── Suite 5: LLM fallback (FakeProvider 注入) ─────────
  console.log("\n[Suite 5] LLM fallback path");
  const fake = new FakeProvider();
  fake.setResponse(JSON.stringify({ category: "ideas", quality: "B", confidence: 0.8 }));
  llm._setProviderForTesting(fake);
  const id5 = insertTestMemory("llm1", "这世界真是奇妙啊");
  const res5 = await classifyAndPersist(id5, "这世界真是奇妙啊");
  assert(res5.ok && res5.method === "llm", `走了 LLM 路径 (got method=${res5.method})`);
  assert(res5.category === "ideas", `LLM 返回 ideas (got ${res5.category})`);
  llm._resetProviders();

  // ── Suite 6: backfillUnclassified 扫描 + 处理 ─────────
  console.log("\n[Suite 6] backfillUnclassified");
  insertTestMemory("bf1", "我妈昨天打电话");
  insertTestMemory("bf2", "嗯嗯");
  insertTestMemory("bf3", "今天压力好大");
  const resBf = await backfillUnclassified({ limit: 100 });
  assert(resBf.processed >= 3, `processed ≥ 3 (got ${resBf.processed})`);
  const remaining = db.prepare(
    "SELECT COUNT(*) AS c FROM memory_items WHERE memory_type='user_turn' AND memory_category IS NULL AND id LIKE 'test_mc_%'"
  ).get();
  assert(remaining.c === 0, `所有 test_mc 行已分类 (剩 ${remaining.c})`);

  // ── Suite 7: taxonomy 完整性 ─────────────────────────
  console.log("\n[Suite 7] taxonomy integrity");
  assert(VALID_CATEGORIES.size === 9, `9 大分类 (got ${VALID_CATEGORIES.size})`);
  assert(VALID_GRADES.size === 5, `5 级质量 A-E (got ${VALID_GRADES.size})`);

  cleanup();
  console.log(`\n${"─".repeat(50)}`);
  console.log(`结果: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
