const { ILLMProvider } = require("./ILLMProvider");

class OpenAIProvider extends ILLMProvider {
  get name() { return "openai"; }

  async complete(_req) {
    throw new Error("OpenAIProvider: not implemented — set LLM_PROVIDER=qwen or implement this adapter");
  }

  async embed(_text) {
    throw new Error("OpenAIProvider: embed not implemented");
  }
}

module.exports = { OpenAIProvider };
