#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * 模拟 Android 客户端真实调用 pipeline，看 AI 在不同问题下的真实回答。
 *
 * 流程：
 *   1. GET /api/relationship/state           取角色情绪/关系
 *   2. POST /api/tool/memory-recall          取相关记忆（含/不含 dateString）
 *   3. 直接调本地 Qwen LLM 用 system prompt + memories 生成回答
 *
 * 用例：
 *   node scripts/test-ai-replies.js
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const ASSISTANT_ID = "d244644b-e851-416a-ad98-b557fb991b99"; // 金琉宵
const SESSION_ID = "test-ai-reply-" + Date.now();
const API = "http://192.168.5.7:8787";
const KEY = "dev-local-key";

const { db } = require("../src/db");
const { getProvider } = require("../src/llm");

async function postJson(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "x-api-key": KEY, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function getJson(path) {
  const res = await fetch(`${API}${path}`, { headers: { "x-api-key": KEY } });
  return res.json();
}

function buildSystemPrompt({ profile, relationshipState, memories, antiHallucination }) {
  const lines = [];
  lines.push(`你是"${profile.character_name || profile.assistant_id}"。`);
  if (profile.character_background) {
    lines.push(`【人设背景】\n${profile.character_background}\n`);
  }
  if (relationshipState) {
    const m = relationshipState.mood;
    const r = relationshipState.relationship;
    lines.push(`【你当前状态】情绪 ${m.emotionZh}（${m.emotionEn}, 强度 ${Math.round(m.intensity*100)}%, valence ${m.valence}），关系 ${r.levelName}（第 ${r.level} 级），亲密分 ${r.intimacyScore}/200，总轮次 ${r.totalTurns}`);
  }
  if (memories && memories.length) {
    lines.push("【从记忆里检索到的相关片段（按时间倒序，仅限真实记录）】");
    for (const mem of memories) {
      const t = new Date(mem.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
      lines.push(`  - [${t}] ${mem.content.slice(0, 100)}`);
    }
  } else {
    lines.push("【相关记忆】没有检索到与该问题相关的真实记录。");
  }
  if (antiHallucination) {
    lines.push("");
    lines.push('【硬规则】如果上面"相关记忆"为空或与用户问题不匹配，直接告诉用户"我那段时间没有具体记录"——禁止编造你没有的记忆。回复 30-100 字。');
  } else {
    lines.push("");
    lines.push("回复 30-100 字。");
  }
  return lines.join("\n");
}

async function runQuery({ label, userInput, useDateString = null, withAntiHallucination = true }) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`【${label}】`);
  console.log(`USER: ${userInput}`);
  if (useDateString) console.log(`(传 dateString=${useDateString})`);

  // 1. relationshipState
  const rs = await getJson(`/api/relationship/state?assistantId=${ASSISTANT_ID}`);
  // 2. memory-recall
  const recallBody = {
    assistantId: ASSISTANT_ID,
    query: userInput,
    topK: 6,
    sessionId: SESSION_ID,
    source: "all",
  };
  if (useDateString) recallBody.dateString = useDateString;
  const recallResp = await postJson("/api/tool/memory-recall", recallBody);
  const memories = recallResp.memories || [];
  console.log(`检索: ${memories.length} 条候选`);
  for (const m of memories.slice(0, 3)) {
    const t = new Date(m.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    console.log(`  [${m.score.toFixed(3)}] ${t} ${m.content.slice(0, 60)}`);
  }
  if (memories.length > 3) console.log(`  ... ${memories.length - 3} more`);

  // 3. 拿 profile
  const profile = db.prepare("SELECT * FROM assistant_profile WHERE assistant_id = ?").get(ASSISTANT_ID);

  // 4. 构 prompt + 调 LLM
  const systemPrompt = buildSystemPrompt({
    profile,
    relationshipState: rs.relationshipState,
    memories,
    antiHallucination: withAntiHallucination,
  });
  const { content } = await getProvider().complete({
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userInput },
    ],
    temperature: 0.7,
    maxTokens: 200,
  });
  console.log(`AI: ${content.trim()}`);
}

(async () => {
  // 健康检查
  const h = await getJson("/api/health");
  if (!h.ok) { console.error("server unhealthy"); process.exit(1); }
  console.log("server OK");

  // Test 1: 老的失败 query — 不传 dateString（重现事故场景）
  await runQuery({
    label: "Test 1：3月13日 — 不传 dateString（模拟旧客户端）",
    userInput: "你还记得我们3月13日初见的场景，发生了什么吗",
    useDateString: null,
  });

  // Test 2: 同问题 + dateString（模拟新客户端，按手册改造）
  await runQuery({
    label: "Test 2：3月13日 — 传 dateString=2026-03-13（按新手册）",
    userInput: "你还记得我们3月13日初见的场景，发生了什么吗",
    useDateString: "2026-03-13",
  });

  // Test 3: 偏好查询
  await runQuery({
    label: "Test 3：偏好类查询（无日期）",
    userInput: "你还记得我之前提到过的爱好或喜好吗",
  });

  // Test 4: 关系问题
  await runQuery({
    label: "Test 4：关系查询",
    userInput: "我们最近吵过架吗，是因为什么",
  });

  // Test 5: 不存在日期 — 验证反幻觉
  await runQuery({
    label: "Test 5：找一个根本没记录的日期，看是否敢编造",
    userInput: "你还记得我们 4 月 1 日聊了什么吗",
    useDateString: "2026-04-01",
  });

  process.exit(0);
})();
