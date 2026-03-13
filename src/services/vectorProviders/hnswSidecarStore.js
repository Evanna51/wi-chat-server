const config = require("../../config");

function buildSidecarUrl(pathname) {
  const base = process.env.HNSW_SIDECAR_URL || "http://127.0.0.1:9011";
  return `${base.replace(/\/$/, "")}${pathname}`;
}

async function callSidecar(pathname, payload) {
  const res = await fetch(buildSidecarUrl(pathname), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`hnsw sidecar failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function createHnswSidecarStore(fallbackStore) {
  return {
    name: "hnsw_sidecar",
    async upsert({ memoryId, assistantId, vector }) {
      try {
        await callSidecar("/upsert", { memoryId, assistantId, vector });
      } catch (error) {
        console.error("[vector] sidecar upsert failed, fallback sqlite:", error.message);
      }
      await fallbackStore.upsert({ memoryId, assistantId, vector });
    },
    async search({ assistantId, queryVector, topK = config.vectorK }) {
      try {
        const result = await callSidecar("/search", { assistantId, queryVector, topK });
        if (Array.isArray(result?.matches)) return result.matches;
      } catch (error) {
        console.error("[vector] sidecar search failed, fallback sqlite:", error.message);
      }
      return fallbackStore.search({ assistantId, queryVector, topK });
    },
  };
}

module.exports = { createHnswSidecarStore };
