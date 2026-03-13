const express = require("express");
const config = require("./config");
require("./db");
const apiRouter = require("./routes/api");
const adminRouter = require("./routes/admin");
const { startScheduler } = require("./scheduler");
const { startMemoryIndexer } = require("./workers/memoryIndexer");

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use("/api", apiRouter);
app.use("/admin", adminRouter);

app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port}`);
  startMemoryIndexer();
  startScheduler();
});
