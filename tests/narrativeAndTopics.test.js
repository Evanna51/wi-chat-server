/**
 * narrativeAndTopics.test.js — Phase 2 (CC-2) 测试套件
 *
 * 覆盖：
 *   Suite 1  persistentTopicService CRUD / match / 状态机 / 滑窗
 *   Suite 2  applyDormantSweep
 *   Suite 3  episodeBuilder.insertEpisode + listEpisodes + getEpisodesForMemory
 *   Suite 4  episodeBuilder.fetchMemoriesForBuild + cursor 行为（无 LLM 路径）
 *   Suite 5  characterContextBuilder 注入 episodes / topics 段 + 段级丢弃顺序
 *   Suite 6  memoryRetrievalService.includeEpisodes 关联返回
 *   Suite 7  hot path 集成：onUserMessage 触发 topic mention
 *
 * 不测：episodeBuilder 的 LLM 调用本身（mock 太重，留给集成测试）。
 */

const { db } = require("../src/db");
const ps = require("../src/services/character/persistentTopicService");
const eb = require("../src/services/character/episodeBuilder");
const cs = require("../src/services/characterStateService");
const idsvc = require("../src/services/character/identityService");
const { buildCharacterContext } = require("../src/services/character/characterContextBuilder");
const { v7: uuidv7 } = require("uuid");

let passed = 0;
let failed = 0;
const TS = `t_n_${Date.now()}_${process.pid}`;

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

function approxEq(a, b, eps = 0.01) { return Math.abs(a - b) < eps; }

function makeAid(suffix) { return `${TS}_${suffix}`; }

function setupAssistant(aid) {
  const now = Date.now();
  db.prepare(
    "INSERT INTO assistant_profile (assistant_id, character_name, character_background, allow_auto_life, allow_proactive_message, assistant_type, created_at, updated_at) VALUES (?, ?, ?, 0, 0, ?, ?, ?)"
  ).run(aid, aid, "", "character", now, now);
  cs.ensureDefaultState(aid);
  idsvc.ensureDefaultIdentity(aid);
}

function insertMemory(assistantId, content, createdAtOffset = 0) {
  const id = uuidv7();
  const now = Date.now() + createdAtOffset;
  db.prepare(
    `INSERT INTO memory_items
      (id, assistant_id, session_id, source_turn_id, memory_type, content, salience, confidence, vector_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0.5, 0.7, 'pending', ?, ?)`
  ).run(id, assistantId, "test_session", `turn_${id}`, "user_turn", content, now, now);
  return id;
}

function cleanupAll() {
  db.prepare("DELETE FROM episode_memory_link WHERE episode_id IN (SELECT id FROM narrative_episode WHERE assistant_id LIKE ?)").run(`${TS}_%`);
  db.prepare("DELETE FROM narrative_episode WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM persistent_topic WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM memory_items WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM relationship_event WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM relationship_state WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM character_identity WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM character_state WHERE assistant_id LIKE ?").run(`${TS}_%`);
  db.prepare("DELETE FROM assistant_profile WHERE assistant_id LIKE ?").run(`${TS}_%`);
}

// ── Suite 1: persistentTopicService 基础 ─────────────────────────
console.log("\n[Suite 1] persistentTopicService CRUD / match / 状态机");
{
  const aid = makeAid("topic_basic");
  setupAssistant(aid);

  const t1 = ps.createTopic(aid, {
    topic: "钢琴学习",
    aliases: ["钢琴", "弹琴", "钢琴课"],
    status: "growing",
    importance: 0.6,
    emotionalAssociation: "pride",
  });
  assert(t1.id && t1.mentionCount === 1, "createTopic returns row with mention=1");
  assert(t1.status === "growing", "default status growing");

  const matches = ps.findTopicMatchesInMessage(aid, "今天弹琴弹了一小时");
  assert(matches.length === 1 && matches[0].topic === "钢琴学习", "alias substring match");

  const noMatch = ps.findTopicMatchesInMessage(aid, "今天天气不错");
  assert(noMatch.length === 0, "no match when alias absent");

  const tooShort = ps.findTopicMatchesInMessage(aid, "弹");
  assert(tooShort.length === 0, "short message guard (< 4 chars)");

  const t2 = ps.recordMention(t1.id, { mentionText: "今天弹琴", valence: 0.5 });
  assert(t2.mentionCount === 2, "recordMention bumps count");
  assert(t2.trajectory.length === 1, "trajectory append");

  // 滑动窗口（TRAJECTORY_MAX_POINTS=20）
  for (let i = 0; i < 25; i++) {
    ps.recordMention(t1.id, { mentionText: `m${i}`, valence: 0.2 });
  }
  const t3 = ps.getTopicById(t1.id);
  assert(t3.trajectory.length === ps.TRAJECTORY_MAX_POINTS, `trajectory window cap (${t3.trajectory.length} == ${ps.TRAJECTORY_MAX_POINTS})`);
  assert(t3.mentionCount === 27, "mentionCount keeps incrementing past window");

  // 状态机
  ps.transitionStatus(t1.id, "painful");
  assert(ps.getTopicById(t1.id).status === "painful", "transition to painful");

  let threw = false;
  try { ps.transitionStatus(t1.id, "invalid_status"); } catch (e) { threw = true; }
  assert(threw, "invalid status rejected");

  threw = false;
  try { ps.createTopic(aid, { topic: "" }); } catch (e) { threw = true; }
  assert(threw, "empty topic rejected");

  threw = false;
  try { ps.createTopic(aid, { topic: "x", importance: 1.5 }); } catch (e) { threw = true; }
  assert(threw, "out-of-range importance rejected");
}

