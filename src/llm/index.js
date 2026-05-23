const config = require("../config");

let _chatProvider = null;
let _embedProvider = null;
let _introspectionProvider = null;

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

/**
 * introspection-side provider：memory_classify / persona_extract / episode_build / reflect。
 * 走 INTROSPECTION_LLM_PROVIDER（默认继承 SERVER_LLM_PROVIDER → "qwen" 本地）。
 * 切换只需改 .env，无需改代码。
 */
function getIntrospectionProvider() {
  if (!_introspectionProvider) {
    const { ConfigurableProvider } = require("./ConfigurableProvider");
    const cfg = config.getIntrospectionLlmConfig();
    _introspectionProvider = new ConfigurableProvider({
      name: `introspection-${cfg.provider}`,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
    });
  }
  return _introspectionProvider;
}

function _setProviderForTesting(provider) {
  _chatProvider = provider;
  _embedProvider = provider;
  _introspectionProvider = provider;
}

function _resetProviders() {
  _chatProvider = null;
  _embedProvider = null;
  _introspectionProvider = null;
}

module.exports = { getProvider, getEmbedProvider, getIntrospectionProvider, _setProviderForTesting, _resetProviders };
