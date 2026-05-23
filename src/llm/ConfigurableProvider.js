const { registeredFetch } = require("../utils/registeredFetch");
const { ILLMProvider } = require("./ILLMProvider");
const { recordProviderCall } = require("./callLogger");

const CHAT_TIMEOUT_MS = 30000;

/**
 * OpenAI-compatible provider，endpoint 从构造参数传入而不是读全局 config。
 * 用于 server-side / introspection-side 调用，可按 tier 独立指向不同 endpoint。
 */
class ConfigurableProvider extends ILLMProvider {
  constructor({ name, baseUrl, apiKey, model }) {
    super();
    this._name = name || "configurable";
    this._baseUrl = (baseUrl || "").replace(/\/$/, "");
    this._apiKey = apiKey || "";
    this._model = model || "";
  }

  get name() { return this._name; }

  async complete({ messages, temperature, maxTokens, responseFormat, callOpts } = {}) {
    const endpoint = `${this._baseUrl}/chat/completions`;
    const effectiveTemp = responseFormat === "json" ? 0 : (temperature ?? 0.3);
    const effectiveMax = maxTokens ?? 512;

    const body = {
      model: this._model,
      temperature: effectiveTemp,
      max_tokens: effectiveMax,
      messages,
    };

    const startMs = Date.now();
    const res = await registeredFetch(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this._apiKey}`,
        },
        body: JSON.stringify(body),
      },
      {
        timeoutMs: CHAT_TIMEOUT_MS,
        kind: callOpts?.kind || "llm.complete",
        scopeKey: callOpts?.scopeKey ?? null,
        summary: callOpts?.summary || `${this._name}.complete msgs=${messages?.length ?? 0}`,
        supersede: callOpts?.supersede,
      }
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`${this._name} http ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "";
    const inputTokens = data?.usage?.prompt_tokens ?? _estimateTokens(messages);
    const outputTokens = data?.usage?.completion_tokens ?? _estimateTokens([{ content }]);

    recordProviderCall({
      provider: this._name,
      callType: "chat",
      model: this._model,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - startMs,
      ok: true,
    });

    return { content, inputTokens, outputTokens, model: this._model };
  }

  async healthCheck() {
    try {
      const res = await registeredFetch(
        `${this._baseUrl}/models`,
        { headers: { Authorization: `Bearer ${this._apiKey}` } },
        { timeoutMs: 5000, kind: "http", summary: `${this._name}.healthcheck` }
      );
      return res.ok;
    } catch {
      return false;
    }
  }
}

function _estimateTokens(messages = []) {
  const total = messages.reduce((s, m) => s + String(m.content || "").length, 0);
  return Math.ceil(total / 4);
}

module.exports = { ConfigurableProvider };
