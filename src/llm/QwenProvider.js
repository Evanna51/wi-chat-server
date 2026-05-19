const config = require("../config");
const { registeredFetch } = require("../utils/registeredFetch");
const { ILLMProvider } = require("./ILLMProvider");
const { recordProviderCall } = require("./callLogger");

const CHAT_TIMEOUT_MS = 30000;
const EMBED_TIMEOUT_MS = 15000;

function deterministicEmbedding(text, dim = config.vectorDim) {
  const crypto = require("crypto");
  const values = new Array(dim).fill(0);
  const hash = crypto.createHash("sha256").update(text).digest();
  for (let i = 0; i < dim; i++) {
    const b = hash[i % hash.length];
    values[i] = (b / 255) * 2 - 1;
  }
  const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
  return values.map((v) => v / norm);
}

class QwenProvider extends ILLMProvider {
  get name() { return "qwen"; }

  get _baseUrl() {
    return (config.qwenBaseUrl || "http://127.0.0.1:1234/v1").replace(/\/$/, "");
  }

  get _embedBaseUrl() {
    return (config.embedBaseUrl || "").replace(/\/$/, "");
  }

  async complete({ messages, temperature, maxTokens, responseFormat, callOpts } = {}) {
    const endpoint = `${this._baseUrl}/chat/completions`;
    const effectiveTemp = responseFormat === "json" ? 0 : (temperature ?? config.qwenTemperature);
    const effectiveMax = maxTokens ?? config.qwenMaxTokens;

    const body = {
      model: config.qwenModel,
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
          Authorization: `Bearer ${config.qwenApiKey}`,
        },
        body: JSON.stringify(body),
      },
      {
        timeoutMs: CHAT_TIMEOUT_MS,
        kind: callOpts?.kind || "llm.complete",
        scopeKey: callOpts?.scopeKey ?? null,
        summary: callOpts?.summary || `qwen.complete msgs=${messages?.length ?? 0}`,
        supersede: callOpts?.supersede,
      }
    );

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`qwen chat http ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || "";
    const inputTokens  = data?.usage?.prompt_tokens     ?? estimateTokens(messages);
    const outputTokens = data?.usage?.completion_tokens ?? estimateTokens([{ content }]);

    recordProviderCall({
      provider: this.name,
      callType: "chat",
      model: config.qwenModel,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - startMs,
      ok: true,
    });

    return { content, inputTokens, outputTokens, model: config.qwenModel };
  }

  async embed(text, callOpts) {
    if (!this._embedBaseUrl) {
      return deterministicEmbedding(text || "");
    }
    const endpoint = `${this._embedBaseUrl}/embeddings`;
    const startMs = Date.now();
    try {
      const res = await registeredFetch(
        endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.qwenApiKey}`,
          },
          body: JSON.stringify({ model: config.embedModel, input: text }),
        },
        {
          timeoutMs: EMBED_TIMEOUT_MS,
          kind: callOpts?.kind || "embed",
          scopeKey: callOpts?.scopeKey ?? null,
          summary: callOpts?.summary || `qwen.embed len=${(text || "").length}`,
          supersede: callOpts?.supersede,
        }
      );
      if (!res.ok) throw new Error(`embed http ${res.status}`);
      const data = await res.json();
      const vector = data?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || !vector.length) throw new Error("embed empty vector");

      recordProviderCall({
        provider: this.name,
        callType: "embed",
        model: config.embedModel,
        inputTokens: estimateTokens([{ content: text }]),
        outputTokens: 0,
        latencyMs: Date.now() - startMs,
        ok: true,
      });

      return vector;
    } catch (err) {
      console.error("[qwen] embed fallback to deterministic:", err.message);
      return deterministicEmbedding(text || "");
    }
  }

  async healthCheck() {
    try {
      const res = await registeredFetch(
        `${this._baseUrl}/models`,
        { headers: { Authorization: `Bearer ${config.qwenApiKey}` } },
        { timeoutMs: 5000, kind: "http", summary: "qwen.healthcheck" }
      );
      return res.ok;
    } catch {
      return false;
    }
  }
}

function estimateTokens(messages = []) {
  const total = messages.reduce((s, m) => s + String(m.content || "").length, 0);
  return Math.ceil(total / 4);
}

module.exports = { QwenProvider };
