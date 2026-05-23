/**
 * /api 主路由 —— 仅做 sub-router 挂载。
 *
 * 2026-05-23 拆分：原 1158 行单体 → 6 个按 domain 的 sub-router（src/routes/api/）。
 * 注册顺序无关（Express 按各自定义的路径精确匹配），但保持 cognitive 顺序：
 *   meta（health / profile）→ character（认知层全集）→ journal → memory / knowledge → proactive
 */

const express = require("express");
const router = express.Router();

router.use(require("./api/meta"));
router.use(require("./api/character"));
router.use(require("./api/journal"));
router.use(require("./api/memory"));
router.use(require("./api/knowledge"));
router.use(require("./api/proactive"));

module.exports = router;
