const { getEmbedProvider } = require("../llm");

async function embedText(text) {
  if (!text || !text.trim()) {
    return getEmbedProvider().embed("empty");
  }
  return getEmbedProvider().embed(text);
}

module.exports = { embedText };
