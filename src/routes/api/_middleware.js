/**
 * /api 子路由共用的鉴权中间件。
 *
 * 拆分自原 src/routes/api.js（2026-05-23）。
 * REQUIRE_API_KEY=0（dev）时透传；生产环境需要 x-api-key header。
 */
const config = require("../../config");

function authMiddleware(req, res, next) {
  if (!config.requireApiKey) return next();
  const required = config.appApiKey;
  const provided = req.header("x-api-key");
  if (!provided || provided !== required) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

module.exports = { authMiddleware };
