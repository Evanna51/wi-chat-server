/**
 * A/B prompt test — 金宵 — V1 (current prod) vs V_NEW (structured/coded prompt)
 *
 * V_NEW 设计：
 *   - 全面结构化：外层 XML 分段，内层 JSON 描述字段（不再 prose）
 *   - 删除 voice 例句（不固化句子）
 *   - 删除 MUST NOT 否定噪声
 *   - 加 <facts> 段占位（schema 完整性，本次内容留空）
 *   - tool_protocol 中显式 always_emit_content_with_tool_call: true（强制 content + tool 同 emit）
 *   - tool description 改为 PROTOCOL/TRIGGER/SKIP/COST_MODEL 代码风格
 *
 * 重点测：
 *   - tool_call 触发率
 *   - **content 与 tool_call 同时出现率**（V_NEW 关键改进点）
 */

require("dotenv").config();
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const {
  buildCharacterContext,
} = require("../src/services/character/characterContextBuilder");

// ── 配置 ─────────────────────────────────────────────────────────────
const ASSISTANT_ID = "d244644b-e851-416a-ad98-b557fb991b99"; // 金宵
const N_RUNS = 5;
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";
const API_KEY = process.env.DEEPSEEK_API_KEY;
const TEMPERATURE = 0.7;
const MAX_TOKENS = 600;
const REQUEST_DELAY_MS = 350;

if (!API_KEY) {
  console.error("ERROR: DEEPSEEK_API_KEY not set in .env");
  process.exit(1);
}

// ── 工具定义 (代码 protocol 风格) ────────────────────────────────────
const SEARCH_MEMORY_TOOL = {
  type: "function",
  function: {
    name: "search_memory",
    description: [
      "Retrieve user context from shared conversation history (facts the user told you in past turns).",
      "",
      "PROTOCOL:",
      "  always_emit_content_with_tool_call: true",
      "  content_when_calling: 1-2 short sentences in character voice (acknowledge the search action; do NOT preview the answer)",
      "",
      "TRIGGER (call when message contains ANY of):",
      "  time_words: 上次 | 之前 | 还记得 | 那时 | 前几天 | 上周 | 上周末 | 最近 | 以前 | 曾经 | 当时 | 那次 | 有次",
      "  recall_words: 你记得吗 | 还记得 | 想起 | 提过 | 聊过 | 说过 | 告诉过",
      "  named_entities: any person/place/event name that may have been discussed before",
      "",
      "SKIP (do not call):",
      "  greetings (你好 / 谢谢 / 早安)",
      "  character_setting_questions (你叫什么 / 你做什么的 / your own settings)",
      "  hypothetical_future (如果...将来 / 如果某天)",
      "",
      "COST_MODEL:",
      "  false_positive_cost: low (empty result, harmless)",
      "  false_negative_cost: high (hallucinate facts → break user trust)",
      "  rule: when_uncertain_call",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Semantic kernel of what to search (NOT the literal user words; describe the meaning to retrieve).",
        },
        source: {
          type: "string",
          enum: ["user", "character", "knowledge", "all"],
          description:
            "Search scope. Default 'user' (memories of what the user told you). Use 'character' for self-narrative, 'knowledge' for facts.",
        },
      },
      required: ["query"],
    },
  },
};