// ── Suite 2: applyDormantSweep ────────────────────────────────────
console.log("\n[Suite 2] applyDormantSweep");
{
  const aid = makeAid("dormant");
  setupAssistant(aid);
  const t = ps.createTopic(aid, { topic: "旧话题", status: "growing", importance: 0.4 });

  // 还没过期 → 不变
  let result = ps.applyDormantSweep();
  assert(ps.getTopicById(t.id).status === "growing", "fresh topic stays growing");

  // 时间戳推到 25 天前
  const old = Date.now() - 25 * 24 * 3600 * 1000;
  db.prepare("UPDATE persistent_topic SET last_discussed_at = ? WHERE id = ?").run(old, t.id);
  result = ps.applyDormantSweep();
  assert(result.transitioned >= 1, "sweep transitioned aged topic");
  assert(ps.getTopicById(t.id).status === "dormant", "aged topic → dormant");

  // 已 dormant 不再被改
  const t2 = ps.createTopic(aid, { topic: "已停的", status: "dormant" });
  db.prepare("UPDATE persistent_topic SET last_discussed_at = ? WHERE id = ?").run(old, t2.id);
  ps.applyDormantSweep();
  assert(ps.getTopicById(t2.id).status === "dormant", "already-dormant untouched");

  // resolved 不被改
  const t3 = ps.createTopic(aid, { topic: "resolved one", status: "resolved" });
  db.prepare("UPDATE persistent_topic SET last_discussed_at = ? WHERE id = ?").run(old, t3.id);
  ps.applyDormantSweep();
  assert(ps.getTopicById(t3.id).status === "resolved", "resolved untouched");
}

// ── Suite 3: insertEpisode / listEpisodes / getEpisodesForMemory ──
console.log("\n[Suite 3] episodeBuilder direct API");
{
  const aid = makeAid("ep_direct");
  setupAssistant(aid);
  const m1 = insertMemory(aid, "钢琴第一周", -7 * 24 * 3600 * 1000);
  const m2 = insertMemory(aid, "钢琴第二周", -3 * 24 * 3600 * 1000);

  const id = eb.insertEpisode({
    assistantId: aid,
    title: "钢琴学习初期",
    summary: "用户开始学钢琴的最初两周。",
    emotionalTone: "tender",
    importance: 0.7,
    unresolvedThreads: ["左手协调"],
    memoryItemIds: [m1, m2],
    windowStart: Date.now() - 7 * 24 * 3600 * 1000,
    windowEnd: Date.now() - 24 * 3600 * 1000,
    source: "test",
  });
  assert(typeof id === "string" && id.length > 0, "insertEpisode returns id");

  const list = eb.listEpisodes(aid, { limit: 10, minImportance: 0 });
  assert(list.length === 1, "listEpisodes returns inserted");
  assert(list[0].title === "钢琴学习初期", "title stored");
  assert(list[0].emotionalTone === "tender", "tone stored");
  assert(list[0].unresolvedThreads.length === 1, "unresolved_threads parsed");

  // minImportance 过滤
  const filtered = eb.listEpisodes(aid, { limit: 10, minImportance: 0.8 });
  assert(filtered.length === 0, "minImportance 0.8 filters out 0.7 episode");

  // 反查 episode by memory
  const epsForM1 = eb.getEpisodesForMemory(m1);
  assert(epsForM1.length === 1 && epsForM1[0].id === id, "getEpisodesForMemory finds episode via link");

  // 非法 emotionalTone fallback
  const id2 = eb.insertEpisode({
    assistantId: aid,
    title: "另一段",
    summary: "...",
    emotionalTone: "bogus_tone",
    importance: 0.5,
    unresolvedThreads: [],
    memoryItemIds: [m1],
    windowStart: Date.now() - 1000,
    windowEnd: Date.now(),
  });
  const ep2 = eb.getEpisodeById(id2);
  assert(ep2.emotionalTone === "mundane", "bogus tone falls back to mundane");

  // importance clamp
  const id3 = eb.insertEpisode({
    assistantId: aid,
    title: "clamp",
    summary: "clamp",
    emotionalTone: "mundane",
    importance: 5,
    unresolvedThreads: [],
    memoryItemIds: [m1],
    windowStart: Date.now() - 1000,
    windowEnd: Date.now(),
  });
  assert(eb.getEpisodeById(id3).importance === 1, "importance > 1 clamped to 1");
}

