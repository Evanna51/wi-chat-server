/**
 * @deprecated 用 src/utils/registeredFetch.js 的 registeredFetch（支持 kind/scopeKey/supersede）。
 * 此文件保留作向后兼容 shim：等同于 registeredFetch with kind="http"。
 */
const { registeredFetch } = require("./registeredFetch");

async function fetchWithTimeout(url, options, timeoutMs) {
  return registeredFetch(url, options, { timeoutMs, kind: "http" });
}

module.exports = { fetchWithTimeout };
