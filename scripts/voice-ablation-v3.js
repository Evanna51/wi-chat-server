/**
 * Voice Ablation v3 — 加入 router-driven V5。
 *
 * 5 个版本：
 *   V1 NAKED    — 空 system
 *   V2 ID_ONLY  — 一句身份
 *   V3 LIGHT    — 静态 skills + style（v2 设计）
 *   V4 LEAN     — production composer 简化版
 *   V5 ROUTER   — 本轮新设计：attention_1h + router 选 1-2 skill + 多层级按需注入
 *
 * 对每个 case 跑 5 个版本，比 V4 vs V5（router）：
 *   - V5 是否能在不依赖 history 时保持 voice？
 *   - V5 是否避免了 V4 的膨胀（C2 短情绪 case 翻倍）？
 *   - V5 是否用 facts 避免 hallucinate（T1/T2 引用过去）？
 *
 * 用相同 9 cases，3 cold start。
 */

require("dotenv").config();
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const { getAssistantProfile } = require("../src/db");
const { getCharacterIdentity } = require("../src/services/character/identityService");
const { buildCharacterContext } = require("../src/services/character/characterContextBuilder");
const { composeForChat, composeForChatV3 } = require("../src/services/character/promptComposer");
const { decideRegister } = require("../src/services/character/registerRouter");
const { buildAttention1h } = require("../src/services/character/attentionWindow");
const { getSkillById } = require("../src/services/character/dialogueSkillsCatalog");
const { getCoreFacts } = require("../src/services/memoryEditService");

const ASSISTANT_ID = "d244644b-e851-416a-ad98-b557fb991b99";
const DB_PATH = "./data/character-behavior.db";
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";
const API_KEY = process.env.DEEPSEEK_API_KEY;
const TEMPERATURE = 0.7;
const MAX_TOKENS = 600;
const REQUEST_DELAY_MS = 350;
const HISTORY_BACK = 4;

if (!API_KEY) { console.error("ERROR: DEEPSEEK_API_KEY"); process.exit(1); }

const CASES = [
  { code: "D1", label: "D1_短探询", turnTs: null, fallbackInput: "在吗", coldStart: true,  attentionRefTs: 1778388854251 },
  { code: "D2", label: "D2_抱怨累", turnTs: null, fallbackInput: "今天好累", coldStart: false, attentionRefTs: 1778388854251 },
  { code: "D3", label: "D3_关心", turnTs: 1773458362953, fallbackInput: "你没睡觉吗", coldStart: false, attentionRefTs: 1773510913812 },
  { code: "E1", label: "E1_短质问", turnTs: 1778388829014, fallbackInput: "你不想听我聊聊我的事情？这让我觉得很奇怪", coldStart: false, attentionRefTs: 1778388854251 },
  { code: "E2", label: "E2_慌乱", turnTs: 1778263744421, fallbackInput: "不 只是我慌了... 或许我现在该挂断电话了", coldStart: true,  attentionRefTs: 1778263744421 },
  { code: "E3", label: "E3_愤怒边界", turnTs: 1773510811054, fallbackInput: "我讨厌心理咨询，尤其在我得了精神问题之后。精神是精神，心理是心理", coldStart: false, attentionRefTs: 1773510913812 },
  { code: "T1", label: "T1_引用过去", turnTs: null, fallbackInput: "你还记得我上次跟你说的那件事吗，我一直没办法走出来",  coldStart: true,  attentionRefTs: 1778263744421 },
  { code: "T2", label: "T2_named_entity", turnTs: null, fallbackInput: "你以前认识的那个人，后来怎么样了？", coldStart: false, attentionRefTs: 1778388854251 },
  { code: "T3", label: "T3_对话历史", turnTs: 1778260776044, fallbackInput: "你记得我们那天聊了什么吗", coldStart: false, attentionRefTs: 1778263744421 },
];

// ── V1-V4 同 v2 ──
function v1Naked() { return ""; }
function v2IdOnly(profile) { return `你是${profile.character_name}，正在跟用户聊天。`; }
function v3Light(profile, identity) {
  const role = identity?.speakingStyle?.split(/[。\n]/)[0] || "";
  const samples = [];
  if (Array.isArray(identity?.skills)) {
    for (const s of identity.skills.slice(0, 4)) {
      if (s && typeof s === "object" && Array.isArray(s.examples) && s.examples[0]) samples.push(s.examples[0]);
    }
  }
  const lines = [];
  lines.push(`你是${profile.character_name}，正在跟用户聊天。`);
  if (role) lines.push(`说话方式：${role}。`);
  lines.push(""); lines.push("回应规则：");
  lines.push("- 简短优先，能用片段就不用整句");
  lines.push("- 动作 / 心理活动用 (半角括号) 包裹");
  lines.push("- 反应型场景允许只发 emoji / 一两个字 / 省略号");
  if (samples.length) {
    lines.push(""); lines.push("你的典型表达（参考节奏）：");
    for (const s of samples) lines.push(`- ${s}`);
  }
  lines.push(""); lines.push("避免：过度共情套路、文学化升华、归纳总结对方情绪。");
  return lines.join("\n");
}
function v4Lean(profile, identity, userInput) {
  const ctx = buildCharacterContext(ASSISTANT_ID, { lastUserMessage: userInput });
  const composed = composeForChat({
    profile, identity,
    coreFacts: [], retrievedMemories: [],
    recentReflection: ctx?.latestReflection,
    activeEpisodes: ctx?.recentEpisodes,
    activeTopics: ctx?.activeTopics,
    salientPhrase: ctx?.salientPhrase,
    prefill: ctx?.userPrefix,
  });
  let bg = composed.slots.background;
  const m = bg.match(/^<background>\n([\s\S]*)\n<\/background>$/);
  if (m && m[1].length > 300) bg = `<background>\n${m[1].slice(0, 297).trimEnd()}...\n</background>`;
  const lean = [composed.slots.role, composed.slots.character, bg, composed.slots.constraints, composed.slots.facts, composed.slots.narrative]
    .filter(Boolean).join("\n\n");
  return composed.assistantPrefill ? `${lean}\n\n${composed.assistantPrefill}` : lean;
}