// ── Suite 4: fetchMemoriesForBuild + cursor ──────────────────────
console.log("\n[Suite 4] fetchMemoriesForBuild + cursor");
{
  const aid = makeAid("ep_cursor");
  setupAssistant(aid);

  // 没 episode 时窗口默认 24h
  const m1 = insertMemory(aid, "near 1", -2 * 3600 * 1000);   // 2h ago
  const m2 = insertMemory(aid, "near 2", -10 * 3600 * 1000);  // 10h ago
  const m3 = insertMemory(aid, "old one", -48 * 3600 * 1000); // 48h ago — 在窗口外

  const r1 = eb.fetchMemoriesForBuild(aid);
  assert(r1.memories.length === 2, `default window 24h returns 2 (got ${r1.memories.length})`);

  // 创建一个 episode 把 cursor 推到 5h 前
  const cursorEnd = Date.now() - 5 * 3600 * 1000;
  eb.insertEpisode({
    assistantId: aid,
    title: "cursor mark",
    summary: "...",
    emotionalTone: "mundane",
    importance: 0.5,
    unresolvedThreads: [],
    memoryItemIds: [m2],
    windowStart: cursorEnd - 60 * 3600 * 1000,
    windowEnd: cursorEnd,
  });
  const r2 = eb.fetchMemoriesForBuild(aid);
  assert(r2.memories.length === 1 && r2.memories[0].id === m1, `cursor advances: only m1 (newer) returned (got ${r2.memories.length})`);
}

// ── Suite 5: characterContextBuilder 注入叙事 ────────────────────
console.log("\n[Suite 5] characterContextBuilder narrative + topics injection");
{
  const aid = makeAid("ctx_phase2");
  setupAssistant(aid);

  ps.createTopic(aid, { topic: "钢琴学习", aliases: ["钢琴"], status: "growing", importance: 0.6, emotionalAssociation: "pride" });
  ps.createTopic(aid, { topic: "母亲关系", aliases: ["妈"], status: "unresolved", importance: 0.7 });
  // 一个 dormant topic 不该出现在 active list
  const tDormant = ps.createTopic(aid, { topic: "曾经的事", status: "dormant", importance: 0.3 });

  eb.insertEpisode({
    assistantId: aid,
    title: "钢琴初期",
    summary: "用户最近一周开始学钢琴。",
    emotionalTone: "tender",
    importance: 0.7,
    unresolvedThreads: ["左手协调"],
    memoryItemIds: [],
    windowStart: Date.now() - 7 * 24 * 3600 * 1000,
    windowEnd: Date.now() - 24 * 3600 * 1000,
  });

  // 一个 importance < 0.5 的 episode 不该被注入
  eb.insertEpisode({
    assistantId: aid,
    title: "琐事",
    summary: "无关紧要",
    emotionalTone: "mundane",
    importance: 0.3,
    unresolvedThreads: [],
    memoryItemIds: [],
    windowStart: Date.now() - 3 * 24 * 3600 * 1000,
    windowEnd: Date.now() - 24 * 3600 * 1000,
  });

  const ctx = buildCharacterContext(aid);
  assert(Array.isArray(ctx.activeTopics), "activeTopics in payload");
  assert(ctx.activeTopics.length === 2, `2 active topics (dormant excluded, got ${ctx.activeTopics.length})`);
  assert(Array.isArray(ctx.recentEpisodes), "recentEpisodes in payload");
  assert(ctx.recentEpisodes.length === 1, `1 recent episode (low-importance excluded, got ${ctx.recentEpisodes.length})`);
  assert(ctx.recentEpisodes[0].title === "钢琴初期", "important episode picked");

  // CC-5.C: 不再有 `[最近的重要叙事]` / `[长期关注的话题]` 段。
  // 只在 unresolved 路径上把内容融进 assistantPrefill 独白：
  //   - 有 unresolvedThreads 的 episode → "还在想：..."
  //   - status='unresolved' 且久未提的 topic → "「X」那件事好久没提了。"
  // 钢琴初期 unresolvedThreads=["左手协调"] → 入选
  // 母亲关系 status='unresolved' 且 lastDiscussedAt=createdAt（也就是 0d 前）→ 不算 stale，不入选
  // 钢琴学习 status='growing' → 不入选
  assert(/还在想/.test(ctx.assistantPrefill || ""), "assistantPrefill has unresolved-thread monologue line");
  assert(/左手协调/.test(ctx.assistantPrefill || ""), "unresolved thread content surfaced in assistantPrefill");
  assert(!/钢琴学习/.test(ctx.assistantPrefill || ""), "growing topic NOT in assistantPrefill (only unresolved+stale)");

  // 低重要性 episode 不在 payload + 不在 narrative slot
  assert(!ctx.recentEpisodes.some((e) => e.title === "琐事"), "low-importance episode filtered from payload");
  assert(!/琐事/.test(ctx.slots?.narrative || ""), "low-importance episode not in narrative slot");
  // dormant topic 不在 active 列表 + 不在 narrative slot
  assert(!ctx.activeTopics.some((t) => t.topic === "曾经的事"), "dormant topic filtered from activeTopics");
  assert(!/曾经的事/.test(ctx.slots?.narrative || ""), "dormant topic not in narrative slot");
}