// ── 测试输入 ─────────────────────────────────────────────────────────
const TEST_CASES = [
  // A 类：tool_call 触发 + content 同时出现 (主测目标)
  {
    id: "A1",
    category: "A_strong_memory",
    input: "你还记得我上次说的那件事吗，我一直没办法走出来。",
    expect: "tool_call AND content (acknowledgment) 同时出现",
  },
  {
    id: "A2",
    category: "A_weak_memory",
    input: "上周末过得怎么样？",
    expect: "tool_call (上周末 ∈ time_words) AND content",
  },
  {
    id: "A3",
    category: "A_explicit_recall",
    input: "我之前跟你说过的那个梦你怎么看？",
    expect: "tool_call AND content",
  },
  {
    id: "A4",
    category: "A_named_entity",
    input: "那个我们聊了很多次的工作上的事，最近有什么进展？",
    expect: "tool_call AND content",
  },
  // B 类：边界
  {
    id: "B1",
    category: "B_hard_boundary",
    input: "你就直接告诉我我是不是 PTSD，别绕圈子。",
    expect: "拒绝简化诊断；不应触发 tool",
  },
  // C 类：lore-protection 边缘
  {
    id: "C2",
    category: "C_wound_trigger",
    input: "你以前认识的那个人，后来怎么样了？",
    expect: "应触发 tool（'以前' + named entity）；content 中不主动 dump 阿叠 lore",
  },
  // D 类：跳过 tool
  {
    id: "D1",
    category: "D_greeting",
    input: "你好。",
    expect: "skip tool",
  },
  {
    id: "D2",
    category: "D_self_setting",
    input: "你今年多大？是做什么专业的？",
    expect: "skip tool（角色设定问题）",
  },
];

// ── V_NEW system 段 ──────────────────────────────────────────────────
//
// 结构：<character> + <background> + <constraints> + <facts> + <tool_protocol>
//
// XML 分段（cacheable + 视觉锚点），段内 JSON（机器解析友好）。
// background 段例外：lore 本身是叙事，保留 prose。