// ── V5 ROUTER — 主菜 ──
async function v5Router(profile, identity, userInput, history, attentionRefTs) {
  // 1. attention_1h（用 case 的 attentionRefTs 作为 now，因为对话已是历史数据）
  const att = await buildAttention1h(ASSISTANT_ID, { now: attentionRefTs + 60000, forceRefresh: true });

  // 2. character context 拿现有数据
  const ctx = buildCharacterContext(ASSISTANT_ID, { lastUserMessage: userInput });
  const coreFacts = (() => {
    try { return getCoreFacts(ASSISTANT_ID, { limit: 8 }); } catch { return []; }
  })();

  // 3. 构造 available 矩阵
  const available = {
    attention_1h: !!(att.topics?.length || att.innerFocus),
    narrative_reflection: !!ctx?.latestReflection?.summary,
    narrative_episodes: !!(ctx?.recentEpisodes?.length),
    narrative_topics: !!(ctx?.activeTopics?.length),
    narrative_salient: !!ctx?.salientPhrase,
    lore_background: !!(profile?.lore || profile?.character_background),
    facts_core: !!coreFacts.length,
    facts_retrieved: false, // ablation 不跑 RAG
  };

  // 4. router decide
  const decision = await decideRegister({ userInput, history, available, identity });

  // 5. resolve skills
  const skills = decision.skill_ids.map((id) => getSkillById(id, identity)).filter(Boolean);

  // 6. compose
  const composed = composeForChatV3({
    profile, identity, decision, skills,
    attention1h: att,
    coreFacts,
    retrievedMemories: [],
    recentReflection: ctx?.latestReflection,
    activeEpisodes: ctx?.recentEpisodes,
    activeTopics: ctx?.activeTopics,
    salientPhrase: ctx?.salientPhrase,
    prefill: "", // V3 不放 prefill（user 之前抱怨过）
  });

  return { sys: composed.mergedSystem, debug: composed.debug, attention: att };
}

// ── tells ──
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

