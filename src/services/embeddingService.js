const { getEmbedProvider } = require("../llm");

/**
 * @param {string} text
 * @param {object} [callOpts] 可选；透传给 callRegistry 用于追踪 / 取消
 *                            （如 { kind: "embed", scopeKey: assistantId }）
 */
async function embedText(text, callOpts) {
  if (!text || !text.trim()) {
    return getEmbedProvider().embed("empty", callOpts);
  }
  return getEmbedProvider().embed(text, callOpts);
}

module.exports = { embedText };
