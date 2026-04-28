const config = require("../config");

let _chatProvider = null;
let _embedProvider = null;

function createProvider(name) {
  switch ((name || "qwen").toLowerCase()) {
    case "qwen": {
      const { QwenProvider } = require("./QwenProvider");
      return new QwenProvider();
    }
    case "claude": {
      const { ClaudeProvider } = require("./ClaudeProvider");
      return new ClaudeProvider();
    }
    case "openai": {
      const { OpenAIProvider } = require("./OpenAIProvider");
      return new OpenAIProvider();
    }
    case "fake": {
      const { FakeProvider } = require("./FakeProvider");
      return new FakeProvider();
    }
    default:
      throw new Error(`Unknown LLM provider: ${name}`);
  }
}

function getProvider() {
  if (!_chatProvider) {
    _chatProvider = createProvider(config.llmProvider || "qwen");
  }
  return _chatProvider;
}

function getEmbedProvider() {
  if (!_embedProvider) {
    const name = config.llmEmbedProvider || config.llmProvider || "qwen";
    _embedProvider = createProvider(name);
  }
  return _embedProvider;
}

function _setProviderForTesting(provider) {
  _chatProvider = provider;
  _embedProvider = provider;
}

function _resetProviders() {
  _chatProvider = null;
  _embedProvider = null;
}

module.exports = { getProvider, getEmbedProvider, _setProviderForTesting, _resetProviders };
