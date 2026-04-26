const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");

if (!fs.existsSync(examplePath)) {
  console.error("[setup] .env.example not found at", examplePath);
  process.exit(1);
}

if (fs.existsSync(envPath)) {
  console.log("[setup] .env already exists, skipping copy");
} else {
  fs.copyFileSync(examplePath, envPath);
  console.log("[setup] created .env from .env.example");
  console.log("[setup] edit .env to set APP_API_KEY / QWEN_BASE_URL / QWEN_MODEL");
}

const dataDir = path.join(root, "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log("[setup] created data/ directory");
}
