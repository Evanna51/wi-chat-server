const { ILLMProvider } = require("./ILLMProvider");

class ClaudeProvider extends ILLMProvider {
  get name() { return "claude"; }

  async complete(_req) {
    throw new Error("ClaudeProvider: not implemented — set LLM_PROVIDER=qwen or implement this adapter");
  }

  async embed(_text) {
    throw new Error("ClaudeProvider: embed not implemented — Claude API does not provide embeddings directly");
  }
}

module.exports = { ClaudeProvider };
