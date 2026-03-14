const config = require("../src/config");
const { runLifeMemoryTick, runProactiveTick } = require("../src/scheduler");

function parseArgs(argv) {
  const args = {
    job: "all",
    assistantIds: [],
    ignoreLock: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--job") args.job = String(argv[++i] || "all");
    else if (token === "--assistant") args.assistantIds.push(String(argv[++i] || "").trim());
    else if (token === "--assistants") {
      args.assistantIds.push(
        ...String(argv[++i] || "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      );
    } else if (token === "--ignore-lock") args.ignoreLock = true;
    else if (token === "--respect-lock") args.ignoreLock = false;
    else if (token === "--help") args.help = true;
  }

  args.job = String(args.job || "all").toLowerCase();
  args.assistantIds = Array.from(new Set(args.assistantIds.filter(Boolean)));
  return args;
}

function printHelp() {
  console.log(`
Usage:
  npm run autonomous:run -- --job all
  npm run autonomous:run -- --job life --assistant <assistant_id>
  npm run autonomous:run -- --job message --assistants <id1,id2>

Options:
  --job           life|message|all (default all)
  --assistant     one assistant_id (repeatable)
  --assistants    comma-separated assistant ids
  --ignore-lock   bypass leader lock (default)
  --respect-lock  follow leader lock
  --help          show help
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (!["life", "message", "all"].includes(args.job)) {
    throw new Error(`invalid --job: ${args.job}`);
  }

  const assistantIds = args.assistantIds.length ? args.assistantIds : null;
  const summary = {
    ok: true,
    job: args.job,
    assistantIds: assistantIds || [],
    ignoreLock: args.ignoreLock,
    autonomousDryRun: config.autonomousDryRun,
    result: {},
    ts: Date.now(),
  };

  if (args.job === "life" || args.job === "all") {
    summary.result.life = await runLifeMemoryTick({
      assistantIds,
      ignoreLock: args.ignoreLock,
    });
  }
  if (args.job === "message" || args.job === "all") {
    summary.result.message = await runProactiveTick({
      assistantIds,
      ignoreLock: args.ignoreLock,
    });
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error("[autonomous:run] failed:", error.message);
  process.exit(1);
});
