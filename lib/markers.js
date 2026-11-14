/**
 * 会话写在正文里的「机制标记」——一份正则，两处共用。
 * ============================================================================
 * 为什么单开一个文件（2026-11-14 审计发现的真 bug）：
 *   解析在陪伴侧（`lib/companion/prompt.mjs` 的 `readLater`，认 `[LATER 30分钟]`），
 *   闸门和剥离在 QQ 侧（`lib/bridge.js`，只认 `[LATER 30m]`）——
 *   于是模型按中文习惯写「分钟」时：**不排队，而且标记原样印进聊天框**。
 *   现在解析 / 闸门 / 剥离都用这里的一份正则，改一处就是改三处。
 *
 * 规矩：这里的正则一律「每次现造」，不要导出带 /g 的常量拿去复用
 * （`lastIndex` 会在调用之间残留）。
 * ============================================================================
 */

/** `[LATER 25]` `[LATER 25m]` `[LATER 90s]` `[LATER 30分钟]` `[LATER 15秒]` */
export const LATER_SRC = '\\[LATER\\s+([0-9]{1,4})\\s*(m|s|分钟|秒)?\\]'

/**
 * `[AT 23:30]` —— 11-09 哥哥砍掉了这种写法（只说分钟）。
 * 现在**不认、也不排队**，但要能剥掉：模型偶尔还是会写，不能让它漏到聊天框。
 */
export const AT_SRC = '\\[AT\\s*([0-9]{1,2}:[0-9]{2})\\]'

/** `[SCORE n]` —— 她给这一轮打的分 */
export const SCORE_SRC = '\\[SCORE\\s*([0-9]{1,3})\\]'

/** `[HOLD]` / `[SKIP]`（SKIP 已废，只作兼容剥离） */
export const HOLD_SRC = '\\[(HOLD|SKIP)\\]'

/** 这段正文里有没有 `[LATER …]`（任何写法） */
export function hasLater(text) {
  return new RegExp(LATER_SRC, 'i').test(String(text || ''))
}

/** 取出 `[LATER …]` 的数字与单位；没有返回 null */
export function matchLater(text) {
  return new RegExp(LATER_SRC, 'i').exec(String(text || ''))
}

/** 取出 `[SCORE n]` 的 n；没有返回 null */
export function matchScore(text) {
  const m = new RegExp(SCORE_SRC, 'i').exec(String(text || ''))
  return m ? m[1] : null
}

/**
 * 把机制标记从正文里剥干净（发出去的内容不该带它们）。
 * 只剥标记本身，正文里的方块括号一律不动。
 */
export function stripMarkers(text) {
  return String(text || '')
    .replace(new RegExp(HOLD_SRC, 'gi'), '')
    .replace(new RegExp(LATER_SRC, 'gi'), '')
    .replace(new RegExp(AT_SRC, 'gi'), '')
    .replace(new RegExp(SCORE_SRC, 'gi'), '')
    .trim()
}
