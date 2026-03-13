const express = require("express");
const config = require("./config");
require("./db");
const apiRouter = require("./routes/api");
const adminRouter = require("./routes/admin");
const { startScheduler } = require("./scheduler");
const { startMemoryIndexer } = require("./workers/memoryIndexer");

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

app.use("/api", apiRouter);
app.use("/admin", adminRouter);

app.listen(config.port, config.host, () => {
  console.log(`[server] listening on ${config.host}:${config.port}`);
  startMemoryIndexer();
  startScheduler();
});
