const fs = require("fs");
const path = require("path");
const { retrieveMemory } = require("../src/services/memoryRetrievalService");

async function run() {
  const filePath = path.join(__dirname, "..", "data", "eval", "memory_eval_seed.json");
  const dataset = JSON.parse(fs.readFileSync(filePath, "utf8"));
  let hitAt5 = 0;
  let reciprocalRankTotal = 0;

  for (const item of dataset) {
    const results = await retrieveMemory({
      assistantId: item.assistantId,
      sessionId: item.sessionId,
      query: item.query,
      topK: 5,
    });
    let rank = 0;
    for (let i = 0; i < results.length; i += 1) {
      const text = results[i].content || "";
      const matched = item.expectedMemoryHints.some((hint) => text.includes(hint));
      if (matched) {
        rank = i + 1;
        break;
      }
    }
    if (rank > 0) {
      hitAt5 += 1;
      reciprocalRankTotal += 1 / rank;
    }
  }

  const total = dataset.length || 1;
  const recallAt5 = hitAt5 / total;
  const mrr = reciprocalRankTotal / total;
  console.log(
    JSON.stringify(
      {
        total,
        recallAt5,
        mrr,
        thresholds: {
          recallAt5Target: 0.5,
          mrrTarget: 0.4,
        },
      },
      null,
      2
    )
  );
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
