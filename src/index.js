const http = require("http");
const express = require("express");
const path = require("path");
const config = require("./config");
require("./db");
const apiRouter = require("./routes/api");
const adminRouter = require("./routes/admin");
const browseRouter = require("./routes/browse");
const syncRouter = require("./routes/sync");
const { startScheduler } = require("./scheduler");
const { startMemoryIndexer } = require("./workers/memoryIndexer");
const { attachWebSocketServer } = require("./ws/server");
const { shutdown: wsShutdown } = require("./ws/connections");

const app = express();
app.use(express.json({ limit: "1mb" }));

if (config.debugHttpLog) {
  app.use((req, res, next) => {
    const startedAt = Date.now();
    const safeBody = req.body && typeof req.body === "object" ? req.body : {};
    console.log(`[http] -> ${req.method} ${req.originalUrl}`, JSON.stringify(safeBody));

    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      const elapsedMs = Date.now() - startedAt;
      console.log(`[http] <- ${req.method} ${req.originalUrl} ${res.statusCode} ${elapsedMs}ms`, JSON.stringify(payload));
      return originalJson(payload);
    };
    next();
  });
}

app.use("/api/sync", syncRouter);
app.use("/api", apiRouter);
app.use("/api/browse", browseRouter);
app.use("/admin", adminRouter);
app.use(express.static(path.join(__dirname, "..", "public")));

const server = http.createServer(app);
attachWebSocketServer(server);

server.listen(config.port, config.host, () => {
  console.log(`[server] listening on ${config.host}:${config.port}`);
  startMemoryIndexer();
  startScheduler();
});

function gracefulExit(signal) {
  console.log(`[server] received ${signal}, shutting down...`);
  try {
    wsShutdown();
  } catch (error) {
    console.error("[server] ws shutdown error:", error.message);
  }
  setTimeout(() => process.exit(0), 8000);
}

process.on("SIGINT", () => gracefulExit("SIGINT"));
process.on("SIGTERM", () => gracefulExit("SIGTERM"));
