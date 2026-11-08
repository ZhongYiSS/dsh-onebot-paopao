/**
 * 本鱼补丁（2026-11-08）：会话可自选——校验用户手填的 session id。
 * 只做纯校验（不带任何依赖），registry 与单测共用同一份规则。
 *
 * 合法形状：`session-` + 至少 4 位字母数字/短横线，整串不许有空白。
 * 例：`session-75338a0e-ff8d-4d26-9fb2-8c7dfb67dcfe`
 */

const PIN_RE = /^session-[0-9A-Za-z][0-9A-Za-z-]{3,}$/

/** @param {unknown} raw 用户填的会话 id
 * @returns {string|undefined} 不合格时返回给人看的中文原因 */
export function validatePinSessionId(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return '没填会话 id'
  if (/\s/.test(text)) return '会话 id 里不该有空格'
  if (!PIN_RE.test(text)) return '会话 id 应形如 session-75338a0e-… （整串照抄，别只写后半段）'
  if (text.length > 200) return '会话 id 太长了'
  return undefined
}

/** 给界面用的短名：`session-75338a0e-ff8d-…` → `75338a0e`。 */
export function shortPinId(sessionId) {
  const text = typeof sessionId === 'string' ? sessionId : ''
  return text.startsWith('session-') ? text.slice(8, 16) : text.slice(0, 8)
}
