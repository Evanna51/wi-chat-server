const crypto = require("crypto");
const config = require("../config");

function deterministicEmbedding(text, dim = config.vectorDim) {
  const values = new Array(dim).fill(0);
  const hash = crypto.createHash("sha256").update(text).digest();
  for (let i = 0; i < dim; i += 1) {
    const b = hash[i % hash.length];
    values[i] = (b / 255) * 2 - 1;
  }
  const norm = Math.sqrt(values.reduce((acc, value) => acc + value * value, 0)) || 1;
  return values.map((value) => value / norm);
}

async function remoteEmbedding(text) {
  if (!config.embedBaseUrl) return null;
  const endpoint = `${config.embedBaseUrl.replace(/\/$/, "")}/embeddings`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.qwenApiKey}`,
    },
    body: JSON.stringify({
      model: config.embedModel,
      input: text,
    }),
  });
  if (!res.ok) {
    throw new Error(`embedding request failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return body?.data?.[0]?.embedding || null;
}

async function embedText(text) {
  if (!text || !text.trim()) return deterministicEmbedding("empty");
  try {
    const vector = await remoteEmbedding(text);
    if (Array.isArray(vector) && vector.length) return vector;
  } catch (error) {
    console.error("[embedding] fallback to deterministic:", error.message);
  }
  return deterministicEmbedding(text);
}

module.exports = { embedText, deterministicEmbedding };
