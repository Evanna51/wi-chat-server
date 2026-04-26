const fs = require("fs");
const path = require("path");
const express = require("express");

let HierarchicalNSW;
try {
  ({ HierarchicalNSW } = require("hnswlib-node"));
} catch (error) {
  console.error("[sidecar] hnswlib-node not installed.");
  console.error("[sidecar] On Windows: install Visual Studio Build Tools + Python, then run: npm install hnswlib-node");
  console.error("[sidecar] Or skip this sidecar and use VECTOR_PROVIDER=sqlite (recommended).");
  process.exit(1);
}

const config = require("../src/config");

const app = express();
app.use(express.json({ limit: "2mb" }));

const dim = config.vectorDim;
const indexFile = config.vectorIndexPath;
const metaFile = config.vectorMetaPath;
const maxElements = 200000;

const index = new HierarchicalNSW("cosine", dim);
const state = {
  initialized: false,
  nextLabel: 1,
  labelByMemoryId: {},
  memoryIdByLabel: {},
  assistantByMemoryId: {},
};

function saveState() {
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  index.writeIndexSync(indexFile);
  fs.writeFileSync(metaFile, JSON.stringify(state, null, 2));
}

function loadState() {
  fs.mkdirSync(path.dirname(indexFile), { recursive: true });
  if (fs.existsSync(metaFile)) {
    Object.assign(state, JSON.parse(fs.readFileSync(metaFile, "utf8")));
  }
  if (fs.existsSync(indexFile)) {
    index.readIndexSync(indexFile, true);
    state.initialized = true;
  } else {
    index.initIndex({ maxElements, allowReplaceDeleted: true });
    index.setEf(100);
    state.initialized = true;
    saveState();
  }
}

function ensureVector(vector) {
  if (!Array.isArray(vector) || vector.length !== dim) {
    throw new Error(`vector dim mismatch: expected ${dim}`);
  }
}

app.post("/upsert", (req, res) => {
  try {
    const { memoryId, assistantId, vector } = req.body || {};
    if (!memoryId || !assistantId) throw new Error("memoryId and assistantId required");
    ensureVector(vector);
    let label = state.labelByMemoryId[memoryId];
    if (!label) {
      label = state.nextLabel++;
      state.labelByMemoryId[memoryId] = label;
      state.memoryIdByLabel[label] = memoryId;
    } else {
      index.markDelete(label);
    }
    state.assistantByMemoryId[memoryId] = assistantId;
    index.addPoint(vector, label, true);
    saveState();
    return res.json({ ok: true, label });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.post("/search", (req, res) => {
  try {
    const { assistantId, queryVector, topK = 10 } = req.body || {};
    if (!assistantId) throw new Error("assistantId required");
    ensureVector(queryVector);
    const result = index.searchKnn(queryVector, topK * 3);
    const matches = [];
    for (let i = 0; i < result.neighbors.length; i += 1) {
      const label = result.neighbors[i];
      const memoryId = state.memoryIdByLabel[label];
      if (!memoryId) continue;
      if (state.assistantByMemoryId[memoryId] !== assistantId) continue;
      matches.push({
        memoryId,
        score: 1 - result.distances[i],
      });
      if (matches.length >= topK) break;
    }
    return res.json({ ok: true, matches });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    dim,
    count: index.getCurrentCount(),
  });
});

loadState();
const port = Number(process.env.HNSW_SIDECAR_PORT || 9011);
app.listen(port, () => {
  console.log(`[hnsw-sidecar] listening on :${port}`);
});