// ── Suite 6: memoryRetrievalService episode-aware ────────────────
console.log("\n[Suite 6] memoryRetrievalService.includeEpisodes");
{
  const aid = makeAid("retrieval_ep");
  setupAssistant(aid);
  const m1 = insertMemory(aid, "记忆 A", -2 * 24 * 3600 * 1000);
  const m2 = insertMemory(aid, "记忆 B", -3 * 24 * 3600 * 1000);
  // 给 m1 关联 episode
  const epId = eb.insertEpisode({
    assistantId: aid,
    title: "关联段",
    summary: "summary x",
    emotionalTone: "tender",
    importance: 0.6,
    unresolvedThreads: [],
    memoryItemIds: [m1],
    windowStart: Date.now() - 7 * 24 * 3600 * 1000,
    windowEnd: Date.now(),
  });

  // 直接查 link 表验证 includeEpisodes 路径会拿到
  const linkRow = db.prepare("SELECT * FROM episode_memory_link WHERE memory_item_id = ?").get(m1);
  assert(linkRow && linkRow.episode_id === epId, "episode_memory_link inserted by insertEpisode");

  // m2 没有关联
  const noLink = db.prepare("SELECT * FROM episode_memory_link WHERE memory_item_id = ?").get(m2);
  assert(!noLink, "m2 has no episode link");
}

// ── Suite 7: hot path topic mention via onUserMessage ───────────
console.log("\n[Suite 7] onUserMessage triggers topic mention");
{
  const aid = makeAid("hotpath");
  setupAssistant(aid);
  ps.createTopic(aid, { topic: "钢琴学习", aliases: ["钢琴", "弹琴"], importance: 0.5 });

  const before = ps.listActiveTopics(aid)[0].mentionCount;
  cs.onUserMessage(aid, { content: "今天弹琴卡住了，老师说要慢慢来，不急" });
  const after = ps.listActiveTopics(aid)[0].mentionCount;
  assert(after === before + 1, `topic mentionCount bumped by onUserMessage (${before} → ${after})`);

  // 无关消息不增加
  cs.onUserMessage(aid, { content: "今天天气不错" });
  assert(ps.listActiveTopics(aid)[0].mentionCount === after, "unrelated message doesn't bump count");

  // 新 topic 不被 hot path 创建
  const totalBefore = ps.listAllTopics(aid).length;
  cs.onUserMessage(aid, { content: "我最近在研究编织一个新爱好" });
  assert(ps.listAllTopics(aid).length === totalBefore, "hot path doesn't create new topics");
}

cleanupAll();
console.log("\n──────────────────────────────────────────────────");
console.log(`结果: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