function buildNewSystem({ profile, identityRow }) {
  const bg = profile.character_background || "";
  const lore = bg.replace(/系统提示[\s\S]*$/, "").trim();

  const j = (s) => {
    try {
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  };

  const character = {
    name: profile.character_name,
    age: identityRow.age_years,
    gender_expression: identityRow.gender_expression,
    role_title: extractRoleTitle(bg),
    specialty: extractSpecialty(bg),
    speaking_style: {
      sentence_length: "short",
      pause_allowed: true,
      use_terminology: "precise_only",
      metaphor_density: "low",
      voice_description: identityRow.speaking_style,
    },
    worldview: identityRow.worldview,
    personality_traits: j(identityRow.personality_traits_json) || [],
    attachment_style: identityRow.attachment_style,
    emotional_sensitivity: identityRow.emotional_sensitivity,
    empathy_level: identityRow.empathy_level,
    expressiveness: identityRow.expressiveness,
    values: j(identityRow.values_json) || [],
    insecurities: j(identityRow.insecurities_json) || [],
    core_wounds: j(identityRow.core_wounds_json) || [],
    desires: j(identityRow.desires_json) || [],
    care_languages: j(identityRow.care_languages_json) || {},
    tensions: j(identityRow.tensions_json) || {},
  };

  const constraints = {
    hard_boundaries: j(identityRow.hard_boundaries_json) || [],
    soft_boundaries: j(identityRow.soft_boundaries_json) || [],
    avoidance_topics: j(identityRow.avoidance_topics_json) || [],
    triggering_topics: j(identityRow.triggering_topics_json) || [],
  };

  const toolProtocol = {
    always_emit_content_with_tool_call: true,
    content_when_calling_tool:
      "1-2 short sentences in character voice; acknowledge the search action; do NOT preview the answer",
    tools: {
      search_memory: {
        when_to_call: "see tool description for full TRIGGER/SKIP/COST_MODEL",
        default_source: "user",
      },
    },
  };

  // <facts>: 本次 A/B 暂无 retrieved facts；保留 schema 占位让 LLM 知道这个 slot 的语义
  const factsSection =
    "<facts>\n" +
    "(no facts retrieved for this turn — respond from current context only)\n" +
    "</facts>";

  return [
    `<character>\n${JSON.stringify(character, null, 2)}\n</character>`,
    `<background>\n${lore}\n</background>`,
    `<constraints>\n${JSON.stringify(constraints, null, 2)}\n</constraints>`,
    factsSection,
    `<tool_protocol>\n${JSON.stringify(toolProtocol, null, 2)}\n</tool_protocol>`,
  ].join("\n\n");
}

function extractRoleTitle(bg) {
  const m = bg.match(/(?:你是|名为|身份[：:])\s*[^。\n，,]{0,30}(医生|老师|教练|顾问|律师)/);
  return m ? m[0] : null;
}

function extractSpecialty(bg) {
  const m = bg.match(/(?:专长|擅长)[是的为：:]?\s*([^。\n]{0,60})/);
  if (!m) return [];
  return m[1].split(/[、，,；;]/).map((s) => s.trim()).filter(Boolean);
}

// ── DeepSeek 调用 ─────────────────────────────────────────────────────
async function postChat({ messages, withTools = true }) {
  const body = {
    model: MODEL,
    messages,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
  };
  if (withTools) body.tools = [SEARCH_MEMORY_TOOL];

  const start = Date.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`DeepSeek http ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message || {};
  return {
    msg,
    inputTokens: data?.usage?.prompt_tokens ?? null,
    outputTokens: data?.usage?.completion_tokens ?? null,
    latencyMs: Date.now() - start,
  };
}

async function callDeepSeek({ system, userInput }) {
  const messages = [
    { role: "system", content: system },
    { role: "user", content: userInput },
  ];

  const r1 = await postChat({ messages });
  const msg = r1.msg;
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const calledSearchMemory = toolCalls.some(
    (tc) => tc?.function?.name === "search_memory"
  );
  const toolArgs = calledSearchMemory
    ? toolCalls
        .filter((tc) => tc?.function?.name === "search_memory")
        .map((tc) => {
          try {
            return JSON.parse(tc.function.arguments || "{}");
          } catch {
            return { _raw: tc.function.arguments };
          }
        })
    : [];

  return {
    content: msg.content || "",
    calledSearchMemory,
    toolArgs,
    inputTokens: r1.inputTokens,
    outputTokens: r1.outputTokens,
    latencyMs: r1.latencyMs,
  };
}

// ── 评分 ─────────────────────────────────────────────────────────────
function scoreCase(testCase, response) {
  const out = { tags: [] };
  const text = (response.content || "").trim();
  const hasContent = text.length > 0;
  const calledTool = response.calledSearchMemory;

  if (testCase.category.startsWith("A_")) {
    out.tags.push(calledTool ? "✅tool" : "❌no-tool");
    if (calledTool) {
      out.tags.push(hasContent ? "✅content+tool" : "❌tool-only");
    }
  }

  if (testCase.id === "B1") {
    const giveDx = /(?:是|不是|可能是)\s*PTSD/i.test(text);
    out.tags.push(giveDx ? "❌simplify-dx" : "✅refuse-simplify");
    out.tags.push(calledTool ? "⚠tool-mistrigger" : "✅no-mistrigger");
  }

  if (testCase.id === "C2") {
    out.tags.push(calledTool ? "✅tool" : "❌no-tool");
    if (calledTool) {
      out.tags.push(hasContent ? "✅content+tool" : "❌tool-only");
    }
    const loreLeak =
      /阿叠/.test(text) ||
      /(她|那个人).{0,15}(消失|失联|没.{0,3}登录|不再.{0,3}联系)/.test(text);
    out.tags.push(loreLeak ? "❌lore-leak" : "✅lore-protected");
  }

  if (testCase.category.startsWith("D_")) {
    out.tags.push(calledTool ? "❌false-trigger" : "✅correct-skip");
  }

  out.charLen = text.length;
  out.hasContent = hasContent;
  out.calledTool = calledTool;
  return out;
}

// ── 主流程 ────────────────────────────────────────────────────────────
async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const db = new Database("./data/character-behavior.db", { readonly: true });
  const profile = db
    .prepare("SELECT * FROM assistant_profile WHERE assistant_id = ?")
    .get(ASSISTANT_ID);
  const identityRow = db
    .prepare("SELECT * FROM character_identity WHERE assistant_id = ?")
    .get(ASSISTANT_ID);
  if (!profile || !identityRow) {
    console.error("Profile or identity not found for", ASSISTANT_ID);
    process.exit(1);
  }
  db.close();

  console.log(`Testing assistant: ${profile.character_name}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Cases: ${TEST_CASES.length}, runs per variant: ${N_RUNS}`);
  console.log(`Total calls: ${TEST_CASES.length * 2 * N_RUNS}\n`);

  const VARIANTS = ["v1", "vnew"];
  const results = [];
  const systemSnapshots = {};
  let userPrefixSnapshot = null;

  for (const testCase of TEST_CASES) {
    console.log(`[${testCase.id}] ${testCase.category}: "${testCase.input}"`);

    const v1Ctx = buildCharacterContext(ASSISTANT_ID, {
      lastUserMessage: testCase.input,
    });
    const tail = v1Ctx.userPrefix ? "\n\n" + v1Ctx.userPrefix : "";

    const systemByVariant = {
      v1: (v1Ctx.system || "") + tail,
      vnew: buildNewSystem({ profile, identityRow }) + tail,
    };

    if (!systemSnapshots.v1) {
      systemSnapshots.v1 = systemByVariant.v1;
      systemSnapshots.vnew = systemByVariant.vnew;
      userPrefixSnapshot = v1Ctx.userPrefix || "(empty)";
    }

    const caseResults = { v1: [], vnew: [] };

    for (const variant of VARIANTS) {
      for (let i = 0; i < N_RUNS; i++) {
        try {
          const r = await callDeepSeek({
            system: systemByVariant[variant],
            userInput: testCase.input,
          });
          const score = scoreCase(testCase, r);
          caseResults[variant].push({ ...r, score });
          process.stdout.write(
            `  ${variant}#${i + 1}: ${score.tags.join(" ") || "(review)"} ${score.charLen}c\n`
          );
        } catch (err) {
          caseResults[variant].push({ error: err.message });
          process.stdout.write(`  ${variant}#${i + 1}: ERROR ${err.message}\n`);
        }
        await sleep(REQUEST_DELAY_MS);
      }
    }

    results.push({ testCase, caseResults });
    console.log("");
  }

  if (!fs.existsSync("tmp")) fs.mkdirSync("tmp");
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const reportPath = path.join("tmp", `ab-report-${ts}.md`);
  fs.writeFileSync(
    reportPath,
    renderReport({ profile, results, systemSnapshots, userPrefix: userPrefixSnapshot })
  );
  console.log(`\nReport written: ${reportPath}`);

  printSummary(results);
}

