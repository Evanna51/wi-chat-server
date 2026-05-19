/**
 * Voice Ablation v2 — 9 cases × 3 维度，4 个 system prompt 版本。
 *
 * 维度：
 *   D 日常交流         D1-D3
 *   E 情感波动大       E1-E3
 *   T 工具调用 / 引用过去 T1-T3
 *
 * 每维度选 1 个 cold_start = true（无 history，纯 system + user input），
 * 验证 NAKED 是否依赖 history 做 voice few-shot。
 *
 * 4 个版本：
 *   V1 NAKED   — 完全空 system prompt
 *   V2 ID_ONLY — 仅一句身份
 *   V3 LIGHT   — 身份 + 说话方式 + 3 个 voice 样本（从 identity.skills 抽） + 1 条反 AI tell
 *   V4 LEAN    — production composer：role+character+background(300 cap)+constraints+facts+narrative
 *                （drop tool_protocol，chat-only 不需要）
 *
 * 输出：tmp/voice-ablation-<ts>.md + .json
 */

require("dotenv").config();
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const { getAssistantProfile } = require("../src/db");
const { getCharacterIdentity } = require("../src/services/character/identityService");
const { buildCharacterContext } = require("../src/services/character/characterContextBuilder");
const { composeForChat } = require("../src/services/character/promptComposer");

// ── 配置 ─────────────────────────────────────────────────────────────
const ASSISTANT_ID = "d244644b-e851-416a-ad98-b557fb991b99"; // 金宵
const DB_PATH = "./data/character-behavior.db";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";
const API_KEY = process.env.DEEPSEEK_API_KEY;
const TEMPERATURE = 0.7;
const MAX_TOKENS = 600;
const REQUEST_DELAY_MS = 350;
const HISTORY_BACK = 4;

if (!API_KEY) {
  console.error("ERROR: DEEPSEEK_API_KEY not set in .env");
  process.exit(1);
}

// ── 9 段测试 case ─────────────────────────────────────────────────────
//
// turnTs = created_at 时间戳（DB 主键 row 的 created_at），用 created_at + role=user 定位
// coldStart = true → 跑时不带 history，仅 system + user
const CASES = [
  // === D 日常交流 ===
  { code: "D1", label: "D1_短探询", turnTs: null, fallbackInput: "在吗",                    coldStart: true  },
  { code: "D2", label: "D2_抱怨累",  turnTs: null, fallbackInput: "今天好累",                coldStart: false },
  { code: "D3", label: "D3_关心",    turnTs: 1773458362953, fallbackInput: "你没睡觉吗",     coldStart: false },

  // === E 情感波动大 ===
  { code: "E1", label: "E1_短质问",  turnTs: 1778388829014, fallbackInput: "所以 我们是朋友，但是，你不想听我聊聊我的事情？这让我觉得很奇怪", coldStart: false },
  { code: "E2", label: "E2_慌乱",    turnTs: 1778263744421, fallbackInput: "不 只是我慌了... 或许我现在该挂断电话了", coldStart: true },
  { code: "E3", label: "E3_愤怒边界", turnTs: 1773510811054, fallbackInput: "我讨厌心理咨询，尤其在我得了精神问题之后。精神是精神，心理是心理，他们不是完全相等的", coldStart: false },

  // === T 工具调用 / 引用过去 ===
  { code: "T1", label: "T1_引用过去", turnTs: null, fallbackInput: "你还记得我上次跟你说的那件事吗，我一直没办法走出来",  coldStart: true  },
  { code: "T2", label: "T2_named_entity", turnTs: null, fallbackInput: "你以前认识的那个人，后来怎么样了？",  coldStart: false },
  { code: "T3", label: "T3_对话历史", turnTs: 1778260776044, fallbackInput: "你记得我们那天聊了什么吗",  coldStart: false },
];

