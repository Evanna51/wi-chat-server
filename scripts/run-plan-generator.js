#!/usr/bin/env node
const path = require("path");
const args = process.argv.slice(2);

function getArg(flag, fallback = null) {
  const idx = args.indexOf(flag);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
}

const assistantId = getArg("--assistant");

require(path.join(__dirname, "..", "src", "db"));
const { generatePlans } = require(path.join(__dirname, "..", "src", "services", "proactivePlanService"));

(async () => {
  try {
    const result = await generatePlans({ assistantId: assistantId || null });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (error) {
    console.error("[plan-generator] failed:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
})();
