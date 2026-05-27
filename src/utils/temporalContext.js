/**
 * Temporal snapshot —— 给 chat hot path 和 cognition router 注入"此刻时间锚"。
 *
 * 解决的问题：chat LLM 看不到 timestamp，会把昨天的话当刚才、白天说"困了"。
 * 这层不强制对话格式（保持自由表达），只给三种"觉察"信号 + 几条底线约束。
 *
 * 用法：
 *   const t = getTemporalSnapshot(assistantId);
 *   composeForChatV3({ ..., temporal: t });   // 进 <temporal_context> slot
 *   decideRegister({ ..., temporal: t });     // cognition router 也用
 */

const { db } = require("../db");

// 6h —— 超过这个间隔就视为"新一轮对话开端"。
// 这个阈值跟 proactive next_push 的 NEXT_PUSH_MIN_GAP_FROM_LAST_MS (30min) 不同 ——
// 那个是限流，这个是"对话节奏感"。6h 是体感上"接续 vs 新一轮"的分界。
const NEW_SESSION_GAP_MS = 6 * 60 * 60 * 1000;

function _timeBucket(hour) {
  if (hour >= 0 && hour < 6) return "深夜";
  if (hour >= 6 && hour < 9) return "早晨";
  if (hour >= 9 && hour < 12) return "上午";
  if (hour >= 12 && hour < 14) return "中午";
  if (hour >= 14 && hour < 18) return "下午";
  if (hour >= 18 && hour < 21) return "傍晚";
  return "晚上";
}

function _weekday(date) {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
}

function _formatLocalTs(ms) {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const HH = String(d.getHours()).padStart(2, "0");
  const MM = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}`;
}

/**
 * 把 ms 间隔变成自然语言。"刚才" / "X 分钟前" / "X 小时前" / "昨天 HH:MM" / "前天 HH:MM" / "N 天前"。
 * 跟 proactive/shared.js relativeTimeLabel 类似但更紧凑（这里要塞 prompt 第一行，越短越好）。
 */
function _relativeLabel(ts, now) {
  if (!ts) return "—";
  const diff = now - ts;
  if (diff < 60 * 1000) return "刚才";
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  const today0 = new Date(now); today0.setHours(0, 0, 0, 0);
  const tsDay = new Date(ts); tsDay.setHours(0, 0, 0, 0);
  const dayDiff = Math.round((today0.getTime() - tsDay.getTime()) / (24 * 60 * 60 * 1000));
  if (dayDiff <= 0) return `${hours} 小时前`;
  const tsTime = `${String(new Date(ts).getHours()).padStart(2, "0")}:${String(new Date(ts).getMinutes()).padStart(2, "0")}`;
  if (dayDiff === 1) return `昨天 ${tsTime}`;
  if (dayDiff === 2) return `前天 ${tsTime}`;
  if (dayDiff < 7) return `${dayDiff} 天前`;
  if (dayDiff < 30) return `${Math.floor(dayDiff / 7)} 周前`;
  if (dayDiff < 365) return `${Math.floor(dayDiff / 30)} 个月前`;
  return `${Math.floor(dayDiff / 365)} 年前`;
}

/**
 * @param {string} assistantId
 * @param {object} [opts]
 * @param {number} [opts.now=Date.now()]
 * @returns {{
 *   nowMs: number,
 *   nowIso: string,            // "2026-05-24 15:30"（本地时区，无时区后缀）
 *   weekday: string,           // "周六"
 *   timeOfDay: string,         // "下午"
 *   lastUserAt: number | null, // ms epoch
 *   lastUserLabel: string,     // "3 小时前" / "昨天 22:15"
 *   lastUserAbsolute: string | null,  // "今天上午 12:23" / "昨天 22:15" / null
 *   hoursSinceLastUser: number,
 *   isNewSession: boolean,     // true 表示距上次互动 ≥ 6h，是新一轮对话开端
 * }}
 */
function getTemporalSnapshot(assistantId, { now = Date.now() } = {}) {
  const date = new Date(now);
  const nowIso = _formatLocalTs(now);
  const weekday = _weekday(date);
  const timeOfDay = _timeBucket(date.getHours());

  let lastUserAt = null;
  try {
    const row = db
      .prepare(
        `SELECT created_at FROM conversation_turns
          WHERE assistant_id = ? AND role = 'user'
          ORDER BY created_at DESC LIMIT 1`
      )
      .get(assistantId);
    lastUserAt = row?.created_at || null;
  } catch { /* fresh assistant, no turns yet */ }

  const hoursSinceLastUser =
    lastUserAt ? (now - lastUserAt) / (60 * 60 * 1000) : Infinity;
  const isNewSession = lastUserAt == null || (now - lastUserAt) >= NEW_SESSION_GAP_MS;
  const lastUserLabel = lastUserAt ? _relativeLabel(lastUserAt, now) : "—";
  const lastUserAbsolute = lastUserAt
    ? (() => {
        const d = new Date(lastUserAt);
        const today0 = new Date(now); today0.setHours(0, 0, 0, 0);
        const tsDay = new Date(lastUserAt); tsDay.setHours(0, 0, 0, 0);
        const dayDiff = Math.round((today0.getTime() - tsDay.getTime()) / 86400000);
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        if (dayDiff <= 0) return `今天${_timeBucket(d.getHours())} ${hh}:${mm}`;
        if (dayDiff === 1) return `昨天 ${hh}:${mm}`;
        if (dayDiff < 7) return `${dayDiff} 天前 ${hh}:${mm}`;
        return null; // 太久不展示绝对时间，避免冗余
      })()
    : null;

  return {
    nowMs: now,
    nowIso,
    weekday,
    timeOfDay,
    lastUserAt,
    lastUserLabel,
    lastUserAbsolute,
    hoursSinceLastUser,
    isNewSession,
  };
}

module.exports = {
  getTemporalSnapshot,
  NEW_SESSION_GAP_MS,
  // 暴露给测试
  _timeBucket,
  _relativeLabel,
};