// ── AI tell 启发式（粗略，仅作信号；细看仍要看原文）─────────────────
const AI_TELL_PATTERNS = [
  { name: "命名情绪", re: /我能?(理解|感受到|体会到)/ },
  { name: "归纳对方", re: /(听起来|看得出|看出来)你/ },
  { name: "情绪解释", re: /(这种|这样的)(情况|时候|感受)(下|时)?.{0,8}(正常|可以理解|常见|是的)/ },
  { name: "总结开头", re: /^(总的来说|总之|首先|嗯，?其实|说实话)/m },
  { name: "枚举套路", re: /(首先|第一)[，,。].{1,40}(其次|然后|另外|第二)/ },
  { name: "排比共情", re: /(感受到|理解|看到)你的.{1,12}[，,。].{1,40}(感受到|理解|看到)你的/ },
  { name: "升华文学", re: /(把你整个人接住|世界温柔以待|余生很长|岁月静好|被命运眷顾)/ },
  { name: "感谢分享", re: /(谢谢你的(分享|信任|坦诚)|感谢你愿意)/ },
];

function detectAITells(text) {
  const hits = [];
  for (const p of AI_TELL_PATTERNS) if (p.re.test(text)) hits.push(p.name);
  return hits;
}

// ── 4 版 system prompt ────────────────────────────────────────────────

function v1Naked() {
  return "";
}

function v2IdOnly(profile) {
  return `你是${profile.character_name}，正在跟用户聊天。`;
}

/**
 * V3 LIGHT: 身份 + 说话方式（核心 4 行）+ 3-4 个 voice 样本 + 1 条反 AI tell。
 * 目标 200-500 chars，让模型有具体可模仿的样本，但不带 lore / narrative / facts。
 *
 * voice 样本从 identity.skills[].examples 抽前 3 个 skill 的第一个 example。
 */
function v3Light(profile, identity) {
  const role = identity?.speakingStyle ? identity.speakingStyle.split(/[。\n]/)[0] : "";
  const samples = [];
  if (Array.isArray(identity?.skills)) {
    for (const s of identity.skills.slice(0, 4)) {
      if (s && typeof s === "object" && Array.isArray(s.examples) && s.examples[0]) {
        samples.push(s.examples[0]);
      }
    }
  }

  const lines = [];
  lines.push(`你是${profile.character_name}，正在跟用户聊天。`);
  if (role) lines.push(`说话方式：${role}。`);
  lines.push("");
  lines.push("回应规则：");
  lines.push("- 简短优先，能用片段就不用整句");
  lines.push("- 动作 / 心理活动用 (半角括号) 包裹");
  lines.push("- 反应型场景允许只发 emoji / 一两个字 / 省略号");
  if (samples.length) {
    lines.push("");
    lines.push("你的典型表达（参考节奏，不强行套用）：");
    for (const s of samples) lines.push(`- ${s}`);
  }
  lines.push("");
  lines.push("避免：过度共情套路、文学化升华、归纳总结对方情绪。");
  return lines.join("\n");
}

/**
 * V4 LEAN: production composer 输出，但 strip 两件事：
 *   - background lore 截到 300 chars（生产是 1500 cap，对 chat 太长）
 *   - 去掉 tool_protocol slot（chat-only ablation 不需要 tool 决策）
 */
function v4Lean(profile, identity, userInput) {
  const ctx = buildCharacterContext(ASSISTANT_ID, { lastUserMessage: userInput });
  const composed = composeForChat({
    profile,
    identity,
    coreFacts: [],
    retrievedMemories: [],
    recentReflection: ctx?.latestReflection,
    activeEpisodes: ctx?.recentEpisodes,
    activeTopics: ctx?.activeTopics,
    salientPhrase: ctx?.salientPhrase,
    prefill: ctx?.userPrefix,
  });
  const slots = composed.slots;

  // strip background to 300 chars
  let bg = slots.background;
  const bgMatch = bg.match(/^<background>\n([\s\S]*)\n<\/background>$/);
  if (bgMatch && bgMatch[1].length > 300) {
    const trimmed = bgMatch[1].slice(0, 300 - 3).trimEnd() + "...";
    bg = `<background>\n${trimmed}\n</background>`;
  }

  // canonical order, no tool_protocol
  const lean = [slots.role, slots.character, bg, slots.constraints, slots.facts, slots.narrative]
    .filter(Boolean)
    .join("\n\n");
  return composed.assistantPrefill ? `${lean}\n\n${composed.assistantPrefill}` : lean;
}

