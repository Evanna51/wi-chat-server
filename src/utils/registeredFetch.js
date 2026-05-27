/**
 * registeredFetch — fetch 包装器：timeout + callRegistry 注册。
 *
 * 能拿到：
 *   - 自动取消（admin / supersede）
 *   - 在飞调用追踪（监控 / debug）
 *
 * @param {string|URL} url
 * @param {object}   [fetchOptions]   传给原生 fetch 的 options（method/headers/body/...）
 * @param {object}   [opts]
 * @param {number?}  [opts.timeoutMs]   hard timeout；超时后调用 registry.cancel("timeout")
 *                                       → AbortError 抛出。不传 = 不超时（依赖 supersede / 显式 cancel）
 * @param {string}   [opts.kind="http"] 分类标签
 * @param {string?}  [opts.scopeKey]    scope（与 KIND_DEFAULTS 联动决定 supersede）
 * @param {string?}  [opts.summary]     debug 描述
 * @param {boolean?} [opts.supersede]   显式覆盖 KIND_DEFAULTS
 */
const callRegistry = require("./callRegistry");

async function registeredFetch(url, fetchOptions = {}, {
  timeoutMs,
  kind = "http",
  scopeKey = null,
  summary = "",
  supersede,
} = {}) {
  const { callId, signal } = callRegistry.register({ kind, scopeKey, summary, supersede });

  let timer = null;
  if (typeof timeoutMs === "number" && timeoutMs > 0) {
    timer = setTimeout(() => {
      callRegistry.cancel(callId, "timeout");
    }, timeoutMs);
  }

  try {
    return await fetch(url, { ...fetchOptions, signal });
  } finally {
    if (timer) clearTimeout(timer);
    callRegistry.unregister(callId);
  }
}

module.exports = { registeredFetch };