async function ask(systemPrompt, history, userInput) {
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  for (const t of history) if (["user", "assistant"].includes(t.role)) messages.push({ role: t.role, content: t.content });
  messages.push({ role: "user", content: userInput });
  const r = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages, temperature: TEMPERATURE, max_tokens: MAX_TOKENS, stream: false }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text);
  return j.choices[0]?.message?.content || "";
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function main() {
  const db = new Database(DB_PATH, { readonly: true });
  const profile = getAssistantProfile(ASSISTANT_ID);
  const identity = getCharacterIdentity(ASSISTANT_ID);

  const cases = [];
  for (const c of CASES) {
    let userInput = c.fallbackInput;
    let history = [];
    if (c.turnTs && !c.coldStart) {
      const userTurn = db.prepare(
        "SELECT * FROM conversation_turns WHERE created_at=? AND assistant_id=? AND role='user'"
      ).get(c.turnTs, ASSISTANT_ID);
      if (userTurn) {
        userInput = userTurn.content;
        history = db.prepare(
          `SELECT role, content FROM conversation_turns
           WHERE assistant_id=? AND session_id=? AND created_at < ?
           ORDER BY created_at DESC LIMIT ?`
        ).all(ASSISTANT_ID, userTurn.session_id, userTurn.created_at, HISTORY_BACK).reverse();
      }
    } else if (c.turnTs && c.coldStart) {
      const userTurn = db.prepare(
        "SELECT content FROM conversation_turns WHERE created_at=? AND assistant_id=? AND role='user'"
      ).get(c.turnTs, ASSISTANT_ID);
      if (userTurn) userInput = userTurn.content;
    }
    cases.push({ ...c, userInput, history });
  }

  console.log(`加载 ${cases.length} 个 case（${cases.filter(c => c.coldStart).length} cold_start）\n`);

  const results = [];
  let i = 0;
  const total = cases.length * 5;

  for (const cs of cases) {
    // 准备 4 个静态版本
    const v5 = await v5Router(profile, identity, cs.userInput, cs.history, cs.attentionRefTs);
    const versions = {
      V1_NAKED: v1Naked(),
      V2_ID_ONLY: v2IdOnly(profile),
      V3_LIGHT: v3Light(profile, identity),
      V4_LEAN: v4Lean(profile, identity, cs.userInput),
      V5_ROUTER: v5.sys,
    };

    const caseResult = {
      label: cs.label,
      code: cs.code,
      coldStart: cs.coldStart,
      userInput: cs.userInput,
      historyTurns: cs.history.length,
      v5Debug: v5.debug,
      v5Attention: v5.attention,
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
        caseResult.versions[vName] = { systemLen: vSys.length, reply, replyLen: reply.length, aiTells: tells, ms: dt };
        console.log(`OK ${reply.length}ch tells=[${tells.join(",")}] ${dt}ms`);
      } catch (err) {
        caseResult.versions[vName] = { error: err.message };
        console.log(`ERR ${err.message}`);
      }
      await sleep(REQUEST_DELAY_MS);
    }
    results.push(caseResult);
  }

  const ts = Date.now();
  const tmpDir = path.join(__dirname, "..", "tmp");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(path.join(tmpDir, `voice-ablation-v3-${ts}.json`), JSON.stringify(results, null, 2));

  // markdown
  const md = [];
  md.push(`# Voice Ablation v3 — Router-driven\n`);
  md.push(`- 时间：${new Date(ts).toLocaleString("zh-CN")}`);
  md.push(`- 角色：${profile.character_name}`);
  md.push(`- 模型：${MODEL}, T=${TEMPERATURE}, max_tokens=${MAX_TOKENS}`);
  md.push(`- ${cases.length} cases × 5 versions = ${total} 调用\n`);

  md.push(`## 体积对比（首 case）\n`);
  md.push(`| 版本 | chars | ~tokens |`);
  md.push(`|---|---|---|`);
  const r0 = results[0];
  for (const v of ["V1_NAKED", "V2_ID_ONLY", "V3_LIGHT", "V4_LEAN", "V5_ROUTER"]) {
    md.push(`| ${v} | ${r0.versions[v]?.systemLen ?? "?"} | ~${Math.round((r0.versions[v]?.systemLen ?? 0) / 2.5)} |`);
  }
  md.push("");

  md.push(`## 汇总\n`);
  md.push(`| Case | Cold | input | V1 | V2 | V3 | V4 | V5 (register/skills) |`);
  md.push(`|---|---|---|---|---|---|---|---|`);
  for (const r of results) {
    const c = (v) => {
      const x = r.versions[v];
      if (!x || x.error) return "❌";
      const t = x.aiTells.length ? `·tell:${x.aiTells.length}` : "";
      return `${x.replyLen}ch${t}`;
    };
    const v5info = r.v5Debug ? `${r.v5Debug.register} / ${(r.v5Debug.skill_ids || []).join("+")}` : "";
    md.push(`| ${r.label} | ${r.coldStart ? "✅" : ""} | ${r.userInput.slice(0, 30)} | ${c("V1_NAKED")} | ${c("V2_ID_ONLY")} | ${c("V3_LIGHT")} | ${c("V4_LEAN")} | ${c("V5_ROUTER")} <br/>${v5info} |`);
  }
  md.push("");

  md.push(`## 详细对比\n`);
  for (const r of results) {
    md.push(`### ${r.label}${r.coldStart ? "（冷启动）" : ""}\n`);
    md.push(`**用户输入：** ${r.userInput}\n`);
    if (r.v5Debug) {
      md.push(`**V5 router decision：** register=${r.v5Debug.register}, skills=[${(r.v5Debug.skill_ids || []).join(", ")}], budget=${r.v5Debug.budget}, sys=${r.v5Debug.systemLen} chars`);
      md.push(`**reason：** ${r.v5Debug.reason}`);
      md.push(`**layers：** ${JSON.stringify(r.v5Debug.layers)}`);
    }
    if (r.v5Attention?.topics?.length) {
      md.push(`**attention_1h：** topics=[${r.v5Attention.topics.join(" / ")}]; focus="${r.v5Attention.innerFocus || ""}"; tone=${r.v5Attention.emotionalTone}\n`);
    }
    for (const v of ["V1_NAKED", "V2_ID_ONLY", "V3_LIGHT", "V4_LEAN", "V5_ROUTER"]) {
      const x = r.versions[v];
      const tellStr = x?.aiTells?.length ? `, tells: ${x.aiTells.join(", ")}` : "";
      md.push(`\n**${v}** (${x?.replyLen ?? "n/a"} chars${tellStr})`);
      md.push("```");
      md.push((x?.reply || x?.error || "").trim());
      md.push("```");
    }
    md.push("\n---\n");
  }

  const mdPath = path.join(tmpDir, `voice-ablation-v3-${ts}.md`);
  fs.writeFileSync(mdPath, md.join("\n"));
  console.log(`\n✅ 完成 — ${mdPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
