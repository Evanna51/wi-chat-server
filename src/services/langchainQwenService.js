const { ChatOpenAI } = require("@langchain/openai");
const config = require("../config");

const llm = new ChatOpenAI({
  model: config.qwenModel,
  temperature: config.qwenTemperature,
  maxTokens: config.qwenMaxTokens,
  apiKey: config.qwenApiKey,
  configuration: {
    baseURL: config.qwenBaseUrl,
  },
});

function buildMemoryContext(memories = []) {
  return memories
    .map((item, index) => `${index + 1}. ${item.content}`)
    .join("\n")
    .slice(0, 3000);
}

async function generateWithMemory({
  assistantName,
  userPrompt,
  memories = [],
  fallbackText = "你好，最近过得怎么样？",
}) {
  try {
    const context = buildMemoryContext(memories);
    const prompt = [
      `你是角色“${assistantName}”，请根据记忆上下文给出自然、简洁回复。`,
      `记忆上下文:`,
      context || "无",
      "",
      `用户输入: ${userPrompt}`,
      "要求: 20-80字，不要说自己是AI，不要编造明显冲突的事实。",
    ].join("\n");

    const message = await llm.invoke([{ role: "user", content: prompt }]);
    const content = typeof message.content === "string" ? message.content.trim() : "";
    return content || fallbackText;
  } catch (error) {
    console.error("[qwen] generation failed:", error.message);
    return fallbackText;
  }
}

module.exports = { generateWithMemory };
