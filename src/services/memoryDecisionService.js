const { getProvider } = require("../llm");

const MEMORY_TRIGGER_REGEX =
  /(记得|上次|之前|喜欢|不喜欢|偏好|习惯|生日|工作|家人|最近|还记得|我们聊到)/;

function heuristicDecision(userInput) {
  const text = (userInput || "").trim();
  if (!text) {
    return {
      shouldRetrieve: false,
      reason: "empty_input",
      intent: "small_talk",
      query: "",
      source: "heuristic",
    };
  }
  if (MEMORY_TRIGGER_REGEX.test(text)) {
    return {
      shouldRetrieve: true,
      reason: "matched_memory_trigger",
      intent: "fact_query",
      query: text,
      source: "heuristic",
    };
  }
  if (text.length >= 12) {
    return {
      shouldRetrieve: true,
      reason: "long_context_query",
      intent: "continuation",
      query: text,
      source: "heuristic",
    };
  }
  return {
    shouldRetrieve: false,
    reason: "short_non_memory_query",
    intent: "small_talk",
    query: text,
    source: "heuristic",
  };
}

function extractJsonObject(text = "") {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

async function aiDecision(userInput) {
  const prompt = [
    "你是记忆检索决策器。基于当前用户输入，判断是否需要检索历史记忆。",
    "仅输出一个JSON对象，不要输出任何额外文字。",
    "严格格式:",
    '{"shouldRetrieve":true|false,"intent":"fact_query|continuation|care_response|small_talk|task_only","reason":"<snake_case_reason>","query":"<用于检索的查询语句>"}',
    "规则:",
    "1) 若用户在问偏好、过往事实、上文延续，shouldRetrieve=true，intent优先用fact_query/continuation。",
    "2) 若是关心、安慰、共情类回复需要避免编造，也可shouldRetrieve=true，intent=care_response。",
    "3) 若是纯即时闲聊且不依赖历史，shouldRetrieve=false，intent=small_talk。",
    "4) query要简短明确，适合作为向量检索查询；若不检索可给空字符串。",
    `当前用户输入: ${userInput}`,
  ].join("\n");

  const { content } = await getProvider().complete({
    messages: [{ role: "user", content: prompt }],
    responseFormat: "json",
    maxTokens: 160,
  });
  const jsonText = extractJsonObject(content);
  if (!jsonText) {
    throw new Error("ai decision non-json output");
  }
  const parsed = JSON.parse(jsonText);
  if (typeof parsed.shouldRetrieve !== "boolean") {
    throw new Error("ai decision invalid shouldRetrieve");
  }
  return {
    shouldRetrieve: parsed.shouldRetrieve,
    intent: String(parsed.intent || "small_talk"),
    reason: String(parsed.reason || "ai_decision"),
    query: String(parsed.query || userInput || ""),
    source: "ai",
  };
}

async function shouldRetrieveMemory({ userInput }) {
  try {
    return await aiDecision(userInput);
  } catch (error) {
    console.error("[memory-decision] ai fallback to heuristic:", error.message);
    return heuristicDecision(userInput);
  }
}

function formatMemoryLines(memories = []) {
  return memories.map((item) => `User记忆: ${item.content}`);
}

function buildMemoryGuidance(memoryLines = []) {
  if (!memoryLines.length) {
    return [
      "记忆: 无高置信记忆命中",
      "结合建议: 先按当前输入正常回复，可追问用户补充偏好或近况。",
    ].join("\n");
  }

  return [
    `记忆: ${memoryLines.join(" | ")}`,
    "结合建议: 优先引用与当前问题最相关的1-2条记忆，避免编造；若记忆与当前输入冲突，先向用户确认。",
  ].join("\n");
}

module.exports = {
  shouldRetrieveMemory,
  formatMemoryLines,
  buildMemoryGuidance,
};