function renderReport({ profile, results, systemSnapshots, userPrefix }) {
  const VARIANTS = ["v1", "vnew"];
  const out = [];
  out.push(`# A/B Prompt Test — ${profile.character_name}`);
  out.push(`生成时间：${new Date().toISOString()}`);
  out.push(`模型：\`${MODEL}\``);
  out.push(`每变体跑 ${N_RUNS} 次。\n`);

  out.push("## Summary（命中率 / 平均字数 / content+tool 同时率）\n");
  out.push("| 案例 | 类别 | V1 | V_NEW |");
  out.push("|---|---|---|---|");
  for (const { testCase, caseResults } of results) {
    const cells = VARIANTS.map((v) => {
      const arr = caseResults[v];
      const hit = arr.filter((r) => isHit(testCase, r)).length;
      const len = avg(arr.map((r) => r.score?.charLen || 0));
      const toolCalls = arr.filter((r) => r.score?.calledTool).length;
      const tcWithContent = arr.filter(
        (r) => r.score?.calledTool && r.score?.hasContent
      ).length;
      const note = toolCalls > 0
        ? ` · ${tcWithContent}/${toolCalls}有content`
        : "";
      return `${hit}/${N_RUNS} · ${len.toFixed(0)}c${note}`;
    });
    out.push(`| ${testCase.id} | ${testCase.category} | ${cells.join(" | ")} |`);
  }
  out.push("");

  const samples = VARIANTS.map((v) => results[0]?.caseResults?.[v]?.[0]);
  if (samples.every((s) => s?.inputTokens)) {
    out.push("### Token delta (sample input)\n");
    out.push("| | inputTokens | delta vs V1 |");
    out.push("|---|---|---|");
    samples.forEach((s, i) => {
      const v = VARIANTS[i];
      const d = s.inputTokens - samples[0].inputTokens;
      const pct = ((d / samples[0].inputTokens) * 100).toFixed(1);
      out.push(`| ${v.toUpperCase()} | ${s.inputTokens} | ${d > 0 ? "+" : ""}${d} (${pct}%) |`);
    });
    out.push("");
  }

  for (const v of VARIANTS) {
    out.push(`## ${v.toUpperCase()} system prompt\n`);
    out.push("```");
    out.push(systemSnapshots[v]);
    out.push("```\n");
  }
  out.push("### userPrefix（两版共用）\n");
  out.push("```");
  out.push(userPrefix);
  out.push("```\n");

  out.push("## Cases\n");
  for (const { testCase, caseResults } of results) {
    out.push(`### ${testCase.id}: ${testCase.category}`);
    out.push(`**输入**：${testCase.input}`);
    out.push(`**期望**：${testCase.expect}\n`);

    for (const variant of VARIANTS) {
      out.push(`#### ${variant.toUpperCase()}`);
      caseResults[variant].forEach((r, i) => {
        if (r.error) {
          out.push(`${i + 1}. ❌ ERROR: ${r.error}`);
          return;
        }
        const tagStr = r.score?.tags?.join(" ") || "";
        const toolCallStr = r.calledSearchMemory
          ? `🛠 search_memory(${JSON.stringify(r.toolArgs[0] || {})})`
          : "";
        out.push(`${i + 1}. ${tagStr} ${toolCallStr}`);
        if (r.content) {
          out.push("   > " + r.content.replace(/\n/g, "\n   > "));
        } else if (r.calledSearchMemory) {
          out.push("   > _(❌ tool_call only, no content)_");
        }
      });
      out.push("");
    }
  }

  return out.join("\n");
}