// ── DeepSeek 调用 ────────────────────────────────────────────────────
async function ask(systemPrompt, history, userInput) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  for (const t of history) {
    if (t.role === "user" || t.role === "assistant") {
      messages.push({ role: t.role, content: t.content });
    }
  }
  messages.push({ role: "user", content: userInput });

  const body = {
    model: MODEL,
    messages,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    stream: false,
  };

  const r = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  return j.choices[0]?.message?.content || "";
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ── 主流程 ───────────────────────────────────────────────────────────
async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const profile = getAssistantProfile(ASSISTANT_ID);
  const identity = getCharacterIdentity(ASSISTANT_ID);

  if (!profile) {
    console.error(`Assistant ${ASSISTANT_ID} 不存在`);
    process.exit(1);
  }

  // 加载每个 case 的 input + history
  const cases = [];
  for (const c of CASES) {
    let userInput = c.fallbackInput;
    let history = [];
    let sessionId = null;

    if (c.turnTs && !c.coldStart) {
      const userTurn = db
        .prepare("SELECT * FROM conversation_turns WHERE created_at=? AND assistant_id=? AND role='user'")
        .get(c.turnTs, ASSISTANT_ID);
      if (userTurn) {
        userInput = userTurn.content;
        sessionId = userTurn.session_id;
        history = db
          .prepare(
            `SELECT role, content FROM conversation_turns
             WHERE assistant_id=? AND session_id=? AND created_at < ?
             ORDER BY created_at DESC LIMIT ?`
          )
          .all(ASSISTANT_ID, userTurn.session_id, userTurn.created_at, HISTORY_BACK)
          .reverse();
      }
    } else if (c.turnTs && c.coldStart) {
      const userTurn = db
        .prepare("SELECT content FROM conversation_turns WHERE created_at=? AND assistant_id=? AND role='user'")
        .get(c.turnTs, ASSISTANT_ID);
      if (userTurn) userInput = userTurn.content;
    }

    cases.push({ ...c, userInput, history, sessionId });
  }

  console.log(`加载 ${cases.length} 个 case（${cases.filter((c) => c.coldStart).length} 个 cold_start）\n`);

  const results = [];
  let i = 0;
  const total = cases.length * 4;

  for (const cs of cases) {
    const versions = {
      V1_NAKED: v1Naked(),
      V2_ID_ONLY: v2IdOnly(profile),
      V3_LIGHT: v3Light(profile, identity),
      V4_LEAN: v4Lean(profile, identity, cs.userInput),
    };

    const caseResult = {
      label: cs.label,
      code: cs.code,
      coldStart: cs.coldStart,
      userInput: cs.userInput,
      historyTurns: cs.history.length,
      versions: {},
    };

    for (const [vName, vSys] of Object.entries(versions)) {
      i++;
      process.stdout.write(`[${i}/${total}] ${cs.label} · ${vName} … `);
      try {
        const t0 = Date.now();
        const reply = await ask(vSys, cs.history, cs.userInput);
        const dt = Date.now() - t0;
        const tells = detectAITells(reply);
        caseResult.versions[vName] = {
          systemLen: vSys.length,
          reply,
          replyLen: reply.length,
          aiTells: tells,
          ms: dt,
        };
        console.log(`OK ${reply.length}ch tells=[${tells.join(",")}] ${dt}ms`);
      } catch (err) {
        caseResult.versions[vName] = { error: err.message };
        console.log(`ERR ${err.message}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
    results.push(caseResult);
  }

  // 输出
  const ts = Date.now();
  const tmpDir = path.join(__dirname, "..", "tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  fs.writeFileSync(path.join(tmpDir, `voice-ablation-${ts}.json`), JSON.stringify(results, null, 2));

  const md = [];
  md.push(`# Voice Ablation v2 报告\n`);
  md.push(`- 时间：${new Date(ts).toLocaleString("zh-CN")}`);
  md.push(`- 角色：${profile.character_name} (${ASSISTANT_ID})`);
  md.push(`- 模型：${MODEL}, T=${TEMPERATURE}, max_tokens=${MAX_TOKENS}`);
  md.push(`- ${cases.length} cases × 4 versions = ${total} 调用\n`);

  // system 体积
  md.push(`## 4 版 system prompt 体积\n`);
  const sample = {
    V1_NAKED: v1Naked(),
    V2_ID_ONLY: v2IdOnly(profile),
    V3_LIGHT: v3Light(profile, identity),
    V4_LEAN: v4Lean(profile, identity, cases[0].userInput),
  };
  md.push(`| 版本 | 字符数 | 大致 token |`);
  md.push(`|---|---|---|`);
  for (const [k, v] of Object.entries(sample)) {
    md.push(`| ${k} | ${v.length} | ~${Math.round(v.length / 2.5)} |`);
  }
  md.push("");

  // V3 / V4 全文 preview
  md.push(`### V3_LIGHT 全文\n\n\`\`\`\n${sample.V3_LIGHT}\n\`\`\`\n`);
  md.push(`### V4_LEAN 全文（首 case）\n\n\`\`\`\n${sample.V4_LEAN}\n\`\`\`\n`);

  // 汇总表
  md.push(`## 汇总\n`);
  md.push(`| Case | Cold | input | V1 | V2 | V3 | V4 |`);
  md.push(`|---|---|---|---|---|---|---|`);
  for (const r of results) {
    const cells = ["V1_NAKED", "V2_ID_ONLY", "V3_LIGHT", "V4_LEAN"].map((v) => {
      const x = r.versions[v];
      if (!x || x.error) return `❌`;
      const tells = x.aiTells.length ? `· tell:${x.aiTells.length}` : "";
      return `${x.replyLen}ch${tells}`;
    });
    md.push(`| ${r.label} | ${r.coldStart ? "✅" : ""} | ${r.userInput.replace(/\n/g, " ").slice(0, 35)} | ${cells[0]} | ${cells[1]} | ${cells[2]} | ${cells[3]} |`);
  }
  md.push("");

  // 详细对比
  md.push(`## 详细对比\n`);
  for (const r of results) {
    md.push(`### ${r.label}${r.coldStart ? "（冷启动 — 无 history）" : ""}\n`);
    md.push(`**用户输入：**\n\n> ${r.userInput.replace(/\n/g, "\n> ")}\n`);
    if (!r.coldStart && r.historyTurns > 0) {
      md.push(`*history: ${r.historyTurns} 轮*\n`);
    }
    for (const vName of ["V1_NAKED", "V2_ID_ONLY", "V3_LIGHT", "V4_LEAN"]) {
      const x = r.versions[vName];
      const tellStr = x?.aiTells?.length ? `, AI tells: ${x.aiTells.join(", ")}` : "";
      md.push(`**${vName}** (${x?.replyLen ?? "n/a"} chars${tellStr})\n`);
      md.push("```");
      md.push((x?.reply || x?.error || "").trim());
      md.push("```\n");
    }
    md.push("---\n");
  }

  const mdPath = path.join(tmpDir, `voice-ablation-${ts}.md`);
  fs.writeFileSync(mdPath, md.join("\n"));

  console.log(`\n✅ 完成 — 报告：${mdPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
