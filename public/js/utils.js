/**
 * assistant_type 语义（与 chatbox-Android `MyAssistant.type` 对齐）：
 *   "character" 人物型陪伴角色 — 显示自驱生活 / 主动消息开关
 *   "writer"    写作助手        — 隐藏自驱开关
 *   "default"   通用助手        — 隐藏自驱开关
 *   ""          老数据未携带 type — 沿用 character 行为（向后兼容）
 *   其它        视作非陪伴型      — 隐藏自驱开关
 */
export function isCharacterTypeLike(type) {
  if (!type) return true; // 向后兼容：空 type 当 character
  return type === "character";
}

export function assistantTypeLabel(type) {
  switch (type) {
    case "character":
      return "人物";
    case "writer":
      return "作家";
    case "default":
      return "通用";
    case "":
    case undefined:
    case null:
      return "未指定";
    default:
      return type;
  }
}

export function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatTime(ts) {
  if (!ts) return "—";
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

export function shortText(s, n = 80) {
  if (!s) return "";
  const str = String(s);
  if (str.length <= n) return str;
  return str.slice(0, n) + "…";
}
