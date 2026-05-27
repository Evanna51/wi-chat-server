/**
 * Character name placeholder helpers — 让 memory_facts 等持久层与具体角色名解耦。
 *
 * 设计动机：assistant_profile.character_name 可能被改名（用户编辑 / 角色重置）。
 * 如果 fact_value 里硬编码角色名，改名时所有历史 fact 仍然是旧名 — 要么数据失真，
 * 要么必须跑迁移脚本。
 *
 * 方案：所有指向角色的字段在**存储层用 `{角色}` 占位符**，**读出时按当前 character_name
 * 展开**。改名 = 改 assistant_profile 一个字段，零迁移。
 *
 * 两个纯函数：
 *   - normalizeToPlaceholder(text, characterName)：写入前调用，把 AI/助手/bot/角色名 → `{角色}`
 *   - expandPlaceholder(text, characterName)：读出前调用，把 `{角色}` → 当前 character_name
 *
 * 两端都对空 / null / 缺名兜底，调用方不用判断。
 */

const PLACEHOLDER = "{角色}";

// regex 转义（characterName 可能含 . * + ? 等特殊字符）
function _escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 写入前：把通用 AI 代称 + 当前角色名 → 占位符。
 * LLM 输出 fact_value 时哪怕没听 prompt 用了真名 / "AI" / "助手"，这里兜底标准化成 `{角色}`。
 *
 * 输入 "用户握过金宵的手"（角色名=金宵）→ 输出 "用户握过{角色}的手"
 * 输入 "用户喜欢 AI 的声音" → 输出 "用户喜欢{角色}的声音"
 */
function normalizeToPlaceholder(text, characterName) {
  if (!text) return text;
  let t = String(text)
    .replace(/\bAI\b/g, PLACEHOLDER)
    .replace(/\bassistant\b/gi, PLACEHOLDER)
    .replace(/\bbot\b/gi, PLACEHOLDER)
    .replace(/助手/g, PLACEHOLDER);
  const name = (characterName || "").trim();
  if (name && name.length >= 2) {
    // 名字 ≥ 2 字符才替换。1 字符名字（罕见）容易误杀，跳过更安全。
    t = t.replace(new RegExp(_escapeRe(name), "g"), PLACEHOLDER);
  }
  return t;
}

/**
 * 读出前：把占位符 → 当前 character_name。
 * 缺 characterName 时**保留**占位符（让上层看到 `{角色}` 字面值即知道这是没展开的数据，
 * 不要回退成 "（未知）" 这种二次幻觉触发源）。
 */
function expandPlaceholder(text, characterName) {
  if (!text) return text;
  const name = (characterName || "").trim();
  if (!name) return text;
  return String(text).replace(/\{角色\}/g, name);
}

module.exports = {
  PLACEHOLDER,
  normalizeToPlaceholder,
  expandPlaceholder,
};
