/**
 * 本鱼补丁（2026-11-08）：会话可自选——校验用户手填的 session id。
 * 只做纯校验（不带任何依赖），registry 与单测共用同一份规则。
 *
 * 两种都收：
 *   - `session-75338a0e-ff8d-4d26-9fb2-8c7dfb67dcfe`（GUI 那种）
 *   - `onebot-group-123456789`（插件早期按 QQ 号起的名字，没有 session- 前缀）
 * 规则：可选 `session-` 前缀 + 至少 8 位字母数字/短横线，整串不许有空白。
 */

const PIN_RE = /^(?:session-)?[0-9A-Za-z][0-9A-Za-z-]{7,}$/

/** @param {unknown} raw 用户填的会话 id
 * @returns {string|undefined} 不合格时返回给人看的中文原因 */
export function validatePinSessionId(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return '没填会话 id'
  if (/\s/.test(text)) return '会话 id 里不该有空格'
  // 「session-」后面还得有真正的一段：防止把 `session-ab` 这种半截当合法裸 id
  if (text.startsWith('session-') && text.length < 16) return '会话 id 形如 session-75338a0e-… 或 onebot-private-123456789（整串照抄，别只写后半段）'
  if (!PIN_RE.test(text)) return '会话 id 形如 session-75338a0e-… 或 onebot-private-123456789（整串照抄，别只写后半段）'
  if (text.length > 200) return '会话 id 太长了'
  return undefined
}

/** 给界面用的短名：`session-75338a0e-ff8d-…` → `75338a0e`；`onebot-…` 原样给前 8 位。 */
export function shortPinId(sessionId) {
  const text = typeof sessionId === 'string' ? sessionId : ''
  return text.startsWith('session-') ? text.slice(8, 16) : text.slice(0, 12)
}
