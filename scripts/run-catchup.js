#!/usr/bin/env node
const path = require("path");
const args = process.argv.slice(2);

function getArg(flag, fallback = null) {
  const idx = args.indexOf(flag);
  if (idx === -1) return fallback;
  return args[idx + 1] || fallback;
}

const assistantId = getArg("--assistant");
if (!assistantId) {
  console.error("usage: node scripts/run-catchup.js --assistant <id> [--last-interaction-at <ts>] [--gap-hours N] [--max-events N]");
  process.exit(2);
}

const now = Date.now();
let lastInteractionAt = Number(getArg("--last-interaction-at"));
const gapHoursRaw = getArg("--gap-hours");
if (!Number.isFinite(lastInteractionAt) || lastInteractionAt <= 0) {
  if (gapHoursRaw) {
    const gapHours = Number(gapHoursRaw);
    lastInteractionAt = now - gapHours * 3600 * 1000;
  } else {
    console.error("must provide --last-interaction-at or --gap-hours");
    process.exit(2);
  }
}
const maxEventsRaw = getArg("--max-events");
const maxEvents = maxEventsRaw ? Number(maxEventsRaw) : undefined;

require(path.join(__dirname, "..", "src", "db"));
const { runCatchup } = require(path.join(__dirname, "..", "src", "services", "catchupService"));

(async () => {
  try {
    const result = await runCatchup({
      assistantId,
      lastInteractionAt,
      now,
      maxEvents,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (error) {
    console.error("[catchup] failed:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
})();