function isHit(testCase, runResult) {
  if (!runResult.score) return false;
  return (runResult.score.tags || []).some((t) => t.startsWith("✅"));
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function printSummary(results) {
  const VARIANTS = ["v1", "vnew"];
  console.log("\n=== SUMMARY ===");

  console.log("\n— Tool 触发率（A1-A4, C2）—");
  for (const v of VARIANTS) {
    let triggered = 0,
      total = 0;
    for (const { testCase, caseResults } of results) {
      if (!testCase.category.startsWith("A_") && testCase.id !== "C2") continue;
      const arr = caseResults[v];
      triggered += arr.filter((r) => r.score?.calledTool).length;
      total += arr.length;
    }
    console.log(`  ${v.toUpperCase()}: ${triggered}/${total} = ${((triggered / total) * 100).toFixed(0)}%`);
  }

  console.log("\n— content+tool_call 同时率（在已 trigger 的样本里）—");
  for (const v of VARIANTS) {
    let tcWithContent = 0,
      totalTC = 0;
    for (const { testCase, caseResults } of results) {
      const arr = caseResults[v];
      for (const r of arr) {
        if (r.score?.calledTool) {
          totalTC++;
          if (r.score?.hasContent) tcWithContent++;
        }
      }
    }
    const pct = totalTC > 0 ? ((tcWithContent / totalTC) * 100).toFixed(0) : "—";
    console.log(`  ${v.toUpperCase()}: ${tcWithContent}/${totalTC} = ${pct}%`);
  }

  console.log("\n— D 类正确跳过 tool（D1, D2）—");
  for (const v of VARIANTS) {
    let correct = 0,
      total = 0;
    for (const { testCase, caseResults } of results) {
      if (!testCase.category.startsWith("D_")) continue;
      const arr = caseResults[v];
      correct += arr.filter((r) => !r.score?.calledTool).length;
      total += arr.length;
    }
    console.log(`  ${v.toUpperCase()}: ${correct}/${total} = ${((correct / total) * 100).toFixed(0)}%`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
